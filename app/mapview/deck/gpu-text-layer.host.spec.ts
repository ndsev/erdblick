import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {TextLayer} from "@deck.gl/layers";

import {
    createGpuTextLayerHost,
    DeckTextOverlayService,
    GpuTextLayerHost,
    isDeckTextOverlayLayer
} from "./gpu-text-layer.host";
import {
    GpuLabelFlag,
    GpuLabelSizeUnit,
    GpuLabelWordBreak
} from "./gpu-render-packet";

/** Builds one complete logical label with overridable TextLayer fields. */
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
        borderColor: [0, 0, 0, 255],
        outlineWidth: 1,
        borderWidth: 0,
        backgroundPadding: [0, 0, 0, 0],
        backgroundBorderRadius: [0, 0, 0, 0],
        sizeScale: 1,
        sizeMinPixels: 0,
        sizeMaxPixels: Number.MAX_SAFE_INTEGER,
        lineHeight: 1,
        maxWidth: -1,
        flags: GpuLabelFlag.Billboard | GpuLabelFlag.DepthTest,
        minLod: 0,
        textAnchor: 0,
        alignmentBaseline: 0,
        renderOrder: 0,
        fontWeight: 400,
        collisionPriority: 0,
        sizeUnit: GpuLabelSizeUnit.Pixel,
        wordBreak: GpuLabelWordBreak.BreakWord,
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

    it("passes authored text properties directly to Deck TextLayer", () => {
        const datum = label({
            size: 18,
            angle: 12,
            textAnchor: -1,
            alignmentBaseline: 1,
            borderColor: [1, 2, 3, 4],
            borderWidth: 3,
            sizeUnit: GpuLabelSizeUnit.Meter,
            sizeScale: 2,
            sizeMinPixels: 7,
            sizeMaxPixels: 80,
            fontFamily: "Noto Sans",
            fontWeight: 700,
            lineHeight: 1.25,
            backgroundPadding: [1, 2, 3, 4],
            backgroundBorderRadius: [4, 3, 2, 1],
            wordBreak: GpuLabelWordBreak.BreakAll,
            maxWidth: 14,
            flags: GpuLabelFlag.Billboard | GpuLabelFlag.Background
        });
        const host = new GpuTextLayerHost({
            id: "text",
            data: [],
            scene: {labels: () => [datum]} as never,
            flattenZ: false
        });
        const [layer] = host.renderLayers();
        const props = layer.props as unknown as {
            data: readonly unknown[];
            getSize: (item: unknown) => number;
            getAngle: (item: unknown) => number;
            getTextAnchor: (item: unknown) => string;
            getAlignmentBaseline: (item: unknown) => string;
            getBorderColor: (item: unknown) => number[];
            getBorderWidth: (item: unknown) => number;
            sizeUnits: string;
            sizeScale: number;
            sizeMinPixels: number;
            sizeMaxPixels: number;
            fontFamily: string;
            fontWeight: number;
            lineHeight: number;
            background: boolean;
            backgroundPadding: number[];
            backgroundBorderRadius: number[];
            wordBreak: string;
            maxWidth: number;
        };

        expect(props).toMatchObject({
            sizeUnits: "meters",
            sizeScale: 2,
            sizeMinPixels: 7,
            sizeMaxPixels: 80,
            fontFamily: "Noto Sans",
            fontWeight: 700,
            lineHeight: 1.25,
            background: true,
            backgroundPadding: [1, 2, 3, 4],
            backgroundBorderRadius: [4, 3, 2, 1],
            wordBreak: "break-all",
            maxWidth: 14
        });
        expect(props.getSize(props.data[0])).toBe(18);
        expect(props.getAngle(props.data[0])).toBe(12);
        expect(props.getTextAnchor(props.data[0])).toBe("start");
        expect(props.getAlignmentBaseline(props.data[0])).toBe("bottom");
        expect(props.getBorderColor(props.data[0])).toEqual([1, 2, 3, 4]);
        expect(props.getBorderWidth(props.data[0])).toBe(3);
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
        const props = layer.props as unknown as {
            collisionEnabled: boolean;
            collisionGroup: string;
            characterSet: string;
            getCollisionPriority: (datum: unknown, info: unknown) => number;
            data: readonly unknown[];
            extensions: readonly unknown[];
        };

        expect(props.collisionEnabled).toBe(true);
        expect(props.collisionGroup).toBe("text-labels");
        expect(props.characterSet).toBe("auto");
        expect(props.getCollisionPriority(props.data[0], {}))
            .toBe(17);
        // Collision renders labels through a separate picking-color pass.
        // Depth-free labels must not inject the independent z-index shader
        // hook into that pass, or the collision map rejects every label.
        expect(props.extensions).toHaveLength(1);
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

    it("classifies logical and direct Deck text roots for the final overlay", () => {
        const host = createGpuTextLayerHost(
            "text",
            {labels: () => []} as never,
            false
        );
        const directText = new TextLayer({id: "direct-text", data: []});

        expect(isDeckTextOverlayLayer(host)).toBe(true);
        expect(isDeckTextOverlayLayer(directText)).toBe(true);
        expect(isDeckTextOverlayLayer({id: "vector"} as never)).toBe(false);
    });

    it("renders text after compositing while preserving scene color", () => {
        const render = vi.fn();
        const service = new DeckTextOverlayService();
        (service as any).pass = {render};
        const host = createGpuTextLayerHost(
            "text",
            {labels: () => []} as never,
            false
        );
        service.preRender({
            pass: "screen",
            isPicking: false,
            layers: [host],
            viewports: []
        } as never);

        service.renderOverlay();
        service.renderOverlay();

        expect(render).toHaveBeenCalledOnce();
        const options = render.mock.calls[0][0];
        expect(options).toMatchObject({
            target: null,
            pass: "text-overlay",
            isPicking: false,
            clearCanvas: true,
            clearColor: false,
            clearStack: true
        });
        expect(options.layerFilter({layer: host})).toBe(true);
        expect(options.layerFilter({layer: {id: "vector"}})).toBe(false);
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
        const props = layer.props as unknown as {
            getPosition: (datum: unknown, info: unknown) => unknown;
            data: readonly unknown[];
        };

        expect(props.getPosition(props.data[0], {}))
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
