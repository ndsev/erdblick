import "@angular/compiler";
import { stateOwners, testPersistence } from '../../support/state-owners';
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import type { InspectionPanelModel, TileFeatureId } from "../../../app/inspection/inspection.model";
import type { InfoMessageService } from "../../../app/diagnostics/info.service";
import { FeatureWrapper } from "../../../app/mapdata/feature-inspection.adapter";
import type { MapTileStreamService } from "../../../app/mapdata/map-tile-stream.service";
import { InspectionSelectionService } from "../../../app/inspection/inspection-selection.service";

const feature = (featureId: string, mapTileKey: string): TileFeatureId => ({ featureId, mapTileKey });

function createHarness(
    limit: number,
    initialPanels: InspectionPanelModel<TileFeatureId>[] = [],
    loadFeatures = vi.fn(async () => [] as FeatureWrapper[])
) {
    const persistence = testPersistence();
    const owners = stateOwners(persistence);
    const stateService = owners.inspectionState;
    stateService.state.inspectionsLimit = limit;
    stateService.state.selection = initialPanels;
    vi.spyOn(stateService, 'setSelection');
    vi.spyOn(stateService, 'unsetUnlockedSelections');
    vi.spyOn(stateService, 'setInspectionPanelLockedState');
    const infoMessageService = { showWarning: vi.fn() } as unknown as InfoMessageService;
    const tileStream = {
        loadFeatures,
        updateRetainedTileExpiry: vi.fn<MapTileStreamService["updateRetainedTileExpiry"]>(),
        resolveFeatureIdentities: vi.fn(async (features: TileFeatureId[]) => features)
    };
    const service = new InspectionSelectionService(
        persistence,
        tileStream as never,
        {} as never,
        { registerShortcut: vi.fn() } as never,
        infoMessageService,
        { run: (callback: () => unknown) => callback() } as never, stateService, owners.viewSettings
    );
    return {
        service,
        persistence,
        layout: owners.layout,
        stateService,
        infoMessageService,
        loadFeatures,
        updateRetainedTileExpiry: tileStream.updateRetainedTileExpiry,
        panels: () => stateService.state.selection
    };
}

