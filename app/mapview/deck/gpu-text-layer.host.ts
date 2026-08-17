import {
    COORDINATE_SYSTEM,
    CompositeLayer,
    type LayerContext,
    type LayerProps,
    type PickingInfo
} from "@deck.gl/core";
import {CollisionFilterExtension} from "@deck.gl/extensions";
import {TextLayer} from "@deck.gl/layers";

import {DeckZIndexExtension} from "./deck-z-index.extension";
import {GpuLabelFlag} from "./gpu-render-packet";
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
    outlineColor: [number, number, number, number];
    outlineWidth: number;
    backgroundPadding: [number, number];
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
                getTextAnchor: (label: GpuTextDatum) => label.horizontalOrigin < 0
                    ? "start"
                    : label.horizontalOrigin > 0 ? "end" : "middle",
                getAlignmentBaseline: (label: GpuTextDatum) => label.verticalOrigin < 0
                    ? "top"
                    : label.verticalOrigin > 0 ? "bottom" : "center",
                getBackgroundColor: (label: GpuTextDatum) => label.backgroundColor,
                sizeUnits: "pixels",
                fontFamily: bucket.fontFamily,
                fontWeight: bucket.fontWeight,
                billboard: bucket.billboard,
                background: bucket.background,
                backgroundPadding: bucket.backgroundPadding,
                outlineColor: bucket.outlineColor,
                outlineWidth: bucket.outlineWidth,
                fontSettings: {sdf: bucket.outlineWidth > 0},
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
                label.outlineColor,
                label.outlineWidth,
                label.backgroundPadding
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
                    outlineColor: label.outlineColor,
                    outlineWidth: label.outlineWidth,
                    backgroundPadding: label.backgroundPadding,
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
