import { Texture, type Device } from "@luma.gl/core";
import type { TileFeatureId } from "../../shared/appstate.service";
import { sipHash64Hex } from "../../styledata/hash";
import {
  GpuRenderPacketView,
  type GpuLabelRecordView,
  type GpuPickRecordView,
  type GpuRetainedPickTable,
  type GpuRuntimeIssueView,
  type GpuZIndexEntryView,
} from "./gpu-render-packet";
import {
  GpuPrimitiveStore,
  type GpuPrimitiveStoreSnapshot,
} from "./gpu-primitive-store";
import { GpuRangeAllocator, type GpuRecordRange } from "./gpu-range-allocator";

const LOOKUP_TEXTURE_WIDTH = 1024;
const MAX_PICKING_INDEX = 0x00ff_fffe;
const MAX_ACTIVATION_TOKEN = 0x00ff_ffff;
// Keep adjacent semantic depth slots farther apart than one 24-bit depth-buffer
// unit. The former 0.001 budget collapsed dense BMD ranks at distant cameras.
const MAX_CLIP_SPACE_BIAS = 0.005;
const TARGET_DEPTH_STEPS = 1024;
// Keep synchronized with kGpuDepthTieBucketCount: packets retain exactly the
// hash bits consumed by this power-of-two allocator.
const MAX_TIE_BUCKETS = 32;
/** Depth interval reserved for each semantic primitive pass. */
export const GPU_SCENE_PRIMITIVE_DEPTH_BIAS_STEP =
  MAX_CLIP_SPACE_BIAS / 5;
const MAX_LOCAL_CLIP_SPACE_BIAS =
  GPU_SCENE_PRIMITIVE_DEPTH_BIAS_STEP * 0.8;

interface DepthRankAllocation {
  firstSlot: number;
  tieBucketCount: number;
}

/**
 * Assign depth slots only to authored ranks which actually contain semantic ties.
 *
 * A global tie lattice wastes the same number of slots on every unique z-index.
 * Dense Classic styles then exhaust the safe depth budget before repeated ranks
 * receive even a second slot. Power-of-two per-rank buckets retain the hash's
 * spatial low-bit distribution while spending the remaining budget on the most
 * heavily contended ranks first.
 */
function allocateDepthRanks(
  orderedZIndices: readonly number[],
  tieBreakersByZIndex: ReadonlyMap<number, ReadonlySet<number>>,
): {allocations: Map<number, DepthRankAllocation>; slotCount: number} {
  const bucketCounts = new Map<number, number>(
    orderedZIndices.map((value) => [value, 1]),
  );
  let slotCount = Math.max(1, orderedZIndices.length);
  if (slotCount < TARGET_DEPTH_STEPS) {
    const candidates = orderedZIndices
      .map((value, rank) => ({
        value,
        rank,
        tieCount: tieBreakersByZIndex.get(value)?.size ?? 0,
      }))
      .filter(({tieCount}) => tieCount > 1);
    for (let nextBucketCount = 2;
      nextBucketCount <= MAX_TIE_BUCKETS;
      nextBucketCount *= 2) {
      candidates.sort((left, right) =>
        right.tieCount - left.tieCount || left.rank - right.rank,
      );
      for (const candidate of candidates) {
        const currentBucketCount = bucketCounts.get(candidate.value)!;
        if (currentBucketCount * 2 !== nextBucketCount
          || candidate.tieCount <= currentBucketCount
          || slotCount + currentBucketCount > TARGET_DEPTH_STEPS) {
          continue;
        }
        bucketCounts.set(candidate.value, nextBucketCount);
        slotCount += currentBucketCount;
      }
    }
  }

  const allocations = new Map<number, DepthRankAllocation>();
  let firstSlot = 0;
  for (const value of orderedZIndices) {
    const tieBucketCount = bucketCounts.get(value)!;
    allocations.set(value, {firstSlot, tieBucketCount});
    firstSlot += tieBucketCount;
  }
  return {allocations, slotCount: Math.max(1, firstSlot)};
}

interface OriginEntry {
  identity: string;
  key: bigint;
  slot: number;
  position: [number, number, number];
  inFlightReferences: number;
  activeReferences: number;
}

interface ContributionEntry {
  identity: string;
  key: bigint;
  nextRevision: number;
  expectedRevision: number;
  inFlightReferences: number;
  desired: boolean;
  active: InstalledContribution | null;
}

interface InstalledSpan {
  store: GpuPrimitiveStore;
  range: GpuRecordRange;
}

interface InstalledContribution {
  identity: string;
  revision: number;
  contributionSlot: number;
  activationToken: number;
  mapTileKey: string;
  styleOrder: number;
  origin: OriginEntry;
  spans: InstalledSpan[];
  pickingRange: GpuRecordRange | null;
  zIndexRange: GpuRecordRange | null;
  zIndices: GpuZIndexEntryView[];
  labels: GpuSceneLabel[];
  pickTables: GpuRetainedPickTable[];
  resolvedPickIndices: number[];
  resolvePick: GpuScenePickResolver;
  findPickReferences: GpuScenePickFinder;
}

interface StagedContribution {
  entry: ContributionEntry;
  reserved: ReservedContribution;
  installed: InstalledContribution;
  totalPickCount: number;
  pickCount: number;
  labels: GpuLabelRecordView[];
}

interface StagedRender {
  fragmentCount: number;
  nextFragmentIndex: number;
  seenContributionKeys: Set<bigint>;
  contributions: Map<bigint, StagedContribution>;
  issues: GpuRuntimeIssueView[];
  resourceRequests: GpuRenderPacketView["resourceRequests"];
}

interface ReservedContribution {
  identity: string;
  key: bigint;
  slot: number;
  activationToken: number;
  revision: number;
  mapTileKey: string;
  styleOrder: number;
  resolvePick: GpuScenePickResolver;
  findPickReferences: GpuScenePickFinder;
  installed: boolean;
}

/** Worker-task reservation that fixes packet slots and revisions before C++ runs. */
export interface GpuSceneRenderReservation {
  sceneGeneration: number;
  packetSequence: number;
  origin: {
    identity: string;
    key: bigint;
    slot: number;
    position: [number, number, number];
  };
  contributions: ReservedContribution[];
  released: boolean;
}

/** One independently replaceable subset/style input prepared for a render task. */
export interface GpuSceneContributionInput {
  identity: string;
  mapTileKey: string;
  styleOrder: number;
  resolvePick?: GpuScenePickResolver;
  findPickReferences?: GpuScenePickFinder;
}

/** Stable source-row identity transported instead of eagerly formatted feature ids. */
export interface GpuScenePickReference {
  channelOrdinal: number;
  entryOrdinal: number;
  endpointRole: number;
}

/** Resolve one picked source row against the exact immutable subset which produced it. */
export type GpuScenePickResolver = (
  reference: GpuScenePickReference,
) => string | readonly string[] | undefined;

/** Find source rows corresponding to one persisted semantic inspection target. */
export type GpuScenePickFinder = (
  targetFeatureId: string,
) => readonly GpuScenePickReference[];

const NO_RESOLVED_PICK: GpuScenePickResolver = () => undefined;
const NO_PICK_REFERENCES: GpuScenePickFinder = () => [];

/** Deck text datum retained outside the direct vector-buffer upload path. */
export interface GpuSceneLabel extends GpuLabelRecordView {
  globalPickIndex: number | null;
  styleOrder: number;
}

/** Small result returned after atomically installing a validated packet. */
export interface GpuSceneApplyResult {
  appliedContributions: number;
  labelsChanged: boolean;
  issues: GpuRuntimeIssueView[];
  resourceRequests: GpuRenderPacketView["resourceRequests"];
}

/** Renderer diagnostics whose cardinality is independent of source geometry. */
export interface GpuSceneSnapshot {
  generation: number;
  revision: number;
  materialCount: number;
  activeContributionCount: number;
  activeOriginCount: number;
  pickingHighWater: number;
  pickingFragmentation: number;
  zIndexHighWater: number;
  zIndexUpdateMs: number;
  labels: number;
  stores: GpuPrimitiveStoreSnapshot[];
}