describe("InspectionSelectionService multi-inspection", () => {
    it("uses the same native bounds for single/multi-feature fits and unwraps the antimeridian", () => {
        const { service } = createHarness(3);
        const wrapper = (x: number, y = 40) => ({
            featureId: "Road.1",
            peek: (callback: (value: unknown) => unknown) => callback({
                center: () => ({ x, y, z: 10 }), boundingRadiusEndPoint: () => ({ x, y, z: 10 })
            })
        }) as unknown as FeatureWrapper;
        expect(service.featureSetZoomTarget([wrapper(10)])).toEqual({ x: 10, y: 40, z: 110 });
        const combined = service.featureSetZoomTarget([wrapper(179.9), wrapper(-179.9)])!;
        expect(combined.x).toBeCloseTo(-180);
        expect(combined.y).toBe(40);
        expect(combined.z).toBeGreaterThan(1000);
        expect(service.featureSetZoomTarget([])).toBeUndefined();
        expect(service.featureSetZoomTarget([wrapper(10), wrapper(NaN)])).toBeUndefined();
    });

    it("uses a selected vertex for camera focus and does not zoom a missing vertex", () => {
        const {service} = createHarness(3);
        const position = vi.fn().mockReturnValueOnce({x: 12, y: 48, z: 100}).mockReturnValueOnce(null);
        const picked = {featureId: "Road.7:shapepoint#2.3@feed",
            peek: (cb: (v: unknown) => unknown) => cb({shapePointPosition: position})} as unknown as FeatureWrapper;
        expect(service.featureSetZoomTarget([picked])).toEqual({x: 12, y: 48, z: 200});
        expect(position).toHaveBeenCalledWith(2, 3, "feed");
        expect(service.featureSetZoomTarget([picked])).toBeUndefined();
    });

    it("keeps the saved vertex visible as unavailable when its partition vanishes on refresh", async () => {
        const id = feature("Lane.7:shapepoint#1.2@feed", "Features:Map:Lane:42");
        const tile = {mapTileKey: id.mapTileKey, partitionKey: "42", expiresAtMs: 1234};
        const wrapper = {...id, featureTile: tile, key: () => id} as FeatureWrapper;
        const load = vi.fn<() => Promise<FeatureWrapper[]>>()
            .mockResolvedValueOnce([wrapper]).mockResolvedValueOnce([]);
        const {service, panels, updateRetainedTileExpiry} = createHarness(3, [{
            id: 0, features: [id], locked: true, focused: true, size: [30, 20], color: "#fff", undocked: false
        }], load);
        service.initialize();
        await vi.waitFor(() => expect(updateRetainedTileExpiry).toHaveBeenCalledTimes(1));
        const [owner, tileId, valueVersion] = updateRetainedTileExpiry.mock.calls[0];
        owner.expireTiles([{tileId, valueVersion}]);
        await vi.waitFor(() => expect(service.selectionTopic.value[0].features).toEqual([]));
        expect(service.selectionTopic.value[0].unavailablePoints?.[0]).toContain("vertex 2 of Lane.7");
        expect(panels()[0].features).toEqual([id]);
    });

    it("resolves a newly selected vertex against the current host instead of reusing an open host", async () => {
        const key = "Features:Map:Road:42";
        const host = feature("Road.7", key);
        const point = feature("Road.7:shapepoint#1.2@feed", key);
        const tile = {mapTileKey: key, sourceId: "feed", expiresAtMs: null} as FeatureWrapper["featureTile"];
        const oldHost = new FeatureWrapper(host.featureId, tile);
        const currentPoint = new FeatureWrapper(point.featureId, {...tile} as FeatureWrapper["featureTile"]);
        const load = vi.fn<() => Promise<FeatureWrapper[]>>()
            .mockResolvedValueOnce([oldHost]).mockResolvedValueOnce([currentPoint]);
        const {service} = createHarness(2, [{
            id: 0, features: [host], locked: false, focused: true, size: [30, 20], color: "#fff", undocked: false
        }], load);
        service.initialize();
        await vi.waitFor(() => expect(service.selectionTopic.value[0].features[0]).toBe(oldHost));
        service.inspectFeatureIds([point]);
        await vi.waitFor(() => expect(service.selectionTopic.value[0].features[0]).toBe(currentPoint));
        expect(load).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenLastCalledWith([point], expect.any(AbortSignal));
    });

    it("publishes loading panel shells and starts independent feature loads concurrently", async () => {
        const first = feature("first", "map/tile-1");
        const second = feature("second", "map/tile-2");
        const initialPanels: InspectionPanelModel<TileFeatureId>[] = [first, second]
            .map((selected, id) => ({
                id,
                features: [selected],
                locked: true,
                focused: id === 1,
                size: [30, 20],
                color: "#fff",
                undocked: false
            }));
        const resolvers: Array<(features: FeatureWrapper[]) => void> = [];
        const loadFeatures = vi.fn(() => new Promise<FeatureWrapper[]>(resolve => {
            resolvers.push(resolve);
        }));
        const { service } = createHarness(3, initialPanels, loadFeatures);

        service.initialize();

        expect(loadFeatures).toHaveBeenCalledTimes(2);
        expect(service.selectionTopic.getValue().map(panel => ({
            id: panel.id,
            loading: panel.loading,
            featureCount: panel.features.length
        }))).toEqual([
            { id: 0, loading: true, featureCount: 0 },
            { id: 1, loading: true, featureCount: 0 }
        ]);
        expect(service.selectionIdsTopic.getValue().map(panel => panel.features))
            .toEqual([[first], [second]]);

        resolvers.forEach(resolve => resolve([]));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(service.selectionTopic.getValue()).toEqual([]);
    });

    it("deduplicates exact identities and warns once when logical hits exceed capacity", () => {
        const { service, panels, infoMessageService } = createHarness(2);
        const result = service.inspectFeatureIds([
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-b/tile"),
            feature("third", "map-c/tile")
        ]);

        expect(result).toEqual({ foundFeatureCount: 3, inspectedFeatureCount: 2 });
        expect(panels().map(panel => panel.features[0])).toEqual([
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-b/tile")
        ]);
        expect(infoMessageService.showWarning).toHaveBeenCalledOnce();
        expect(infoMessageService.showWarning).toHaveBeenCalledWith(
            "Inspecting 2 features out of 3 found features. " +
            "Decrease the selection or increase your max inspections limit to see more."
        );
    });

    it("does not invoke the generic panel-limit path for a single hit when no panel can be reused", () => {
        const lockedPanel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [feature("locked", "map/tile")],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const { service, stateService, infoMessageService } = createHarness(1, [lockedPanel]);

        const result = service.inspectFeatureIds([feature("new", "map/tile")]);

        expect(result).toEqual({ foundFeatureCount: 1, inspectedFeatureCount: 0 });
        expect(stateService.setSelection).not.toHaveBeenCalled();
        expect(infoMessageService.showWarning).toHaveBeenCalledWith(
            "Inspecting 0 features out of 1 found features. " +
            "Decrease the selection or increase your max inspections limit to see more."
        );
    });

    it("uses remaining capacity for hits not already represented by pinned panels", () => {
        const existing = feature("existing", "map/tile");
        const lockedPanel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [existing],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const { service, panels, infoMessageService } = createHarness(2, [lockedPanel]);
        const missing = feature("missing", "map/tile");

        const result = service.inspectFeatureIds([existing, missing]);

        expect(result).toEqual({ foundFeatureCount: 2, inspectedFeatureCount: 2 });
        expect(panels().map(panel => panel.features[0])).toEqual([existing, missing]);
        expect(infoMessageService.showWarning).not.toHaveBeenCalled();
    });

    it("replaces unlocked panels and publishes all Ctrl drill inspections locked in one commit", () => {
        const previousPanel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [feature("previous", "map/tile")],
            locked: false,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const { service, panels, stateService, persistence, layout } = createHarness(3, [previousPanel]);
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            panels: panels().map(panel => ({
                feature: panel.features[0].featureId,
                locked: panel.locked
            })),
            dockOpen: layout.state.isDockOpen
        })).subscribe(value => observed.push(value));

        const result = service.inspectFeatureIds([
            feature("first", "map/tile"),
            feature("second", "map/tile")
        ], true);

        expect(result).toEqual({ foundFeatureCount: 2, inspectedFeatureCount: 2 });
        expect(panels().map(panel => panel.locked)).toEqual([true, true]);
        expect(stateService.setInspectionPanelLockedState).toHaveBeenCalledTimes(2);
        expect(observed).toEqual([
            { panels: [{ feature: "previous", locked: false }], dockOpen: false },
            {
                panels: [{ feature: "first", locked: true }, { feature: "second", locked: true }],
                dockOpen: true
            }
        ]);
        subscription.unsubscribe();
    });

    it("publishes an async grouped inspection with its final lock, color and dock state", async () => {
        const { service, panels, persistence, layout } = createHarness(3);
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            panels: panels().map(panel => ({
                features: panel.features.map(selected => selected.featureId),
                locked: panel.locked,
                color: panel.color
            })),
            dockOpen: layout.state.isDockOpen
        })).subscribe(value => observed.push(value));

        const result = await service.inspect({
            features: [feature("first", "map/tile"), feature("second", "map/tile")],
            newPanel: true,
            lock: true,
            color: "#123456"
        });

        expect(result.complete).toBe(true);
        expect(result.panelIds).toHaveLength(1);
        expect(observed).toEqual([
            { panels: [], dockOpen: false },
            {
                panels: [{ features: ["first", "second"], locked: true, color: "#123456" }],
                dockOpen: true
            }
        ]);
        subscription.unsubscribe();
    });

    it("retains a validity hover without loading its selected host feature", () => {
        const selected = feature("Road.7", "Map/Layer/42");
        const validity = feature(
            "Road.7:attribute#2:validity#1",
            selected.mapTileKey
        );
        const loadFeatures = vi.fn(async (): Promise<FeatureWrapper[]> => []);
        const panel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [selected],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const { service } = createHarness(2, [panel], loadFeatures);
        service.selectionIdsTopic.next([panel]);

        service.setHoveredFeatures([validity], true);

        expect(service.hoverIdsTopic.getValue()).toEqual([validity]);
        expect(service.remoteHoverHighlightAllowed).toBe(true);
        expect(loadFeatures).not.toHaveBeenCalled();

        service.setHoveredFeatures([validity]);
        expect(service.remoteHoverHighlightAllowed).toBe(false);

        service.setHoveredFeatures([]);
        expect(service.remoteHoverHighlightAllowed).toBe(false);
    });

    it("does not republish an unchanged hover set", () => {
        const first = feature("Road.7", "Map/Layer/42");
        const second = feature("Road.8", "Map/Layer/42");
        const { service } = createHarness(2);
        const emissions: TileFeatureId[][] = [];
        service.hoverIdsTopic.subscribe(value => emissions.push(value));

        service.setHoveredFeatures([first, second]);
        service.setHoveredFeatures([second, first]);

        expect(emissions).toEqual([[], [first, second]]);
    });
});
