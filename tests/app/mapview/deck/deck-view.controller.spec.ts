import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {DeckMapView} from "../../../../app/mapview/deck/deck-view.controller";
import type {LocationArea} from "../../../../app/mapview/render-view.model";
import type {LocationAreaLayer} from "../../../../app/mapview/deck/location-area.layer";

interface LocationHighlightHarness {
    locationAreaHighlightTick: (() => void) | null;
    locationAreaHighlightStartedAt: number | undefined;
    startLocationAreaHighlight(area: LocationArea): void;
    stopLocationAreaHighlight(): void;
    altitudeToZoom(altitude: number, latitude: number): number;
    zoomToAltitude(zoom: number, latitude: number): number;
}

describe("DeckMapView", () => {
    it("rejects area highlights after boundary consent has been withdrawn", () => {
        const upsert = vi.fn(), remove = vi.fn(), offTick = vi.fn();
        const tick = () => {};
        const view: LocationHighlightHarness = Object.assign(Object.create(DeckMapView.prototype), {
            locationState: {locationBoundariesEnabled: false}, layerRegistry: {upsert, remove},
            offTick, locationAreaHighlightTick: tick
        });
        view.startLocationAreaHighlight({label: "Place", rectangle: {west: 10, south: 47, east: 14, north: 49}});
        expect(upsert).not.toHaveBeenCalled();
        expect(offTick).toHaveBeenCalledWith(tick);
        expect(remove).toHaveBeenCalledWith("builtin/location-area");
    });

    it("fades a stable polygon array and releases the callback and layer on expiry/replacement", () => {
        let layer: LocationAreaLayer | undefined;
        const onTick = vi.fn(), offTick = vi.fn(), remove = vi.fn();
        const view: LocationHighlightHarness = Object.assign(Object.create(DeckMapView.prototype), {
            layerRegistry: {upsert: (_key: string, next: LocationAreaLayer) => {layer = next;}, remove},
            onTick, offTick, requestRender: vi.fn(), locationAreaHighlightTick: null,
            locationState: {locationBoundariesEnabled: true}
        });
        const now = vi.spyOn(performance, "now").mockReturnValue(1000);
        try {
            const area: LocationArea = {label: "Place", rectangle: {west: 10, south: 47, east: 14, north: 49},
                polygons: [[[[10, 47], [14, 47], [14, 49], [10, 47]]]]};
            view.startLocationAreaHighlight(area);
            const initial = layer!;
            view.locationAreaHighlightTick!();
            expect(layer).toBe(initial); // No fade before the first rendered frame.
            view.locationAreaHighlightStartedAt = 1000;
            now.mockReturnValue(2500);
            view.locationAreaHighlightTick!();
            expect(layer!.props.opacity).toBeCloseTo(0.5);
            expect(layer!.props.data).toBe(initial.props.data);
            expect(layer!.props.pickable).toBe(false);
            const oldTick = view.locationAreaHighlightTick;
            view.startLocationAreaHighlight(area);
            expect(offTick).toHaveBeenCalledWith(oldTick);
            view.locationAreaHighlightStartedAt = 1000;
            now.mockReturnValue(4000);
            view.locationAreaHighlightTick!();
            expect(view.locationAreaHighlightTick).toBeNull();
            expect(remove).toHaveBeenLastCalledWith("builtin/location-area");
        } finally { now.mockRestore(); }
    });

    it("roundtrips negative location zoom through persisted altitude", () => {
        const view: LocationHighlightHarness = Object.assign(Object.create(DeckMapView.prototype), {
            getViewportHeightPixels: () => 600
        });
        for (const zoom of [-8, -2, -0.541, 0, 12]) {
            expect(view.altitudeToZoom(view.zoomToAltitude(zoom, 48), 48)).toBeCloseTo(zoom, 8);
        }
    });

    it("replaces a failed boundary once and ignores errors from retired overlays", async () => {
        let layer: LocationAreaLayer | undefined;
        const unavailable = vi.fn();
        const view: LocationHighlightHarness = Object.assign(Object.create(DeckMapView.prototype), {
            layerRegistry: {upsert: (_key: string, next: LocationAreaLayer) => {layer = next;}, remove: vi.fn()},
            locationState: {locationBoundariesEnabled: true},
            mapViewState: {locationBoundaryUnavailableTopic: {next: unavailable}},
            onTick: vi.fn(), offTick: vi.fn(), requestRender: vi.fn(), locationAreaHighlightTick: null
        });
        const area: LocationArea = {label: "Place", rectangle: {west: 10, south: 47, east: 14, north: 49},
            polygons: [[[[10, 47], [14, 47], [14, 49], [10, 47]]]]};
        view.startLocationAreaHighlight(area);
        const initial = layer!;
        expect(initial.props.onError!(new Error("Tessellation failed"))).toBe(true);
        await Promise.resolve();
        expect(unavailable).toHaveBeenCalledOnce();
        expect(layer!.props.data).toEqual([[[[10, 47], [14, 47], [14, 49], [10, 49], [10, 47]]]]);
        initial.props.onError!(new Error("Stale boundary failure"));
        await Promise.resolve();
        expect(unavailable).toHaveBeenCalledOnce();
        layer!.props.onError!(new Error("Extent failed too"));
        await Promise.resolve();
        expect(view.locationAreaHighlightTick).toBeNull();
        expect(unavailable).toHaveBeenCalledOnce();
    });

    it("captures immediately after the forced frame, without preserving the drawing buffer", () => {
        const calls: string[] = [];
        const canvas = {width: 800, height: 600, getContext: () => ({isContextLost: () => false})};
        const copy = {width: 0, height: 0, getContext: () => ({drawImage: vi.fn(() => calls.push("copy"))}),
            toDataURL: vi.fn(() => {calls.push("encode"); return "data:image/png;base64,AAAA";})};
        const view: DeckMapView = Object.assign(Object.create(DeckMapView.prototype), {
            deck: {isInitialized: true, getCanvas: () => canvas, redraw: () => calls.push("draw-with-overlays")}
        });
        const create = vi.spyOn(document, "createElement").mockReturnValue(copy as unknown as HTMLCanvasElement);
        try {
            expect(view.captureCanvas(0.5)).toEqual({canvas, dataUrl: "data:image/png;base64,AAAA"});
            expect(calls).toEqual(["draw-with-overlays", "copy", "encode"]);
            expect([copy.width, copy.height]).toEqual([400, 300]);
        } finally { create.mockRestore(); }
    });

    it("rejects capture before renderer initialization", () => {
        const view: DeckMapView = Object.assign(Object.create(DeckMapView.prototype), {deck: null});
        expect(() => view.captureCanvas(1)).toThrow("unavailable");
    });

    it("explicitly releases a retired WebGL device", () => {
        const calls: string[] = [];
        const view = Object.create(DeckMapView.prototype) as any;
        view.deckDevice = {
            destroy: vi.fn(() => calls.push("destroy")),
            loseDevice: vi.fn(() => {
                calls.push("lose");
                return true;
            })
        };

        view.releaseDeckDevice();

        expect(calls).toEqual(["destroy", "lose"]);
        expect(view.deckDevice).toBeNull();

        view.releaseDeckDevice();
        expect(calls).toEqual(["destroy", "lose"]);
    });
});