/** One persistent primitive/material buffer consumed by the vector layer. */
export interface GpuSceneMaterialStore {
  kind: number;
  flags: number;
  styleOrder: number;
  renderOrder: number;
  glowColor: [number, number, number, number];
  glowRadius: number;
  atlasPage: number;
  store: GpuPrimitiveStore;
}

/** One exact semantic scene object selected for a transient GPU mask. */
export interface GpuSceneInteractionPick {
  globalPickIndex: number;
  identityKey: string;
}

/** Semantic metadata associated with one Deck-compatible scene object index. */
interface ScenePickRecord {
  contributionIdentity: string;
  mapTileKey: string;
  featureIds: string | readonly string[];
  navigationAltitude?: number;
}

interface OwnedPackedPick {
  installed: InstalledContribution;
  record: GpuPickRecordView;
}

type ScenePickIndices = number | Set<number>;

interface FloatLookupUpdate {
  firstSlot: number;
  values: ArrayLike<number>;
}

interface PreparedFloatLookupReplacement {
  /** Publish the prepared texture into the staging generation. */
  commit(): void;
  /** Destroy an unpublished allocation after another preparation failed. */
  discard(): void;
}

interface PreparedSceneOrder {
  contribution: PreparedFloatLookupReplacement;
  zIndex: PreparedFloatLookupReplacement;
}

/**
 * Small CPU mirror for a float lookup texture addressed by compact scene slots.
 *
 * Origin, contribution, and exact-order tables are the only retained numeric
 * mirrors. Their size scales with active contributions/origins, never vertices.
 */
class FloatLookupTable {
  private capacitySlots = 0;
  private values = new Float32Array();
  private gpuTexture: Texture | null = null;
  private renderTexture: Texture | null = null;
  private readonly retiredTextures: Texture[] = [];
  private _revision = 0;

  /** Create a lazily allocated lookup with a fixed texel layout per scene slot. */
  constructor(
    private readonly device: Device,
    private readonly id: string,
    readonly texelsPerSlot: number,
  ) {}

  /** Replace one slot and upload only its tightly packed texels when possible. */
  set(slot: number, values: readonly number[]): void {
    if (values.length !== this.texelsPerSlot * 4) {
      throw new Error(`Lookup slot '${this.id}' has an invalid value count.`);
    }
    this.setRange(slot, values);
  }

  /** Replace contiguous slots with bounded row-wise texture uploads. */
  setRange(firstSlot: number, values: ArrayLike<number>): void {
    const valuesPerSlot = this.texelsPerSlot * 4;
    if (values.length % valuesPerSlot !== 0) {
      throw new Error(`Lookup range '${this.id}' has an invalid value count.`);
    }
    const slotCount = values.length / valuesPerSlot;
    if (slotCount === 0) {
      return;
    }
    const source = values instanceof Float32Array
      ? values
      : Float32Array.from(values);
    this.ensureCapacity(firstSlot + slotCount);
    const valueOffset = firstSlot * valuesPerSlot;
    let texelOffset = firstSlot * this.texelsPerSlot;
    let remainingTexels = slotCount * this.texelsPerSlot;
    let sourceValue = 0;
    while (remainingTexels > 0) {
      const x = texelOffset % LOOKUP_TEXTURE_WIDTH;
      const y = Math.floor(texelOffset / LOOKUP_TEXTURE_WIDTH);
      const width = Math.min(remainingTexels, LOOKUP_TEXTURE_WIDTH - x);
      this.gpuTexture!.writeData(
        source.subarray(sourceValue, sourceValue + width * 4),
        { x, y, width, height: 1 },
      );
      texelOffset += width;
      sourceValue += width * 4;
      remainingTexels -= width;
    }
    this.values.set(source, valueOffset);
    this._revision += 1;
  }

