import type { Layer } from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeckInteractionEffect,
  DeckRgba,
} from "./deck-interaction-effect";
import type { DeckInteractionOutlineService } from "./deck-interaction-outline.service";
import { ErdblickVectorMaskLayer } from "./erdblick-vector.layer";
import { GpuSceneMaskMode } from "./erdblick-vector.shaders";
import type { GpuScene, GpuSceneMaterialStore } from "./gpu-scene";
import { GpuSceneMaskController } from "./gpu-scene-mask.controller";
import type { TileSubsetInteractionOverlay } from "./tile-subset-interaction.model";

/** Minimal sampled texture retaining sparse writes and destruction state. */
class FakeTexture {
  destroyed = false;
  readonly writes: Array<{ data: Uint8Array; options: unknown }> = [];

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly shouldFailWrite: (options: unknown) => boolean,
  ) {}

  /** Retain one upload without sharing the caller's mutable byte view. */
  writeData(data: ArrayBufferView, options: unknown): void {
    if (this.shouldFailWrite(options)) {
      throw new Error("Synthetic sparse texture upload failure.");
    }
    this.writes.push({
      data: new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      ),
      options,
    });
  }

  /** Mark texture retirement for lifecycle assertions. */
  destroy(): void {
    this.destroyed = true;
  }
}

/** Device stub implementing only sparse mask texture allocation. */
class FakeDevice {
  readonly textures: FakeTexture[] = [];
  failNextSparseWrite = false;

  /** Allocate one observable texture using the requested dimensions. */
  createTexture(props: { width: number; height: number }): Texture {
    const texture = new FakeTexture(props.width, props.height, (options) => {
      const width = (options as { width?: number }).width ?? 0;
      if (!this.failNextSparseWrite || width >= props.width) {
        return false;
      }
      this.failNextSparseWrite = false;
      return true;
    });
    this.textures.push(texture);
    return texture as unknown as Texture;
  }
}

interface MaskRegistration {
  groupId: string;
  sourceId: string;
  layer: Layer;
}

/** Outline-service stub retaining the bounded hidden mask layer set. */
class FakeOutlineService {
  readonly masks = new Map<string, MaskRegistration>();
  readonly removals: string[] = [];
  readonly configurations = new Map<
    string,
    { order: number }
  >();
  private nextIdentity = 1;

  /** Accept dynamic compositor metadata just like the production service. */
  configureGroup(
    groupId: string,
    _effect: DeckInteractionEffect,
    order: number,
    _stripeAnchor: [number, number, number],
  ): void {
    this.configurations.set(groupId, { order });
  }

  /** Return a stable nonzero color for one semantic identity. */
  identityColor(
    _groupId: string,
    _identityKey: string,
    _effect: DeckInteractionEffect,
    _order: number,
  ): DeckRgba {
    const value = this.nextIdentity++;
    return [value, 0, 0, 255];
  }

  /** Materialize and retain one hidden mask source. */
  upsertMask(
    groupId: string,
    sourceId: string,
    _effect: DeckInteractionEffect,
    _order: number,
    _stripeAnchor: [number, number, number],
    buildLayer: (layerId: string) => Layer,
  ): void {
    const key = `${groupId}/${sourceId}`;
    this.masks.set(key, {
      groupId,
      sourceId,
      layer: buildLayer(key),
    });
  }

  /** Remove one hidden source and report whether it existed. */
  removeMask(groupId: string, sourceId: string): boolean {
    const key = `${groupId}/${sourceId}`;
    this.removals.push(key);
    return this.masks.delete(key);
  }
}

/** Scene stub exposing sparse picks and low-cardinality material metadata. */
class FakeScene {
  materials: GpuSceneMaterialStore[] = [];
  pickingHighWater = 16;

  /** Return the currently installed material stores. */
  materialStores(): readonly GpuSceneMaterialStore[] {
    return this.materials;
  }

  /** Convert each target's numeric suffix into one deterministic pick index. */
  interactionPicks(
    contributions: ReadonlySet<string>,
    targets: readonly { featureId: string }[],
  ): Array<{ globalPickIndex: number; identityKey: string }> {
    const owner = [...contributions].sort().join(",");
    return targets.map((target) => ({
      globalPickIndex: Number(target.featureId.split(".").at(-1)),
      identityKey: `${owner}/${target.featureId}`,
    }));
  }
}

const EFFECT: DeckInteractionEffect = {
  tint: [255, 255, 0, 255],
  tintMix: 1,
  opacity: 1,
  edgeWidth: 2,
  haloRadius: 0,
  haloOpacity: 0,
  stripeSpacing: 0,
  stripeWidth: 0,
  stripeOpacity: 0,
  stripeAngle: 45,
  stripeOffset: 0,
  stripeSoftness: 1,
};

/** Build one semantic overlay with exact feature targets. */
function overlay(
  id: string,
  featureIds: readonly string[],
): TileSubsetInteractionOverlay {
  return {
    id,
    effect: EFFECT,
    order: 10,
    targets: featureIds.map((featureId) => ({
      mapTileKey: "Features:Map:Layer:1:0",
      featureId,
    })),
  };
}

