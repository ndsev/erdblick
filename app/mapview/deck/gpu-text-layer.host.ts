import {
    COORDINATE_SYSTEM,
    CompositeLayer,
    type Effect,
    type EffectContext,
    type Layer,
    type LayerContext,
    type LayerProps,
    type PickingInfo,
    type PreRenderOptions,
    _LayersPass as LayersPass
} from "@deck.gl/core";
import {CollisionFilterExtension} from "@deck.gl/extensions";
import {TextLayer} from "@deck.gl/layers";

import {DeckZIndexExtension} from "./deck-z-index.extension";
import {
    GpuLabelFlag,
    GpuLabelSizeUnit,
    GpuLabelWordBreak
} from "./gpu-render-packet";
import type {GpuScene, GpuSceneLabel} from "./gpu-scene";

const NO_DEPTH_PARAMETERS = {
    depthCompare: "always",
    depthWriteEnabled: false
} as const;
// Deck TextLayer necessarily scans the complete logical label snapshot when
// data changes. Keep labels progressive without letting a tile burst trigger
// one whole-scene text layout per animation frame.
const MIN_LABEL_SNAPSHOT_INTERVAL_MS = 100;

interface GpuTextDatum extends GpuSceneLabel {
    zIndexOffset: number;
}

interface GpuTextBucket {
    key: string;
    styleOrder: number;
    renderOrder: number;
    billboard: boolean;
    depthTest: boolean;
    pickable: boolean;
    background: boolean;
    collision: boolean;
    fontFamily: string;
    fontWeight: number;
    sizeUnits: "pixels" | "meters" | "common";
    sizeScale: number;
    sizeMinPixels: number;
    sizeMaxPixels: number;
    lineHeight: number;
    outlineColor: [number, number, number, number];
    outlineWidth: number;
    backgroundPadding: [number, number, number, number];
    backgroundBorderRadius: [number, number, number, number];
    wordBreak: "break-word" | "break-all";
    maxWidth: number;
    data: GpuTextDatum[];
}