  /**
   * Prepare a complete replacement without mutating the visible lookup.
   *
   * Presentation changes use this path to upload the next lookup generation
   * before retiring the texture still referenced by Deck's current models.
   */
  prepareReplacement(
    updates: readonly FloatLookupUpdate[],
  ): PreparedFloatLookupReplacement {
    if (!updates.length) {
      return {
        commit: () => {},
        discard: () => {},
      };
    }
    const valuesPerSlot = this.texelsPerSlot * 4;
    let requiredSlots = this.capacitySlots;
    const normalized = updates.map(({ firstSlot, values }) => {
      if (!Number.isSafeInteger(firstSlot) || firstSlot < 0) {
        throw new Error(`Lookup range '${this.id}' has an invalid first slot.`);
      }
      if (values.length % valuesPerSlot !== 0) {
        throw new Error(`Lookup range '${this.id}' has an invalid value count.`);
      }
      const source = values instanceof Float32Array
        ? values
        : Float32Array.from(values);
      requiredSlots = Math.max(
        requiredSlots,
        firstSlot + source.length / valuesPerSlot,
      );
      return { firstSlot, source };
    });
    const requiredTexels = requiredSlots * this.texelsPerSlot;
    let height = Math.max(1, this.gpuTexture?.height ?? 1);
    while (height * LOOKUP_TEXTURE_WIDTH < requiredTexels) {
      height *= 2;
    }
    const nextValues = new Float32Array(height * LOOKUP_TEXTURE_WIDTH * 4);
    nextValues.set(this.values);
    for (const { firstSlot, source } of normalized) {
      nextValues.set(source, firstSlot * valuesPerSlot);
    }
    const nextTexture = this.device.createTexture({
      id: this.id,
      dimension: "2d",
      format: "rgba32float",
      width: LOOKUP_TEXTURE_WIDTH,
      height,
      usage: Texture.SAMPLE | Texture.COPY_DST,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    try {
      nextTexture.writeData(nextValues, {
        width: LOOKUP_TEXTURE_WIDTH,
        height,
      });
    } catch (error) {
      nextTexture.destroy();
      throw error;
    }
    let settled = false;
    return {
      commit: () => {
        if (settled) {
          throw new Error(`Lookup replacement '${this.id}' is already settled.`);
        }
        settled = true;
        const previous = this.gpuTexture;
        this.gpuTexture = nextTexture;
        this.values = nextValues;
        this.capacitySlots = Math.floor(
          (height * LOOKUP_TEXTURE_WIDTH) / this.texelsPerSlot,
        );
        this._revision += 1;
        this.retireOrDestroy(previous);
      },
      discard: () => {
        if (!settled) {
          settled = true;
          nextTexture.destroy();
        }
      },
    };
  }

  /** Mark a recycled slot inactive while preserving the texture allocation. */
  clear(slot: number): void {
    if (slot >= this.capacitySlots) {
      return;
    }
    this.set(slot, new Array(this.texelsPerSlot * 4).fill(0));
  }

  /** Destroy the context-owned texture and all small CPU lookup state. */
  destroy(): void {
    const textures = new Set<Texture>();
    if (this.gpuTexture) {
      textures.add(this.gpuTexture);
    }
    if (this.renderTexture) {
      textures.add(this.renderTexture);
    }
    this.retiredTextures.forEach(texture => textures.add(texture));
    textures.forEach(texture => texture.destroy());
    this.gpuTexture = null;
    this.renderTexture = null;
    this.retiredTextures.length = 0;
    this.values = new Float32Array();
    this.capacitySlots = 0;
    this._revision += 1;
  }

  get texture(): Texture | null {
    return this.renderTexture;
  }

  get revision(): number {
    return this._revision;
  }

  /** Publish the latest staging allocation without invalidating the displayed one. */
  publish(): void {
    this.renderTexture = this.gpuTexture;
  }

  /** Destroy allocations after every model has rebound to the published lookup. */
  releaseRetiredTextures(): void {
    this.retiredTextures.forEach(texture => texture.destroy());
    this.retiredTextures.length = 0;
  }

  /** Geometrically grow a two-dimensional table and upload its compact mirror. */
  private ensureCapacity(requiredSlots: number): void {
    if (requiredSlots <= this.capacitySlots) {
      return;
    }
    const requiredTexels = requiredSlots * this.texelsPerSlot;
    let height = Math.max(1, this.gpuTexture?.height ?? 1);
    while (height * LOOKUP_TEXTURE_WIDTH < requiredTexels) {
      height *= 2;
    }
    const nextValues = new Float32Array(height * LOOKUP_TEXTURE_WIDTH * 4);
    nextValues.set(this.values);
    const nextTexture = this.device.createTexture({
      id: this.id,
      dimension: "2d",
      format: "rgba32float",
      width: LOOKUP_TEXTURE_WIDTH,
      height,
      usage: Texture.SAMPLE | Texture.COPY_DST,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    try {
      nextTexture.writeData(nextValues, {
        width: LOOKUP_TEXTURE_WIDTH,
        height,
      });
    } catch (error) {
      nextTexture.destroy();
      throw error;
    }
    this.retireOrDestroy(this.gpuTexture);
    this.gpuTexture = nextTexture;
    this.values = nextValues;
    this.capacitySlots = Math.floor(
      (height * LOOKUP_TEXTURE_WIDTH) / this.texelsPerSlot,
    );
    this._revision += 1;
  }

  /** Keep only a texture visible to the current presentation alive until rebinding. */
  private retireOrDestroy(texture: Texture | null): void {
    if (!texture) {
      return;
    }
    if (texture === this.renderTexture) {
      this.retiredTextures.push(texture);
    } else {
      texture.destroy();
    }
  }
}

/**
 * Persistent per-view GPU scene shared by every ordinary styled mapget layer.
 *
 * It validates worker packets, performs bulk stream uploads, and atomically
 * replaces contribution ownership. It never walks primitive records or keeps
 * a CPU geometry mirror; only compact origin, picking, and text metadata stay
 * on the main thread.
 */
export class GpuScene {
  private static nextGeneration = 0;

  readonly generation = ++GpuScene.nextGeneration;
  private readonly storesByMaterial = new Map<bigint, GpuPrimitiveStore>();
  private readonly streamLayoutByMaterial = new Map<
    bigint,
    {
      kind: number;
      flags: number;
      styleOrder: number;
      renderOrder: number;
      stride: number;
      glowColor: [number, number, number, number];
      glowRadius: number;
      atlasPage: number;
    }
  >();
  private readonly originsByIdentity = new Map<string, OriginEntry>();
  private readonly originsByKey = new Map<bigint, OriginEntry>();
  private readonly contributionByIdentity = new Map<
    string,
    ContributionEntry
  >();
  private readonly contributionByKey = new Map<bigint, ContributionEntry>();
  private readonly originSlots = new GpuRangeAllocator();
  private readonly contributionSlots = new GpuRangeAllocator();
  private readonly pickingRanges = new GpuRangeAllocator();
  private readonly zIndexRanges = new GpuRangeAllocator();
  private pickOwnerSlots = new Uint32Array();
  private readonly activeContributionBySlot = new Map<
    number,
    InstalledContribution
  >();
  // Only picks touched by interaction become JavaScript objects and strings.
  private readonly picks = new Map<number, ScenePickRecord>();
  private readonly pickIndicesByTileAndFeature = new Map<
    string,
    Map<string, ScenePickIndices>
  >();
  private readonly originLookup: FloatLookupTable;
  private readonly contributionLookup: FloatLookupTable;
  private readonly zIndexLookup: FloatLookupTable;
  private readonly stagedRenderByReservation = new WeakMap<
    GpuSceneRenderReservation,
    StagedRender
  >();
  private readonly presentationReleases: InstalledContribution[] = [];
  private packetSequence = 0;
  private nextActivationToken = 0;
  private _revision = 0;
  private _presentationRevision = 0;
  private labelCount = 0;
  private lastZIndexUpdateMs = 0;
  private destroyed = false;

  /** Own all persistent vector buffers and semantic lookup tables for one view. */
  constructor(
    private readonly device: Device,
    private readonly requestRedraw: (reason: string) => void,
  ) {
    this.originLookup = new FloatLookupTable(
      device,
      "erdblick-gpu-origin-table",
      2,
    );
    this.contributionLookup = new FloatLookupTable(
      device,
      "erdblick-gpu-contribution-table",
      1,
    );
    this.zIndexLookup = new FloatLookupTable(
      device,
      "erdblick-gpu-z-index-table",
      1,
    );
  }

  /**
   * Reserve one stable origin and isolated revision slots before worker dispatch.
   * The revisions make superseded packets rejectable before any GPU upload.
   */
  prepareRender(
    originIdentity: string,
    originPosition: [number, number, number],
    inputs: readonly GpuSceneContributionInput[],
  ): GpuSceneRenderReservation {
    this.ensureAlive();
    if (inputs.length !== 1) {
      throw new Error("A GPU render reservation must own exactly one contribution.");
    }
    if (inputs.some((input) =>
      !Number.isSafeInteger(input.styleOrder) ||
      input.styleOrder < 0 ||
      input.styleOrder > 0xffff_ffff
    )) {
      throw new Error("GPU scene style order is outside its uint32 range.");
    }
    const origin = this.reserveOrigin(originIdentity, originPosition);
    origin.inFlightReferences += 1;
    const contributions: ReservedContribution[] = [];
    const previousStates: Array<{
      entry: ContributionEntry;
      nextRevision: number;
      expectedRevision: number;
      desired: boolean;
    }> = [];
    try {
      for (const input of inputs) {
        const entry = this.reserveContribution(input.identity);
        let slotRange: GpuRecordRange | null = null;
        let activationToken: number;
        try {
          slotRange = this.contributionSlots.allocate(1);
          activationToken = this.allocateActivationToken();
        } catch (error) {
          if (slotRange) {
            this.contributionSlots.release(slotRange);
          }
          this.releaseContributionIfUnused(entry);
          throw error;
        }
        const slot = slotRange.firstRecord;
        previousStates.push({
          entry,
          nextRevision: entry.nextRevision,
          expectedRevision: entry.expectedRevision,
          desired: entry.desired,
        });
        entry.inFlightReferences += 1;
        entry.desired = true;
        entry.expectedRevision = ++entry.nextRevision;
        contributions.push({
          identity: entry.identity,
          key: entry.key,
          slot,
          activationToken,
          revision: entry.expectedRevision,
          mapTileKey: input.mapTileKey,
          styleOrder: input.styleOrder,
          resolvePick: input.resolvePick ?? NO_RESOLVED_PICK,
          findPickReferences: input.findPickReferences ?? NO_PICK_REFERENCES,
          installed: false,
        });
      }
    } catch (error) {
      for (let index = 0; index < contributions.length; ++index) {
        const reserved = contributions[index];
        const previous = previousStates[index];
        this.contributionSlots.release({
          firstRecord: reserved.slot,
          recordCount: 1,
        });
        previous.entry.inFlightReferences = Math.max(
          0,
          previous.entry.inFlightReferences - 1,
        );
        previous.entry.nextRevision = previous.nextRevision;
        previous.entry.expectedRevision = previous.expectedRevision;
        previous.entry.desired = previous.desired;
        this.releaseContributionIfUnused(previous.entry);
      }
      origin.inFlightReferences = Math.max(0, origin.inFlightReferences - 1);
      this.releaseOriginIfUnused(origin);
      throw error;
    }
    return {
      sceneGeneration: this.generation,
      packetSequence: ++this.packetSequence,
      origin: {
        identity: origin.identity,
        key: origin.key,
        slot: origin.slot,
        position: origin.position,
      },
      contributions,
      released: false,
    };
  }

  /**
   * Stage one bounded packet fragment and atomically publish its revision only
   * after the explicit final fragment supplies complete semantic metadata.
   */
  applyPacket(
    bytes: Uint8Array,
    reservation: GpuSceneRenderReservation,
  ): GpuSceneApplyResult | null {
    this.ensureAlive();
    const packet = new GpuRenderPacketView(bytes);
    this.validatePacketContext(packet, reservation);
    let staged = this.stagedRenderByReservation.get(reservation);
    if (!staged) {
      if (packet.fragmentIndex !== 0) {
        throw new Error("GPU render revision starts with a nonzero fragment.");
      }
      staged = {
        fragmentCount: packet.fragmentCount,
        nextFragmentIndex: 0,
        seenContributionKeys: new Set<bigint>(),
        contributions: new Map<bigint, StagedContribution>(),
        issues: [],
        resourceRequests: [],
      };
      this.stagedRenderByReservation.set(reservation, staged);
    }
    if (
      packet.fragmentCount !== staged.fragmentCount ||
      packet.fragmentIndex !== staged.nextFragmentIndex
    ) {
      this.abortStagedRender(reservation, staged);
      throw new Error("GPU render packet fragments are missing or out of order.");
    }
    const reservedByKey = new Map(
      reservation.contributions.map((item) => [item.key, item]),
    );
    try {
      for (
        let contributionIndex = 0;
        contributionIndex < packet.contributions.length;
        ++contributionIndex
      ) {
        const descriptor = packet.contributions[contributionIndex];
        const reserved = reservedByKey.get(descriptor.key);
        const entry = this.contributionByKey.get(descriptor.key);
        if (
          !reserved ||
          !entry ||
          descriptor.slot !== reserved.slot ||
          descriptor.activationToken !== reserved.activationToken ||
          descriptor.revision !== reserved.revision
        ) {
          throw new Error(
            "GPU packet contribution does not match its reservation.",
          );
        }
        staged.seenContributionKeys.add(descriptor.key);
        if (!entry.desired || entry.expectedRevision !== descriptor.revision) {
          continue;
        }
        let item = staged.contributions.get(descriptor.key);
        if (!item) {
          const origin = this.originsByKey.get(packet.origin.key);
          if (!origin) {
            throw new Error(
              "GPU packet references an origin which is no longer reserved.",
            );
          }
          item = {
            entry,
            reserved,
            installed: {
              identity: entry.identity,
              revision: descriptor.revision,
              contributionSlot: descriptor.slot,
              activationToken: descriptor.activationToken,
              mapTileKey: reserved.mapTileKey,
              styleOrder: reserved.styleOrder,
              origin,
              spans: [],
              pickingRange: null,
              zIndexRange: null,
              zIndices: [],
              labels: [],
              pickTables: [],
              resolvedPickIndices: [],
              resolvePick: reserved.resolvePick,
              findPickReferences: reserved.findPickReferences,
            },
            totalPickCount: descriptor.totalPickCount,
            pickCount: 0,
            labels: [],
          };
          staged.contributions.set(descriptor.key, item);
        } else if (item.totalPickCount !== descriptor.totalPickCount) {
          throw new Error(
            "GPU render fragments disagree about their picking cardinality.",
          );
        }
        for (const span of descriptor.spans) {
          const stream = packet.streams[span.streamIndex];
          const store = this.storeFor(stream, reserved.styleOrder);
          const previousBufferRevision = store.bufferRevision;
          const range = store.allocate(span.recordCount);
          if (store.bufferRevision !== previousBufferRevision) {
            // Growing a shared store replaces its luma buffer before this
            // fragment becomes active. Advance the presentation generation so
            // existing models rebind on the next draw; activation remains
            // guarded by the contribution token until the final fragment.
            this._revision += 1;
            this.requestRedraw("GPU material buffer replaced");
          }
          item.installed.spans.push({ store, range });
          const firstByte = span.firstRecord * stream.recordStride;
          store.write(
            range,
            stream.records.subarray(
              firstByte,
              firstByte + span.recordCount * stream.recordStride,
            ),
          );
        }
        if (descriptor.zIndices.length) {
          if (
            item.installed.zIndices.length &&
            (item.installed.zIndices.length !== descriptor.zIndices.length ||
              item.installed.zIndices.some(
                (entry, index) =>
                  entry.value !== descriptor.zIndices[index].value ||
                  entry.tieBreaker !== descriptor.zIndices[index].tieBreaker,
              ))
          ) {
            throw new Error("GPU render fragments disagree about z-index data.");
          }
          item.installed.zIndices = [...descriptor.zIndices];
        }
        if (descriptor.pickCount > 0) {
          const picks = packet.picks.retainRange(
            descriptor.firstPick,
            descriptor.pickCount,
          );
          if (picks.firstLocalPickIndex !== item.pickCount) {
            throw new Error(
              "GPU render fragments contain a picking gap or overlap.",
            );
          }
          item.installed.pickTables.push(picks);
          item.pickCount += picks.count;
        }
        for (
          let index = descriptor.firstLabel;
          index < descriptor.firstLabel + descriptor.labelCount;
          ++index
        ) {
          item.labels.push(packet.labels[index]);
        }
      }
      staged.issues.push(...packet.issues);
      staged.resourceRequests.push(...packet.resourceRequests);
      staged.nextFragmentIndex += 1;
      if (!packet.revisionComplete) {
        return null;
      }
      if (
        staged.nextFragmentIndex !== staged.fragmentCount ||
        reservation.contributions.some(
          (item) => !staged.seenContributionKeys.has(item.key),
        )
      ) {
        throw new Error(
          "GPU render revision completed without every reserved contribution.",
        );
      }

      for (const [key, item] of staged.contributions) {
        if (
          !item.entry.desired ||
          item.entry.expectedRevision !== item.installed.revision
        ) {
          this.discardStaged(item.installed);
          staged.contributions.delete(key);
        }
      }
      const ready = [...staged.contributions.values()];
      for (const item of ready) {
        if (item.pickCount !== item.totalPickCount) {
          throw new Error(
            "GPU render revision completed with incomplete picking metadata.",
          );
        }
        item.installed.pickingRange = item.totalPickCount > 0
          ? this.allocatePickingRange(item.totalPickCount)
          : null;
        item.installed.zIndexRange = item.installed.zIndices.length
          ? this.zIndexRanges.allocate(item.installed.zIndices.length)
          : null;
        item.installed.labels = item.labels.map((label) => ({
          ...label,
          styleOrder: item.reserved.styleOrder,
          globalPickIndex:
            item.installed.pickingRange &&
            label.localPickIndex < item.installed.pickingRange.recordCount
              ? item.installed.pickingRange.firstRecord + label.localPickIndex
              : null,
        }));
      }
      if (ready.length) {
        this.updateZIndexLookup(ready);
      }

      let labelsChanged = false;
      for (const item of ready) {
        const previous = item.entry.active;
        if (previous) {
          // Keep the predecessor active until the same publication that raises
          // the model's draw bound to include its replacement. Clearing this
          // slot during admission would create a tile-shaped hole in unrelated
          // Deck frames that still draw the previous buffer generation.
          this.presentationReleases.push(previous);
        }
        item.reserved.installed = true;
        item.entry.active = item.installed;
        this.publishPickOwner(item.installed);
        item.installed.origin.activeReferences += 1;
        this.labelCount += item.installed.labels.length;
        if (previous) {
          labelsChanged ||=
            previous.labels.length > 0 || item.installed.labels.length > 0;
        } else {
          labelsChanged ||= item.installed.labels.length > 0;
        }
      }
      this.stagedRenderByReservation.delete(reservation);
      if (ready.length) {
        this.pruneEmptyStores();
        this._revision += 1;
        this.requestRedraw("GPU scene revision installed");
      }
      return {
        appliedContributions: ready.length,
        labelsChanged,
        issues: staged.issues,
        resourceRequests: staged.resourceRequests,
      };
    } catch (error) {
      this.abortStagedRender(reservation, staged);
      throw error;
    }
  }

  /** Test whether an asynchronous worker result still belongs to this scene. */
  accepts(reservation: GpuSceneRenderReservation): boolean {
    return !this.destroyed &&
      !reservation.released &&
      reservation.sceneGeneration === this.generation;
  }

  /** Release in-flight slot references after success, staleness, or failure. */
  finishRender(reservation: GpuSceneRenderReservation): void {
    if (reservation.released) {
      return;
    }
    const staged = this.stagedRenderByReservation.get(reservation);
    if (staged) {
      this.abortStagedRender(reservation, staged);
    }
    reservation.released = true;
    const origin = this.originsByKey.get(reservation.origin.key);
    if (origin) {
      origin.inFlightReferences = Math.max(0, origin.inFlightReferences - 1);
      this.releaseOriginIfUnused(origin);
    }
    for (const reserved of reservation.contributions) {
      if (!reserved.installed) {
        this.contributionLookup.clear(reserved.slot);
        this.contributionSlots.release({
          firstRecord: reserved.slot,
          recordCount: 1,
        });
      }
      const entry = this.contributionByKey.get(reserved.key);
      if (!entry) {
        continue;
      }
      entry.inFlightReferences = Math.max(0, entry.inFlightReferences - 1);
      this.releaseContributionIfUnused(entry);
    }
  }

  /**
   * Remove one producer's active ranges while allowing an in-flight task to
   * retire safely, and report whether the shared text snapshot changed.
   */
  removeContribution(identity: string): boolean {
    return this.removeContributions([identity]);
  }

  /** Remove many producers as one store-prune, revision, and redraw transaction. */
  removeContributions(identities: Iterable<string>): boolean {
    let labelsChanged = false;
    let sceneChanged = false;
    for (const identity of new Set(identities)) {
      const entry = this.contributionByIdentity.get(identity);
      if (!entry) {
        continue;
      }
      entry.desired = false;
      entry.expectedRevision = ++entry.nextRevision;
      if (entry.active) {
        labelsChanged ||= entry.active.labels.length > 0;
        this.presentationReleases.push(entry.active);
        entry.active = null;
        sceneChanged = true;
      }
      this.releaseContributionIfUnused(entry);
    }
    if (sceneChanged) {
      this.pruneEmptyStores();
      this._revision += 1;
      this.requestRedraw("GPU scene contributions removed");
    }
    return labelsChanged;
  }

  /** Resolve one Deck scene index into exact feature/validity/relation targets. */
  resolvePick(globalPickIndex: number): TileFeatureId[] {
    if (!Number.isInteger(globalPickIndex) || globalPickIndex < 0) {
      return [];
    }
    const selected = this.scenePick(globalPickIndex);
    if (!selected) {
      return [];
    }
    const featureIds = selected.featureIds;
    return typeof featureIds === "string"
      ? [{mapTileKey: selected.mapTileKey, featureId: featureIds}]
      : featureIds.map((featureId) => ({
        mapTileKey: selected.mapTileKey,
        featureId,
      }));
  }

  /** Return the representative physical altitude of one rendered pick. */
  navigationAltitude(globalPickIndex: number): number | undefined {
    const cached = this.picks.get(globalPickIndex)?.navigationAltitude;
    if (cached !== undefined) {
      return cached;
    }
    const altitude = this.ownedPackedPick(globalPickIndex)
      ?.record.navigationAltitude;
    return Number.isFinite(altitude) ? altitude : undefined;
  }

  /** Test whether selected contributions already retain an exact local target. */
  hasInteractionTarget(
    contributionIdentities: ReadonlySet<string>,
    target: TileFeatureId,
  ): boolean {
    let indices = this.pickIndicesByTileAndFeature
      .get(target.mapTileKey)
      ?.get(target.featureId);
    if (indices === undefined ||
      !this.pickIndicesIncludeContribution(indices, contributionIdentities)) {
      this.findInteractionTarget(contributionIdentities, target);
      indices = this.pickIndicesByTileAndFeature
        .get(target.mapTileKey)
        ?.get(target.featureId);
    }
    return indices !== undefined &&
      this.pickIndicesIncludeContribution(indices, contributionIdentities);
  }

  /** Resolve exact overlay targets into sparse scene-global picking indices. */
  interactionPicks(
    contributionIdentities: ReadonlySet<string>,
    targets: readonly TileFeatureId[],
  ): GpuSceneInteractionPick[] {
    const result = new Map<number, GpuSceneInteractionPick>();
    for (const target of targets) {
      let indices = this.pickIndicesByTileAndFeature
        .get(target.mapTileKey)
        ?.get(target.featureId);
      if (indices === undefined ||
        !this.pickIndicesIncludeContribution(indices, contributionIdentities)) {
        this.findInteractionTarget(contributionIdentities, target);
        indices = this.pickIndicesByTileAndFeature
          .get(target.mapTileKey)
          ?.get(target.featureId);
      }
      if (indices === undefined) {
        continue;
      }
      for (const globalPickIndex of this.pickIndices(indices)) {
        const selected = this.picks.get(globalPickIndex);
        if (
          !selected ||
          !contributionIdentities.has(selected.contributionIdentity)
        ) {
          continue;
        }
        result.set(globalPickIndex, {
          globalPickIndex,
          identityKey: this.pickIdentityKey(selected, globalPickIndex),
        });
      }
    }
    return [...result.values()];
  }

  /** Decode and cache one Deck-selected record while leaving all peers packed. */
  private scenePick(globalPickIndex: number): ScenePickRecord | undefined {
    const cached = this.picks.get(globalPickIndex);
    if (cached) {
      return cached;
    }
    const ownedPick = this.ownedPackedPick(globalPickIndex);
    if (!ownedPick) {
      return undefined;
    }
    const {installed, record} = ownedPick;
    return this.cacheScenePick(
      globalPickIndex,
      installed,
      installed.resolvePick(record),
      record.navigationAltitude,
    );
  }

  /** Resolve one scene-global index to its contribution-owned packed tuple. */
  private ownedPackedPick(globalPickIndex: number): OwnedPackedPick | undefined {
    if (!Number.isInteger(globalPickIndex) || globalPickIndex < 0) {
      return undefined;
    }
    const encodedSlot = this.pickOwnerSlots[globalPickIndex] ?? 0;
    if (encodedSlot === 0) {
      return undefined;
    }
    const installed = this.activeContributionBySlot.get(encodedSlot - 1);
    const range = installed?.pickingRange;
    if (!installed || !range || globalPickIndex < range.firstRecord ||
      globalPickIndex >= range.firstRecord + range.recordCount) {
      return undefined;
    }
    return {
      installed,
      record: this.packedPick(installed, globalPickIndex - range.firstRecord),
    };
  }

  /** Find one local record across the bounded fragment list and decode only it. */
  private packedPick(
    installed: InstalledContribution,
    localPickIndex: number,
  ): GpuPickRecordView {
    for (const table of installed.pickTables) {
      const first = table.firstLocalPickIndex;
      if (localPickIndex >= first && localPickIndex < first + table.count) {
        return table.record(localPickIndex - first);
      }
    }
    throw new Error("GPU scene pick metadata is incomplete.");
  }

  /** Publish one decoded semantic result and its sparse reverse target index. */
  private cacheScenePick(
    globalPickIndex: number,
    installed: InstalledContribution,
    featureIds: string | readonly string[] | undefined,
    navigationAltitude: number,
  ): ScenePickRecord | undefined {
    if (featureIds === undefined || featureIds.length === 0) {
      return undefined;
    }
    const selected: ScenePickRecord = {
      contributionIdentity: installed.identity,
      mapTileKey: installed.mapTileKey,
      featureIds: typeof featureIds === "string"
        ? featureIds
        : [...new Set(featureIds)],
      ...(Number.isFinite(navigationAltitude) ? {navigationAltitude} : {}),
    };
    this.picks.set(globalPickIndex, selected);
    installed.resolvedPickIndices.push(globalPickIndex);
    if (typeof selected.featureIds === "string") {
      if (selected.featureIds) {
        this.addPickIndex(
          selected.mapTileKey,
          selected.featureIds,
          globalPickIndex,
        );
      }
    } else {
      for (const featureId of selected.featureIds) {
        this.addPickIndex(selected.mapTileKey, featureId, globalPickIndex);
      }
    }
    return selected;
  }

  /**
   * Resolve a persisted target by scanning only relevant packed contributions.
   *
   * Ordinary pointer hover already decoded the exact Deck pick, so this slower
   * path is reserved for URL-restored selections and externally supplied targets.
   */
  private findInteractionTarget(
    contributionIdentities: ReadonlySet<string>,
    target: TileFeatureId,
  ): void {
    for (const identity of contributionIdentities) {
      const installed = this.contributionByIdentity.get(identity)?.active;
      const range = installed?.pickingRange;
      if (!installed || !range || installed.mapTileKey !== target.mapTileKey) {
        continue;
      }
      const references = installed.findPickReferences(target.featureId);
      if (references.length === 0) {
        continue;
      }
      for (let local = 0; local < range.recordCount; ++local) {
        const globalPickIndex = range.firstRecord + local;
        const record = this.packedPick(installed, local);
        if (!references.some(reference =>
          reference.channelOrdinal === record.channelOrdinal &&
          reference.entryOrdinal === record.entryOrdinal &&
          reference.endpointRole === record.endpointRole
        )) {
          continue;
        }
        if (!this.picks.has(globalPickIndex)) {
          this.cacheScenePick(
            globalPickIndex,
            installed,
            installed.resolvePick(record),
            record.navigationAltitude,
          );
        }
      }
    }
  }

  /** Return all active labels as one logical snapshot for the bounded TextLayer host. */
  labels(): GpuSceneLabel[] {
    const result: GpuSceneLabel[] = [];
    for (const entry of this.contributionByIdentity.values()) {
      if (entry.active) {
        result.push(...entry.active.labels);
      }
    }
    return result;
  }

  /** Destroy every graphics resource owned by this scene generation. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const store of this.storesByMaterial.values()) {
      store.destroy();
    }
    this.storesByMaterial.clear();
    this.originLookup.destroy();
    this.contributionLookup.destroy();
    this.zIndexLookup.destroy();
    this.originsByIdentity.clear();
    this.originsByKey.clear();
    this.contributionByIdentity.clear();
    this.contributionByKey.clear();
    this.activeContributionBySlot.clear();
    this.presentationReleases.length = 0;
    this.pickOwnerSlots = new Uint32Array();
    this.pickIndicesByTileAndFeature.clear();
    this.picks.clear();
  }

  get revision(): number {
    return this._revision;
  }

  /** Revision of the material-buffer generation currently visible to Deck models. */
  get presentationRevision(): number {
    return this._presentationRevision;
  }

  /** Publish admitted material buffers as one coherent model-visible scene revision. */
  publishPresentation(): boolean {
    this.ensureAlive();
    if (this._presentationRevision === this._revision) {
      return false;
    }
    const order = this.prepareSceneOrder();
    order.contribution.commit();
    order.zIndex.commit();
    for (const installed of this.presentationReleases) {
      this.releaseInstalled(installed, false);
    }
    this.presentationReleases.length = 0;
    for (const store of this.storesByMaterial.values()) {
      store.publish();
    }
    this.originLookup.publish();
    this.contributionLookup.publish();
    this.zIndexLookup.publish();
    this._presentationRevision = this._revision;
    return true;
  }

  /** Release superseded GPU allocations after visible and mask models have rebound. */
  releaseRetiredPresentationResources(): void {
    this.ensureAlive();
    for (const store of this.storesByMaterial.values()) {
      store.releaseRetiredBuffers();
    }
    this.originLookup.releaseRetiredTextures();
    this.contributionLookup.releaseRetiredTextures();
    this.zIndexLookup.releaseRetiredTextures();
  }

  get originTexture(): Texture | null {
    return this.originLookup.texture;
  }

  get contributionTexture(): Texture | null {
    return this.contributionLookup.texture;
  }

  get zIndexTexture(): Texture | null {
    return this.zIndexLookup.texture;
  }

  get lookupTextureWidth(): number {
    return LOOKUP_TEXTURE_WIDTH;
  }

  /** Exclusive scene-global picking bound required by sparse target textures. */
  get pickingHighWater(): number {
    return this.pickingRanges.highWaterRecord;
  }

  /** Expose live material stores and immutable layouts to the vector layer. */
  materialStores(): readonly GpuSceneMaterialStore[] {
    const result: GpuSceneMaterialStore[] = [];
    for (const [materialKey, store] of this.storesByMaterial) {
      const layout = this.streamLayoutByMaterial.get(materialKey);
      if (!layout) {
        throw new Error("GPU material store has no stream layout.");
      }
      result.push({
        kind: layout.kind,
        flags: layout.flags,
        styleOrder: layout.styleOrder,
        renderOrder: layout.renderOrder,
        glowColor: layout.glowColor,
        glowRadius: layout.glowRadius,
        atlasPage: layout.atlasPage,
        store,
      });
    }
    return result;
  }

  /** Return a low-cardinality diagnostic snapshot without touching GPU memory. */
  snapshot(): GpuSceneSnapshot {
    return {
      generation: this.generation,
      revision: this._revision,
      materialCount: this.storesByMaterial.size,
      activeContributionCount: [...this.contributionByIdentity.values()].filter(
        (entry) => !!entry.active,
      ).length,
      activeOriginCount: [...this.originsByIdentity.values()].filter(
        (entry) => entry.activeReferences > 0,
      ).length,
      pickingHighWater: this.pickingRanges.highWaterRecord,
      pickingFragmentation: this.pickingRanges.fragmentedRecords,
      zIndexHighWater: this.zIndexRanges.highWaterRecord,
      zIndexUpdateMs: this.lastZIndexUpdateMs,
      labels: this.labelCount,
      stores: [...this.storesByMaterial.values()].map((store) =>
        store.snapshot(),
      ),
    };
  }

  /** Reject corrupt or stale packet-level metadata before allocating GPU ranges. */
  private validatePacketContext(
    packet: GpuRenderPacketView,
    reservation: GpuSceneRenderReservation,
  ): void {
    if (
      reservation.released ||
      reservation.sceneGeneration !== this.generation ||
      packet.sceneGeneration !== this.generation ||
      packet.packetSequence !== reservation.packetSequence
    ) {
      throw new Error("GPU render packet belongs to a stale scene task.");
    }
    if (
      packet.origin.slot !== reservation.origin.slot ||
      packet.origin.key !== reservation.origin.key
    ) {
      throw new Error(
        "GPU render packet origin does not match its reservation.",
      );
    }
  }

  /** Resolve or create one immutable physical stream layout for a material key. */
  private storeFor(
    stream: GpuRenderPacketView["streams"][number],
    styleOrder: number,
  ): GpuPrimitiveStore {
    if (
      !Number.isSafeInteger(styleOrder) ||
      styleOrder < 0 ||
      styleOrder > 0xffff_ffff
    ) {
      throw new Error("GPU scene style order is outside its uint32 range.");
    }
    // The packet material describes a shader/pipeline configuration. Style
    // order is a separate bounded draw bucket: unlike tiles, it must remain a
    // model boundary because no-depth and translucent records cannot recover
    // authored paint order from clip-space bias alone.
    const drawMaterialKey =
      (stream.materialKey << 32n) | BigInt(styleOrder);
    const existingLayout = this.streamLayoutByMaterial.get(drawMaterialKey);
    if (
      existingLayout &&
      (existingLayout.kind !== stream.kind ||
        existingLayout.flags !== stream.flags ||
        existingLayout.renderOrder !== stream.renderOrder ||
        existingLayout.stride !== stream.recordStride ||
        existingLayout.glowRadius !== stream.glowRadius ||
        existingLayout.atlasPage !== stream.atlasPage ||
        existingLayout.glowColor.some(
          (component, index) => component !== stream.glowColor[index],
        ))
    ) {
      throw new Error(
        "GPU material key was reused with a different record layout.",
      );
    }
    let store = this.storesByMaterial.get(drawMaterialKey);
    if (!store) {
      store = new GpuPrimitiveStore(
        this.device,
        drawMaterialKey,
        stream.recordStride,
      );
      this.storesByMaterial.set(drawMaterialKey, store);
      this.streamLayoutByMaterial.set(drawMaterialKey, {
        kind: stream.kind,
        flags: stream.flags,
        styleOrder,
        renderOrder: stream.renderOrder,
        stride: stream.recordStride,
        glowColor: [...stream.glowColor],
        glowRadius: stream.glowRadius,
        atlasPage: stream.atlasPage,
      });
    }
    return store;
  }

  /** Allocate and bounds-check one contiguous range in Deck's 24-bit pick space. */
  private allocatePickingRange(recordCount: number): GpuRecordRange {
    const range = this.pickingRanges.allocate(recordCount);
    if (range.firstRecord + range.recordCount - 1 > MAX_PICKING_INDEX) {
      this.pickingRanges.release(range);
      throw new Error("GPU scene exhausted Deck's 24-bit picking index space.");
    }
    return range;
  }

  /** Publish one dense pick range through a compact numeric owner lookup. */
  private publishPickOwner(installed: InstalledContribution): void {
    const range = installed.pickingRange;
    if (!range) {
      return;
    }
    const required = range.firstRecord + range.recordCount;
    if (required > this.pickOwnerSlots.length) {
      let capacity = Math.max(64, this.pickOwnerSlots.length);
      while (capacity < required) {
        capacity *= 2;
      }
      const grown = new Uint32Array(capacity);
      grown.set(this.pickOwnerSlots);
      this.pickOwnerSlots = grown;
    }
    if (this.activeContributionBySlot.has(installed.contributionSlot)) {
      throw new Error("GPU contribution pick owner is already active.");
    }
    this.activeContributionBySlot.set(
      installed.contributionSlot,
      installed,
    );
    this.pickOwnerSlots.fill(
      installed.contributionSlot + 1,
      range.firstRecord,
      required,
    );
  }

  /** Clear one retired dense range without walking or decoding its records. */
  private unpublishPickOwner(installed: InstalledContribution): void {
    const range = installed.pickingRange;
    if (!range) {
      return;
    }
    this.activeContributionBySlot.delete(installed.contributionSlot);
    this.pickOwnerSlots.fill(
      0,
      range.firstRecord,
      range.firstRecord + range.recordCount,
    );
  }

  /** Release all ranges and semantic metadata owned by one old revision. */
  private releaseInstalled(
    installed: InstalledContribution,
    clearContributionLookup = true,
  ): void {
    if (clearContributionLookup) {
      this.contributionLookup.clear(installed.contributionSlot);
    }
    this.contributionSlots.release({
      firstRecord: installed.contributionSlot,
      recordCount: 1,
    });
    for (const span of installed.spans) {
      span.store.release(span.range);
    }
    if (installed.pickingRange) {
      this.unpublishPickOwner(installed);
      for (const index of installed.resolvedPickIndices) {
        this.removePick(index);
      }
      this.pickingRanges.release(installed.pickingRange);
    }
    if (installed.zIndexRange) {
      this.zIndexRanges.release(installed.zIndexRange);
    }
    this.labelCount -= installed.labels.length;
    installed.origin.activeReferences = Math.max(
      0,
      installed.origin.activeReferences - 1,
    );
    this.releaseOriginIfUnused(installed.origin);
  }

  /** Roll back ranges which were uploaded but never published as active. */
  private discardStaged(installed: InstalledContribution): void {
    this.contributionLookup.clear(installed.contributionSlot);
    if (this.activeContributionBySlot.get(installed.contributionSlot) ===
      installed) {
      this.unpublishPickOwner(installed);
    }
    for (const span of installed.spans) {
      span.store.release(span.range);
    }
    if (!installed.pickingRange) {
      if (installed.zIndexRange) {
        this.zIndexRanges.release(installed.zIndexRange);
      }
      return;
    }
    for (const index of installed.resolvedPickIndices) {
      this.removePick(index);
    }
    this.pickingRanges.release(installed.pickingRange);
    if (installed.zIndexRange) {
      this.zIndexRanges.release(installed.zIndexRange);
    }
  }

  /** Roll back every inactive range accumulated by an incomplete revision. */
  private abortStagedRender(
    reservation: GpuSceneRenderReservation,
    staged: StagedRender,
  ): void {
    if (this.stagedRenderByReservation.get(reservation) !== staged) {
      return;
    }
    this.stagedRenderByReservation.delete(reservation);
    for (const item of staged.contributions.values()) {
      this.discardStaged(item.installed);
    }
    if (this.pruneEmptyStores()) {
      this._revision += 1;
      this.requestRedraw("GPU staged material removed");
    }
  }

  /** Destroy material buffers once their last independently owned range is gone. */
  private pruneEmptyStores(): boolean {
    let removed = false;
    for (const [materialKey, store] of this.storesByMaterial) {
      if (store.highWaterRecord > 0) {
        continue;
      }
      store.destroy();
      this.storesByMaterial.delete(materialKey);
      this.streamLayoutByMaterial.delete(materialKey);
      removed = true;
    }
    return removed;
  }

  /** Initialize admitted ordering slots without exposing stale recycled values. */
  private updateZIndexLookup(
    staged: readonly {
      entry: ContributionEntry;
      installed: InstalledContribution;
    }[],
  ): void {
    const startedAt = performance.now();
    for (const {installed} of staged) {
      this.contributionLookup.setRange(
        installed.contributionSlot,
        [
          installed.pickingRange?.firstRecord ?? -1,
          0,
          installed.activationToken,
          installed.zIndexRange?.firstRecord ?? -1,
        ],
      );
      if (installed.zIndexRange) {
        this.zIndexLookup.setRange(
          installed.zIndexRange.firstRecord,
          new Float32Array(installed.zIndices.length * 4),
        );
      }
    }
    this.lastZIndexUpdateMs = performance.now() - startedAt;
  }

  /**
   * Prepare one globally coherent exact-order table for the next presentation.
   *
   * Tile-local ranks are invalid once contributions share persistent material
   * buffers: the same authored value can otherwise receive a different depth in
   * each tile and let lower geometry occlude its neighbors. Publication already
   * batches many admissions, so doing the compact metadata walk here avoids the
   * former per-packet whole-scene rerank without weakening ordering semantics.
   */
  private prepareSceneOrder(): PreparedSceneOrder {
    const startedAt = performance.now();
    const active = [...this.contributionByIdentity.values()]
      .flatMap((entry) => entry.active ? [entry.active] : []);
    const normalizedByContribution = new Map<
      InstalledContribution,
      GpuZIndexEntryView[]
    >();
    const uniqueZIndices = new Set<number>();
    const tieBreakersByZIndex = new Map<number, Set<number>>();
    let hasAuthoredZIndex = false;
    for (const installed of active) {
      const normalized = installed.zIndices.map((entry) => {
        hasAuthoredZIndex ||= Number.isFinite(entry.value);
        const result = Number.isFinite(entry.value) ? entry.value : 0;
        const value = result === 0 ? 0 : result;
        const tieBreaker = entry.tieBreaker >>> 0;
        uniqueZIndices.add(value);
        let tieBreakers = tieBreakersByZIndex.get(value);
        if (!tieBreakers) {
          tieBreakers = new Set<number>();
          tieBreakersByZIndex.set(value, tieBreakers);
        }
        tieBreakers.add(tieBreaker);
        return {
          value,
          tieBreaker,
        };
      });
      normalizedByContribution.set(installed, normalized);
    }
    const orderedZIndices = [...uniqueZIndices]
      .sort((left, right) => left - right);
    const depthRanks = allocateDepthRanks(
      orderedZIndices,
      tieBreakersByZIndex,
    );
    const step = hasAuthoredZIndex
      ? MAX_LOCAL_CLIP_SPACE_BIAS / depthRanks.slotCount
      : 0;
    const contributionUpdates: FloatLookupUpdate[] = active.map(
      (installed) => ({
        firstSlot: installed.contributionSlot,
        values: [
          installed.pickingRange?.firstRecord ?? -1,
          0,
          installed.activationToken,
          installed.zIndexRange?.firstRecord ?? -1,
        ],
      }),
    );
    contributionUpdates.push(...this.presentationReleases.map(
      (installed) => ({
        firstSlot: installed.contributionSlot,
        values: [0, 0, 0, 0],
      }),
    ));
    const zIndexUpdates: FloatLookupUpdate[] = [];
    for (const installed of active) {
      if (!installed.zIndexRange) {
        continue;
      }
      const values = new Float32Array(installed.zIndices.length * 4);
      normalizedByContribution.get(installed)!.forEach((entry, index) => {
        const offset = index * 4;
        const allocation = depthRanks.allocations.get(entry.value);
        if (!allocation) {
          return;
        }
        // The renderer puts a Morton tile phase in the low bits. Power-of-two
        // masking preserves that spatial coloring instead of randomly letting
        // neighboring tile-edge geometry collide in the same depth bucket.
        const tieOrdinal = entry.tieBreaker & (allocation.tieBucketCount - 1);
        values[offset] = (allocation.firstSlot + tieOrdinal) * step;
      });
      zIndexUpdates.push({
        firstSlot: installed.zIndexRange.firstRecord,
        values,
      });
    }
    const contribution =
      this.contributionLookup.prepareReplacement(contributionUpdates);
    try {
      const zIndex = this.zIndexLookup.prepareReplacement(zIndexUpdates);
      this.lastZIndexUpdateMs = performance.now() - startedAt;
      return {contribution, zIndex};
    } catch (error) {
      contribution.discard();
      throw error;
    }
  }

  /** Remove one semantic pick from both sparse target and dense index tables. */
  private removePick(globalPickIndex: number): void {
    const selected = this.picks.get(globalPickIndex);
    if (!selected) {
      return;
    }
    const featureIds = typeof selected.featureIds === "string"
      ? [selected.featureIds]
      : selected.featureIds;
    const byFeature = this.pickIndicesByTileAndFeature.get(
      selected.mapTileKey,
    );
    for (const featureId of featureIds) {
      if (!featureId || !byFeature) {
        continue;
      }
      const indices = byFeature.get(featureId);
      if (typeof indices === "number") {
        if (indices === globalPickIndex) {
          byFeature.delete(featureId);
        }
        continue;
      }
      indices?.delete(globalPickIndex);
      if (!indices?.size) {
        byFeature.delete(featureId);
      } else if (indices.size === 1) {
        byFeature.set(featureId, indices.values().next().value!);
      }
    }
    if (byFeature?.size === 0) {
      this.pickIndicesByTileAndFeature.delete(selected.mapTileKey);
    }
    this.picks.delete(globalPickIndex);
  }

  /** Store the overwhelmingly common single pick without allocating a Set. */
  private addPickIndex(
    mapTileKey: string,
    featureId: string,
    globalPickIndex: number,
  ): void {
    let byFeature = this.pickIndicesByTileAndFeature.get(mapTileKey);
    if (!byFeature) {
      byFeature = new Map<string, ScenePickIndices>();
      this.pickIndicesByTileAndFeature.set(mapTileKey, byFeature);
    }
    const current = byFeature.get(featureId);
    if (current === undefined) {
      byFeature.set(featureId, globalPickIndex);
    } else if (typeof current === "number") {
      if (current !== globalPickIndex) {
        byFeature.set(featureId, new Set([current, globalPickIndex]));
      }
    } else {
      current.add(globalPickIndex);
    }
  }

  /** Build a stable interaction identity only for picks entering a mask pass. */
  private pickIdentityKey(
    selected: ScenePickRecord,
    globalPickIndex: number,
  ): string {
    const featureIds = typeof selected.featureIds === "string"
      ? selected.featureIds
      : selected.featureIds.join("\n");
    return featureIds
      ? `${selected.mapTileKey}\u0000${featureIds}`
      : String(globalPickIndex);
  }

  /** Present scalar and genuinely plural target buckets through one iterable. */
  private pickIndices(indices: ScenePickIndices): Iterable<number> {
    return typeof indices === "number" ? [indices] : indices;
  }

  /** Test a sparse target bucket without materializing a temporary index array. */
  private pickIndicesIncludeContribution(
    indices: ScenePickIndices,
    contributionIdentities: ReadonlySet<string>,
  ): boolean {
    for (const index of this.pickIndices(indices)) {
      const selected = this.picks.get(index);
      if (selected &&
        contributionIdentities.has(selected.contributionIdentity)) {
        return true;
      }
    }
    return false;
  }

  /** Reserve one stable origin slot and upload its float64 high/low decomposition. */
  private reserveOrigin(
    identity: string,
    position: [number, number, number],
  ): OriginEntry {
    const existing = this.originsByIdentity.get(identity);
    if (existing) {
      if (existing.position.some((value, index) => value !== position[index])) {
        throw new Error("A GPU origin identity changed coordinates.");
      }
      return existing;
    }
    const key = this.uniqueHash(identity, "gpu-origin-v1", this.originsByKey);
    const slotRange = this.originSlots.allocate(1);
    const entry: OriginEntry = {
      identity,
      key,
      slot: slotRange.firstRecord,
      position: [...position],
      inFlightReferences: 0,
      activeReferences: 0,
    };
    const high = position.map((value) => Math.fround(value));
    try {
      this.originLookup.set(entry.slot, [
        high[0],
        high[1],
        high[2],
        1,
        position[0] - high[0],
        position[1] - high[1],
        position[2] - high[2],
        0,
      ]);
    } catch (error) {
      this.originSlots.release(slotRange);
      throw error;
    }
    this.originsByIdentity.set(identity, entry);
    this.originsByKey.set(key, entry);
    return entry;
  }

  /** Reserve one collision-checked producer identity; revisions own GPU slots. */
  private reserveContribution(identity: string): ContributionEntry {
    const existing = this.contributionByIdentity.get(identity);
    if (existing) {
      return existing;
    }
    const key = this.uniqueHash(
      identity,
      "gpu-contribution-v1",
      this.contributionByKey,
    );
    const entry: ContributionEntry = {
      identity,
      key,
      nextRevision: 0,
      expectedRevision: 0,
      inFlightReferences: 0,
      desired: false,
      active: null,
    };
    this.contributionByIdentity.set(identity, entry);
    this.contributionByKey.set(key, entry);
    return entry;
  }

  /** Allocate a scene-global token which prevents recycled slots reviving stale records. */
  private allocateActivationToken(): number {
    if (this.nextActivationToken >= MAX_ACTIVATION_TOKEN) {
      throw new Error(
        "GPU scene exhausted its 24-bit contribution activation tokens.",
      );
    }
    return ++this.nextActivationToken;
  }

  /** Reclaim an origin only after active records and worker tasks both release it. */
  private releaseOriginIfUnused(entry: OriginEntry): void {
    if (entry.activeReferences > 0 || entry.inFlightReferences > 0) {
      return;
    }
    this.originsByIdentity.delete(entry.identity);
    this.originsByKey.delete(entry.key);
    this.originLookup.clear(entry.slot);
    this.originSlots.release({ firstRecord: entry.slot, recordCount: 1 });
  }

  /** Reclaim a removed producer identity only after all stale workers return. */
  private releaseContributionIfUnused(entry: ContributionEntry): void {
    if (entry.desired || entry.active || entry.inFlightReferences > 0) {
      return;
    }
    this.contributionByIdentity.delete(entry.identity);
    this.contributionByKey.delete(entry.key);
  }

  /** Produce a deterministic 64-bit key and fail rather than conflate collisions. */
  private uniqueHash<T>(
    identity: string,
    namespace: string,
    existing: Map<bigint, T>,
  ): bigint {
    const key = BigInt(`0x${sipHash64Hex(identity, namespace)}`);
    if (existing.has(key)) {
      throw new Error(`GPU scene key collision for '${identity}'.`);
    }
    return key;
  }

  /** Reject new ownership after context teardown while allowing stale jobs to retire. */
  private ensureAlive(): void {
    if (this.destroyed) {
      throw new Error("GPU scene has already been destroyed.");
    }
  }
}
