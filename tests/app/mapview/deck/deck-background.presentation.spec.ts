import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    WmsBackgroundLayerConfig,
    XyzBackgroundLayerConfig
} from "../../../../app/mapview/background-layer.model";
import type { BatchedTileLayer } from "../../../../app/mapview/deck/batched-tile.layer";
import { DeckBackground } from "../../../../app/mapview/deck/deck-background.presentation";
import { DeckLayerRegistry } from "../../../../app/mapview/deck/deck-layer-registry.util";

const xyz: XyzBackgroundLayerConfig = {id: "test", name: "Test", type: "xyz", headers: {},
    defaultOpacity: 6, minZoom: 0, maxZoom: 22, tileSize: 256, urlTemplate: "/tiles/{z}/{x}/{y}"};

/** Capture background layer replacement without constructing a canvas or fetching tiles. */
function createBackground() {
    const registry = new DeckLayerRegistry(null, () => 1, () => {});
    const upsert = vi.spyOn(registry, "upsert");
    return {registry, upsert, background: new DeckBackground(registry)};
}

afterEach(() => vi.unstubAllGlobals());

describe("DeckBackground", () => {
    it("preserves the layer for unchanged choices and removes only its own layer", () => {
        const h = createBackground();
        h.registry.upsert("other", {id: "other"});
        h.upsert.mockClear();
        h.background.update(xyz, 25, true);
        h.background.update(xyz, 25, true);
        expect(h.upsert).toHaveBeenCalledOnce();
        h.background.update(xyz, 50, true);
        expect(h.upsert).toHaveBeenCalledTimes(2);
        h.background.destroy();
        expect(h.registry.size).toBe(1);
        h.background.update(xyz, 50, true);
        expect(h.upsert).toHaveBeenCalledTimes(3);
    });

    it("drops a background when WMS is selected in 3D", () => {
        const h = createBackground();
        h.background.update(xyz, 25, true);
        const wms: WmsBackgroundLayerConfig = {id: "wms", name: "WMS", type: "wms", headers: {},
            defaultOpacity: 6, minZoom: 0, maxZoom: 22, url: "/wms", layers: ["a"],
            version: "1.3.0", crs: "EPSG:3857", format: "image/png", transparent: true, vendorParameters: {}};
        h.background.update(wms, 25, false);
        expect(h.registry.size).toBe(0);
    });

    it("preserves abort signals and merges configured headers into background requests", async () => {
        const h = createBackground();
        const fetch = vi.fn().mockResolvedValue(new Response());
        vi.stubGlobal("fetch", fetch);
        h.background.update({...xyz, headers: {"X-Test": "configured"}}, 25, true);
        const layer = h.upsert.mock.calls[0][1] as BatchedTileLayer<string>;
        const signal = new AbortController().signal;
        await layer.props.loadOptions!.core!.fetch("/tile", {signal, headers: {Accept: "image/png"}});
        expect(fetch.mock.calls[0][1].signal).toBe(signal);
        expect(fetch.mock.calls[0][1].headers.get("X-Test")).toBe("configured");
        expect(fetch.mock.calls[0][1].headers.get("Accept")).toBe("image/png");
    });
});
