import { afterEach, describe, expect, it, vi } from "vitest";
import { MapgetLayer } from "../../../app/mapdata/mapget-layer.model";
import { createFeatureSearchStateEntry } from "../../../app/search/search-definition.model";
import { SearchPresentation } from "../../../app/search/search-visualization.presentation";

/** Uses the real native style and styled-layer lifetime around deferred object discovery. */
function fixture() {
    let resolve!: (value: {associations: []; expiresAtMs: number | null}) => void;
    const discovery = new Promise<{associations: []; expiresAtMs: number | null}>(done => { resolve = done; });
    const changed = vi.fn(), onEvent = vi.fn(), release = vi.fn();
    const mapgetLayer = new MapgetLayer("source", "source", "map", "layer", {
        canRead: true, canWrite: false, coverage: [], featureTypes: [], layerId: "layer", type: "Features",
        version: {major: 1, minor: 0, patch: 0}, zoomLevels: [13], partitionKind: "object", tileAssociationLevel: 13
    });
    const presentation = new SearchPresentation({
        key: "s/map/layer", definition: {...createFeatureSearchStateEntry({id: "s", query: "true"}),
            concreteScope: "feature", backendQuery: "true", resultFields: []},
        mapgetLayer, featureTypes: [], definitionSignature: "definition", instanceId: "s:1"
    }, {planStyleFilter: () => ({valid: true, channels: [], issues: []})} as never,
    {
        discoverObjectPartitions: () => discovery,
        createFilterSubscription: () => ({generation: 1, setCoverage: vi.fn(), release})
    } as never, onEvent, changed, vi.fn());
    const deleteStyle = vi.spyOn(presentation.compiled.style.featureLayerStyle, "delete");
    return {presentation, changed, resolve, release, deleteStyle};
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SearchPresentation lifetime", () => {
    it("ignores association discovery after disposal and releases the style once", async () => {
        const h = fixture();
        h.presentation.setCoverage({kind: "object", discoveryTileIds: [1]});
        h.presentation.destroy(); h.presentation.destroy();
        h.resolve({associations: [], expiresAtMs: Date.now() + 100});
        await Promise.resolve();
        expect(h.changed).not.toHaveBeenCalled();
        expect(h.release).toHaveBeenCalledOnce();
        expect(h.deleteStyle).toHaveBeenCalledOnce();
    });

    it("cancels discovered coverage expiry when the presentation is replaced", async () => {
        vi.useFakeTimers();
        const h = fixture();
        h.presentation.setCoverage({kind: "object", discoveryTileIds: [1]});
        h.resolve({associations: [], expiresAtMs: Date.now() + 50});
        await Promise.resolve();
        expect(h.changed).toHaveBeenCalledOnce();
        h.presentation.destroy();
        await vi.runAllTimersAsync();
        expect(h.changed).toHaveBeenCalledOnce();
    });
});