/** Stable Deck text lane that groups scene labels only by true layer-wide properties. */
export class GpuTextLayerHost extends CompositeLayer<LayerProps & {
    scene: GpuScene;
    flattenZ: boolean;
    drillPickEligible?: boolean;
}> {
    static override layerName = "GpuTextLayerHost";

    private snapshotFrame: number | null = null;
    private snapshotTimer: number | null = null;
    private lastSnapshotAt = Number.NEGATIVE_INFINITY;
    private snapshotDirty = false;

    /** Coalesce contribution bursts before rebuilding Deck's whole-label snapshot. */
    sceneChanged(): void {
        this.snapshotDirty = true;
        this.scheduleSnapshot();
    }

    /** Cancel deferred TextLayer work when Deck retires this view generation. */
    override finalizeState(context: LayerContext): void {
        if (this.snapshotFrame !== null) {
            window.cancelAnimationFrame(this.snapshotFrame);
            this.snapshotFrame = null;
        }
        if (this.snapshotTimer !== null) {
            window.clearTimeout(this.snapshotTimer);
            this.snapshotTimer = null;
        }
        this.snapshotDirty = false;
        super.finalizeState(context);
    }

    /** Materialize one TextLayer per low-cardinality compatibility key, never per tile. */
    override renderLayers(): TextLayer<GpuTextDatum>[] {
        return this.buckets(this.props.scene.labels())
            .sort((left, right) => left.styleOrder - right.styleOrder ||
                left.renderOrder - right.renderOrder ||
                left.key.localeCompare(right.key))
            .map((bucket, index) =>
            new TextLayer<GpuTextDatum>({
                id: `${this.props.id}-${index}-${bucket.key}`,
                data: bucket.data,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (label: GpuTextDatum) => this.props.flattenZ
                    ? [label.position[0], label.position[1], 0]
                    : label.position,
                getText: (label: GpuTextDatum) => label.text,
                getColor: (label: GpuTextDatum) => label.color,
                getSize: (label: GpuTextDatum) => label.size,
                getAngle: (label: GpuTextDatum) => label.angle,
                getPixelOffset: (label: GpuTextDatum) => label.pixelOffset,
                getTextAnchor: (label: GpuTextDatum) => label.textAnchor < 0
                    ? "start"
                    : label.textAnchor > 0 ? "end" : "middle",
                getAlignmentBaseline: (label: GpuTextDatum) => label.alignmentBaseline < 0
                    ? "top"
                    : label.alignmentBaseline > 0 ? "bottom" : "center",
                getBackgroundColor: (label: GpuTextDatum) => label.backgroundColor,
                getBorderColor: (label: GpuTextDatum) => label.borderColor,
                getBorderWidth: (label: GpuTextDatum) => label.borderWidth,
                sizeUnits: bucket.sizeUnits,
                sizeScale: bucket.sizeScale,
                sizeMinPixels: bucket.sizeMinPixels,
                sizeMaxPixels: bucket.sizeMaxPixels,
                fontFamily: bucket.fontFamily,
                fontWeight: bucket.fontWeight,
                lineHeight: bucket.lineHeight,
                billboard: bucket.billboard,
                background: bucket.background,
                backgroundPadding: bucket.backgroundPadding,
                backgroundBorderRadius: bucket.backgroundBorderRadius,
                outlineColor: bucket.outlineColor,
                outlineWidth: bucket.outlineWidth,
                fontSettings: {sdf: bucket.outlineWidth > 0},
                wordBreak: bucket.wordBreak,
                maxWidth: bucket.maxWidth,
                extensions: [
                    ...(bucket.depthTest
                        ? [new DeckZIndexExtension()]
                        : []),
                    ...(bucket.collision
                        ? [new CollisionFilterExtension()]
                        : [])
                ],
                getZIndexOffset: (label: GpuTextDatum) => label.zIndexOffset,
                collisionEnabled: bucket.collision,
                collisionGroup: `${this.props.id}-labels`,
                getCollisionPriority: (label: GpuTextDatum) =>
                    label.collisionPriority,
                characterSet: "auto",
                parameters: bucket.depthTest ? {} : NO_DEPTH_PARAMETERS,
                pickable: bucket.pickable,
                drillPickEligible: bucket.pickable
            } as never)
        );
    }

    /** Preserve the scene-global object index for shared semantic resolution. */
    override getPickingInfo({info}: {
        info: PickingInfo<GpuTextDatum>;
        mode: string;
    }): PickingInfo<GpuTextDatum> {
        const globalPickIndex = info.object?.globalPickIndex;
        return {
            ...info,
            index: globalPickIndex ?? -1,
            sourceLayer: this
        };
    }

    /** Group labels and compute a stable bounded z-order offset per logical datum. */
    private buckets(labels: readonly GpuSceneLabel[]): GpuTextBucket[] {
        const result = new Map<string, GpuTextBucket>();
        const zValues = labels.map(label => label.zIndex);
        const uniqueZ = [...new Set(zValues)].sort((left, right) => left - right);
        const zRank = new Map(uniqueZ.map((value, index) => [value, index]));
        const zStep = uniqueZ.length > 0 ? 0.00025 / uniqueZ.length : 0;
        for (const label of labels) {
            const billboard = (label.flags & GpuLabelFlag.Billboard) !== 0;
            const depthTest = (label.flags & GpuLabelFlag.DepthTest) !== 0;
            const pickable = label.globalPickIndex !== null;
            const background = (label.flags & GpuLabelFlag.Background) !== 0;
            const collision = (label.flags & GpuLabelFlag.Collision) !== 0;
            const sizeUnits = label.sizeUnit === GpuLabelSizeUnit.Meter
                ? "meters"
                : label.sizeUnit === GpuLabelSizeUnit.Common
                    ? "common"
                    : "pixels";
            const wordBreak = label.wordBreak === GpuLabelWordBreak.BreakAll
                ? "break-all"
                : "break-word";
            const key = JSON.stringify([
                label.styleOrder,
                label.renderOrder,
                billboard,
                depthTest,
                pickable,
                background,
                collision,
                label.fontFamily,
                label.fontWeight,
                sizeUnits,
                label.sizeScale,
                label.sizeMinPixels,
                label.sizeMaxPixels,
                label.lineHeight,
                label.outlineColor,
                label.outlineWidth,
                label.backgroundPadding,
                label.backgroundBorderRadius,
                wordBreak,
                label.maxWidth
            ]);
            let bucket = result.get(key);
            if (!bucket) {
                bucket = {
                    key,
                    styleOrder: label.styleOrder,
                    renderOrder: label.renderOrder,
                    billboard,
                    depthTest,
                    pickable,
                    background,
                    collision,
                    fontFamily: label.fontFamily,
                    fontWeight: label.fontWeight,
                    sizeUnits,
                    sizeScale: label.sizeScale,
                    sizeMinPixels: label.sizeMinPixels,
                    sizeMaxPixels: label.sizeMaxPixels,
                    lineHeight: label.lineHeight,
                    outlineColor: label.outlineColor,
                    outlineWidth: label.outlineWidth,
                    backgroundPadding: label.backgroundPadding,
                    backgroundBorderRadius: label.backgroundBorderRadius,
                    wordBreak,
                    maxWidth: label.maxWidth,
                    data: []
                };
                result.set(key, bucket);
            }
            bucket.data.push({
                ...label,
                zIndexOffset: (zRank.get(label.zIndex) ?? 0) * zStep
            });
        }
        return [...result.values()];
    }

    /** Schedule one bounded-cadence snapshot without delaying vector uploads. */
    private scheduleSnapshot(): void {
        if (this.snapshotFrame !== null || this.snapshotTimer !== null) {
            return;
        }
        const delay = Math.max(
            0,
            MIN_LABEL_SNAPSHOT_INTERVAL_MS -
                (performance.now() - this.lastSnapshotAt)
        );
        if (delay > 0) {
            this.snapshotTimer = window.setTimeout(() => {
                this.snapshotTimer = null;
                this.scheduleSnapshot();
            }, delay);
            return;
        }
        this.snapshotFrame = window.requestAnimationFrame(() => {
            this.snapshotFrame = null;
            if (!this.snapshotDirty) {
                return;
            }
            this.snapshotDirty = false;
            this.lastSnapshotAt = performance.now();
            this.setNeedsUpdate();
            this.setNeedsRedraw();
        });
    }
}

