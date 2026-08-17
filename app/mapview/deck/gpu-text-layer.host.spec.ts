import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {
    createGpuTextLayerHost,
    GpuTextLayerHost
} from "./gpu-text-layer.host";
import {GpuLabelFlag} from "./gpu-render-packet";

/** Builds one complete logical label with overridable compatibility fields. */
function label(overrides: Record<string, unknown> = {}) {
    return {
        contributionIndex: 0,
        localPickIndex: 0,
        position: [11, 48, 0],
        text: "Label",
        fontFamily: "Noto Sans",
        size: 12,
        pixelOffset: [0, 0],
        angle: 0,
        zIndex: 0,
        color: [255, 255, 255, 255],
        outlineColor: [0, 0, 0, 255],
        backgroundColor: [0, 0, 0, 0],
        outlineWidth: 1,
        backgroundPadding: [0, 0],
        flags: GpuLabelFlag.Billboard | GpuLabelFlag.DepthTest,
        horizontalOrigin: 0,
        verticalOrigin: 0,
        renderOrder: 0,
        fontWeight: 400,
        collisionPriority: 0,
        globalPickIndex: 7,
        styleOrder: 0,
        ...overrides
    };
}

describe("GpuTextLayerHost", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("groups labels only by true TextLayer-wide compatibility properties", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const buckets = (host as any).buckets([
            label({text: "First", zIndex: 10}),
            label({text: "Second", zIndex: 20}),
            label({fontFamily: "serif"}),
            label({flags: 0})
        ]);

        expect(buckets).toHaveLength(3);
        expect(buckets[0].data.map((item: {text: string}) => item.text))
            .toEqual(["First", "Second"]);
        expect(buckets[0].data[1].zIndexOffset)
            .toBeGreaterThan(buckets[0].data[0].zIndexOffset);
    });

    it("keeps stylesheet order as a bounded TextLayer compatibility key", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const buckets = (host as any).buckets([
            label({text: "Later", styleOrder: 4}),
            label({text: "Earlier", styleOrder: 1})
        ]);

        expect(buckets).toHaveLength(2);
        expect(buckets.map((bucket: {styleOrder: number}) =>
            bucket.styleOrder).sort()).toEqual([1, 4]);
    });

    it("keeps concrete rule order and font weight in TextLayer buckets", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const buckets = (host as any).buckets([
            label({text: "Later", renderOrder: 4, fontWeight: 700}),
            label({text: "Earlier", renderOrder: 1, fontWeight: 400})
        ]);

        expect(buckets).toHaveLength(2);
        expect(buckets.map((bucket: {renderOrder: number}) =>
            bucket.renderOrder).sort()).toEqual([1, 4]);
        expect(buckets.map((bucket: {fontWeight: number}) =>
            bucket.fontWeight).sort()).toEqual([400, 700]);
    });

    it("separates unselectable labels so they cannot consume a drill-pick hit", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const buckets = (host as any).buckets([
            label({text: "Selectable"}),
            label({text: "Decoration", globalPickIndex: null})
        ]);

        expect(buckets).toHaveLength(2);
        expect(buckets.map((bucket: {pickable: boolean}) => bucket.pickable))
            .toEqual([true, false]);
    });

    it("enables one shared collision group only for opted-in labels", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {
                labels: () => [
                    label({
                        flags: GpuLabelFlag.Billboard |
                            GpuLabelFlag.Collision,
                        collisionPriority: 17
                    })
                ]
            } as never,
            flattenZ: false
        });
        const [layer] = host.renderLayers();

        expect(layer.props.collisionEnabled).toBe(true);
        expect(layer.props.collisionGroup).toBe("text-labels");
        expect(layer.props.characterSet).toBe("auto");
        expect(layer.props.getCollisionPriority(layer.props.data[0], {} as never))
            .toBe(17);
        // Collision renders labels through a separate picking-color pass.
        // Depth-free labels must not inject the independent z-index shader
        // hook into that pass, or the collision map rejects every label.
        expect(layer.props.extensions).toHaveLength(1);
    });

    it("retains label order below Float32 precision", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const buckets = (host as any).buckets([
            label({zIndex: 65535}),
            label({zIndex: 65535.0001})
        ]);

        expect(new Set(new Float32Array([65535, 65535.0001])).size).toBe(1);
        expect(buckets[0].data[1].zIndexOffset)
            .toBeGreaterThan(buckets[0].data[0].zIndexOffset);
    });

    it("marks the logical host as eligible for bounded drill picking", () => {
        const host = createGpuTextLayerHost(
            "text",
            {labels: () => []} as never,
            false
        );
        expect(host.props.pickable).toBe(true);
        expect(host.props.drillPickEligible).toBe(true);
    });

    it("maps TextLayer-local objects back to scene-global pick indices", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const info = host.getPickingInfo({
            mode: "hover",
            info: {
                index: 0,
                object: label({globalPickIndex: 23})
            } as never
        });

        expect(info.index).toBe(23);
        expect(info.sourceLayer).toBe(host);
    });

    it("flattens label altitude in the 2D scene", () => {
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => [label({position: [11, 48, 900]})]} as never,
            flattenZ: true
        });
        const [layer] = host.renderLayers();

        expect(layer.props.getPosition(layer.props.data[0], {} as never))
            .toEqual([11, 48, 0]);
    });

    it("coalesces whole-scene text snapshots to a bounded cadence", () => {
        let now = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
            frames.push(callback);
            return frames.length;
        });
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => []} as never,
            flattenZ: false
        });
        const needsUpdate = vi.fn();
        const needsRedraw = vi.fn();
        host.setNeedsUpdate = needsUpdate;
        host.setNeedsRedraw = needsRedraw;

        host.sceneChanged();
        host.sceneChanged();
        expect(frames).toHaveLength(1);
        frames.shift()!(now);
        expect(needsUpdate).toHaveBeenCalledOnce();

        now += 20;
        host.sceneChanged();
        host.sceneChanged();
        expect(frames).toHaveLength(0);
        vi.advanceTimersByTime(79);
        expect(frames).toHaveLength(0);
        now += 80;
        vi.advanceTimersByTime(1);
        expect(frames).toHaveLength(1);
        frames.shift()!(now);
        expect(needsUpdate).toHaveBeenCalledTimes(2);
        expect(needsRedraw).toHaveBeenCalledTimes(2);
    });
});