describe("GpuSceneMaskController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Run all reconciliation callbacks queued by one logical update burst. */
  function flush(): void {
    vi.runOnlyPendingTimers();
  }

  it("coalesces owners into one sparse target group and geometry-faithful pass", () => {
    const device = new FakeDevice();
    const scene = new FakeScene();
    const outline = new FakeOutlineService();
    const controller = new GpuSceneMaskController(
      device as unknown as Device,
      scene as unknown as GpuScene,
      outline as unknown as DeckInteractionOutlineService,
      false,
    );

    controller.setOverlays(
      "owner-a",
      new Set(["a"]),
      [11, 48, 0],
      [overlay("selection", ["Road.2"])],
    );
    controller.setOverlays(
      "owner-b",
      new Set(["b"]),
      [11, 48, 0],
      [overlay("selection", ["Road.5"])],
    );
    expect(vi.getTimerCount()).toBe(1);
    flush();

    expect(outline.masks.size).toBe(1);
    expect(outline.configurations.get("gpu-interaction/selection")).toEqual({
      order: 11,
    });
    expect([...outline.masks.values()].map((mask) => mask.sourceId)).toEqual([
      "scene-vector",
    ]);
    for (const mask of outline.masks.values()) {
      expect(mask.layer).toBeInstanceOf(ErdblickVectorMaskLayer);
      expect(mask.layer.id).toBe(`${mask.groupId}/${mask.sourceId}`);
      expect(
        (mask.layer.props as { drillPickEligible?: boolean }).drillPickEligible,
      ).toBe(false);
    }
    const sparseWrites = device.textures[0].writes.filter(
      (write) => (write.options as { width?: number }).width === 1,
    );
    expect(sparseWrites).toHaveLength(2);
    expect(
      device.textures[0].writes.every(
        (write) =>
          (write.options as { width?: number }).width !==
          device.textures[0].width,
      ),
    ).toBe(true);

    controller.removeOwner("owner-a");
    flush();
    expect(outline.masks.size).toBe(1);
    controller.removeOwner("owner-b");
    flush();
    expect(outline.masks.size).toBe(0);
    expect(outline.removals.slice(-1)).toEqual([
      "gpu-interaction/selection/scene-vector",
    ]);
    expect(device.textures[0].destroyed).toBe(false);
    controller.releaseRetiredResources();
    expect(device.textures[0].destroyed).toBe(true);
  });

  it("groups equal style glows behind the completed vector framebuffer", () => {
    const device = new FakeDevice();
    const scene = new FakeScene();
    const outline = new FakeOutlineService();
    const material = (
      materialKey: bigint,
      styleOrder: number,
    ): GpuSceneMaterialStore => ({
      kind: 1,
      flags: 0,
      styleOrder,
      renderOrder: 0,
      glowColor: [255, 32, 16, 255],
      glowRadius: 4,
      atlasPage: 0,
      store: {
        materialKey,
        activeRecordCount: 3,
      } as GpuSceneMaterialStore["store"],
    });
    scene.materials = [material(1n, 7), material(2n, 7), material(3n, 2)];
    scene.pickingHighWater = 1_000_000;
    const controller = new GpuSceneMaskController(
      device as unknown as Device,
      scene as unknown as GpuScene,
      outline as unknown as DeckInteractionOutlineService,
      true,
    );

    controller.sceneChanged();
    flush();

    expect(outline.masks.size).toBe(1);
    expect([...outline.configurations.values()]).toContainEqual({order: 401});
    const vector = [...outline.masks.values()].find(
      (mask) => mask.sourceId === "scene-vector",
    )!.layer as ErdblickVectorMaskLayer;
    const configuration = (
      vector as unknown as {
        configuration: {
          mode: GpuSceneMaskMode;
          materialKeys: ReadonlySet<bigint> | null;
        };
      }
    ).configuration;
    expect(configuration.mode).toBe(GpuSceneMaskMode.Union);
    expect(configuration.materialKeys).toEqual(new Set([1n, 2n, 3n]));
    expect(device.textures[0].height).toBe(1);
    controller.destroy();
    expect(outline.masks.size).toBe(0);
  });

  it("does not let a packet burst postpone an interaction reconciliation", () => {
    const controller = new GpuSceneMaskController(
      new FakeDevice() as unknown as Device,
      new FakeScene() as unknown as GpuScene,
      new FakeOutlineService() as unknown as DeckInteractionOutlineService,
      false,
    );

    controller.setOverlays(
      "owner",
      new Set(["a"]),
      [11, 48, 0],
      [overlay("hover", ["Road.2"])],
    );
    controller.sceneChanged();

    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the active sparse table when a growth upload fails", () => {
    const device = new FakeDevice();
    const scene = new FakeScene();
    const outline = new FakeOutlineService();
    const controller = new GpuSceneMaskController(
      device as unknown as Device,
      scene as unknown as GpuScene,
      outline as unknown as DeckInteractionOutlineService,
      false,
    );

    controller.setOverlays(
      "owner",
      new Set(["a"]),
      [11, 48, 0],
      [overlay("selection", ["Road.2"])],
    );
    flush();
    const original = device.textures[0];

    scene.pickingHighWater = 2048;
    device.failNextSparseWrite = true;
    controller.setOverlays(
      "owner",
      new Set(["a"]),
      [11, 48, 0],
      [overlay("selection", ["Road.2", "Road.5"])],
    );
    expect(flush).toThrow("Synthetic sparse texture upload failure");
    expect(original.destroyed).toBe(false);
    expect(device.textures.at(-1)?.destroyed).toBe(true);

    controller.sceneChanged();
    flush();
    expect(original.destroyed).toBe(false);
    expect(device.textures.at(-1)?.destroyed).toBe(false);
    controller.releaseRetiredResources();
    expect(original.destroyed).toBe(true);
  });
});