/** Returns whether a root layer belongs in the final, post-compositor text pass. */
export function isDeckTextOverlayLayer(layer: Layer): boolean {
    return layer instanceof GpuTextLayerHost || layer instanceof TextLayer;
}

/**
 * Captures Deck's current frame inputs and redraws every text root after scene compositing.
 * The pass preserves scene color while clearing scene depth, so labels remain above geometry,
 * retain their own depth ordering, and never enter contact-shading input buffers.
 */
export class DeckTextOverlayService implements Effect {
    readonly id = "deck-text-overlay-service";
    readonly props = null;
    readonly useInPicking = false;

    private pass: LayersPass | null = null;
    private frameOptions: PreRenderOptions | null = null;

    /** Allocate the dedicated final text pass on Deck's graphics device. */
    setup(context: EffectContext): void {
        this.pass = new LayersPass(context.device, {
            id: "deck-text-overlay-pass"
        });
    }

    /** Retain the ordinary screen frame inputs for the matching post-compositor draw. */
    preRender(options: PreRenderOptions): void {
        if (!options.isPicking && options.pass === "screen") {
            this.frameOptions = options;
        }
    }

    /** Draw text to the canvas after every scene compositor has presented its result. */
    renderOverlay(): void {
        const options = this.frameOptions;
        this.frameOptions = null;
        if (!this.pass || !options) {
            return;
        }
        this.pass.render({
            ...options,
            target: null,
            pass: "text-overlay",
            isPicking: false,
            clearCanvas: true,
            // LayersPass supports preserving color while clearing depth, but its
            // published type does not include the runtime-supported false value.
            clearColor: false as never,
            clearStack: true,
            layerFilter: ({layer}) => isDeckTextOverlayLayer(layer)
        });
    }

    /** Release references owned by the effect when Deck retires the view. */
    cleanup(): void {
        this.pass?.cleanup();
        this.pass = null;
        this.frameOptions = null;
    }
}

/** Construct the single logical text host associated with one Deck view. */
export function createGpuTextLayerHost(
    id: string,
    scene: GpuScene,
    flattenZ: boolean
): GpuTextLayerHost {
    return new GpuTextLayerHost({
        id,
        data: [],
        scene,
        flattenZ,
        // Deck evaluates layerFilter against the root composite layer. Keep
        // the host pickable so its eligible TextLayer children participate in
        // both ordinary picking and CollisionFilterExtension's picking pass.
        pickable: true,
        drillPickEligible: true
    });
}
