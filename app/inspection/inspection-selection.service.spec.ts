import {AppStore} from "../shared/app.store";
import {observeStore} from "../shared/persisted-state";
import {InfoMessageService} from "../shared/info.service";
import {Injector, runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {InspectionSelectionService} from "./inspection-selection.service";
import type {InspectionPanelModel, TileFeatureId} from "./inspection-state.model";

const feature = (featureId: string, mapTileKey: string): TileFeatureId => ({featureId, mapTileKey});

/** Actual persisted owners for assertions about one complete inspection publication. */
function coherentInspectionHarness() {
    const injector = ownerTestInjector([
        {provide: ViewLayerDiagnosticsService, useValue: {}}
    ]);
    const inspections = injector.get(AppStore);
    const service = runInInjectionContext(injector, () => new InspectionSelectionService(
        {parseMapPartitionKeySafe: () => ["Map", "Layer", 42]} as never,
        {} as never,
        {registerShortcut() {}} as never,
        {showWarning() {}} as never,
        {run: (callback: () => unknown) => callback()} as never
    ));
    const observed: unknown[] = [];
    const subscription = observeStore(inspections, state => state.inspection.selection).subscribe(panels => observed.push({
        features: panels.map(panel => panel.features.map(item => item.featureId)),
        locked: panels.map(panel => panel.locked),
        colors: panels.map(panel => panel.color),
        dockOpen: inspections.layout.dockOpen()
    }));
    return {service, inspections, observed, subscription};
}

function createHarness(
    limit: number,
    initialPanels: InspectionPanelModel<TileFeatureId>[] = [],
    loadFeatures = vi.fn(async () => [] as FeatureWrapper[])
) {
    const infoMessageService = {showWarning: vi.fn()} as unknown as InfoMessageService;
    const injector = ownerTestInjector([
        {provide: InfoMessageService, useValue: infoMessageService},
        {provide: ViewLayerDiagnosticsService, useValue: {}}
    ]);
    const store = injector.get(AppStore);
    store.setInspectionsLimit(limit);
    store.setSelectionValue(initialPanels);
    const service = runInInjectionContext(injector, () => new InspectionSelectionService(
        {loadFeatures} as never, {} as never, {registerShortcut: vi.fn()} as never,
        infoMessageService, {run: (callback: () => unknown) => callback()} as never
    ));
    return {
        service,
        stateService: store,
        infoMessageService,
        loadFeatures,
        panels: () => store.inspection.selection()
    };
}

describe("InspectionSelectionService multi-inspection", () => {
    it("publishes a direct multi-inspection with all requested locks and the dock together", () => {
        const {service, inspections, observed, subscription} = coherentInspectionHarness();
        const priorPanels = inspections.inspection.selection();

        service.inspectFeatureIds([
            feature("first", "Features:Map:Layer:42"),
            feature("second", "Features:Map:Layer:42")
        ], true);

        expect(observed).toEqual([
            {features: [], locked: [], colors: [], dockOpen: false},
            {features: [["first"], ["second"]], locked: [true, true],
                colors: [expect.any(String), expect.any(String)], dockOpen: true}
        ]);
        expect(priorPanels).toEqual([]);
        subscription.unsubscribe();
    });

    it("publishes a resolved grouped inspection with its requested lock and color in one revision", async () => {
        const {service, observed, subscription} = coherentInspectionHarness();

        const result = await service.inspect({
            features: [feature("first", "Features:Map:Layer:42"), feature("second", "Features:Map:Layer:42")],
            newPanel: true,
            lock: true,
            color: "#123456"
        });

        expect(result).toMatchObject({status: "applied", complete: true, panelIds: [0]});
        expect(observed).toEqual([
            {features: [], locked: [], colors: [], dockOpen: false},
            {features: [["first", "second"]], locked: [true], colors: ["#123456"], dockOpen: true}
        ]);
        subscription.unsubscribe();
    });

    it("uses the same native bounds for single/multi-feature fits and unwraps the antimeridian", () => {
        const {service} = createHarness(3);
        const wrapper = (x: number, y = 40) => ({peek: (callback: (value: unknown) => unknown) => callback({
            center: () => ({x, y, z: 10}), boundingRadiusEndPoint: () => ({x, y, z: 10})
        })}) as unknown as FeatureWrapper;
        expect(service.featureSetZoomTarget([wrapper(10)])).toEqual({x: 10, y: 40, z: 110});
        const combined = service.featureSetZoomTarget([wrapper(179.9), wrapper(-179.9)])!;
        expect(combined.x).toBeCloseTo(-180);
        expect(combined.y).toBe(40);
        expect(combined.z).toBeGreaterThan(1000);
        expect(service.featureSetZoomTarget([])).toBeUndefined();
        expect(service.featureSetZoomTarget([wrapper(10), wrapper(NaN)])).toBeUndefined();
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
        const {service} = createHarness(3, initialPanels, loadFeatures);

        service.initialize();

        expect(loadFeatures).toHaveBeenCalledTimes(2);
        expect(service.selectionTopic.getValue().map(panel => ({
            id: panel.id,
            loading: panel.loading,
            featureCount: panel.features.length
        }))).toEqual([
            {id: 0, loading: true, featureCount: 0},
            {id: 1, loading: true, featureCount: 0}
        ]);
        expect(service.selectionIdsTopic.getValue().map(panel => panel.features))
            .toEqual([[first], [second]]);

        resolvers.forEach(resolve => resolve([]));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(service.selectionTopic.getValue()).toEqual([]);
    });

    it("deduplicates exact identities and warns once when logical hits exceed capacity", () => {
        const {service, panels, infoMessageService} = createHarness(2);
        const result = service.inspectFeatureIds([
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-b/tile"),
            feature("third", "map-c/tile")
        ]);

        expect(result).toEqual({foundFeatureCount: 3, inspectedFeatureCount: 2});
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
        const {service, stateService, infoMessageService} = createHarness(1, [lockedPanel]);

        const result = service.inspectFeatureIds([feature("new", "map/tile")]);

        expect(result).toEqual({foundFeatureCount: 1, inspectedFeatureCount: 0});
        expect(stateService.inspection.selection()).toHaveLength(1);
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
        const {service, panels, infoMessageService} = createHarness(2, [lockedPanel]);
        const missing = feature("missing", "map/tile");

        const result = service.inspectFeatureIds([existing, missing]);

        expect(result).toEqual({foundFeatureCount: 2, inspectedFeatureCount: 2});
        expect(panels().map(panel => panel.features[0])).toEqual([existing, missing]);
        expect(infoMessageService.showWarning).not.toHaveBeenCalled();
    });

    it("locks every panel newly opened by a Ctrl drill inspection", () => {
        const {service, panels, stateService} = createHarness(3);

        const result = service.inspectFeatureIds([
            feature("first", "map/tile"),
            feature("second", "map/tile")
        ], true);

        expect(result).toEqual({foundFeatureCount: 2, inspectedFeatureCount: 2});
        expect(panels().map(panel => panel.locked)).toEqual([true, true]);
        expect(stateService.inspection.selection().every(panel => panel.locked)).toBe(true);
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
        const {service} = createHarness(2, [panel], loadFeatures);
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
        const {service} = createHarness(2);
        const emissions: TileFeatureId[][] = [];
        service.hoverIdsTopic.subscribe(value => emissions.push(value));

        service.setHoveredFeatures([first, second]);
        service.setHoveredFeatures([second, first]);

        expect(emissions).toEqual([[], [first, second]]);
    });
});


describe("InspectionSelectionService resource lifetime", () => {
    it("aborts pending feature resolution and cannot publish panels after injector destruction", async () => {
        let resolveLocate!: (features: TileFeatureId[]) => void;
        const pending = new Promise<TileFeatureId[]>(resolve => { resolveLocate = resolve; });
        let signal: AbortSignal | undefined;
        const injector = Injector.create({providers: [AppStore,
            {provide: ViewLayerDiagnosticsService, useValue: {}}
        ]});
        const store = injector.get(AppStore);
        store.initializeViews();
        const service = runInInjectionContext(injector, () => new InspectionSelectionService({
            locateFeature: (_map: string, _feature: string, _layer: string, operationSignal: AbortSignal) => {
                signal = operationSignal;
                return pending;
            }
        } as never, {} as never, {registerShortcut() {}} as never, {} as never,
        {run: (callback: () => unknown) => callback()} as never));
        const operation = service.inspect({features: [{mapId: "Map", featureId: "Road.1"}]});
        const rejected = expect(operation).rejects.toMatchObject({detail: {code: "cancelled"}});
        injector.destroy();
        expect(signal?.aborted).toBe(true);
        resolveLocate([feature("Road.1", "Features:Map:Layer:42")]);
        await rejected;
        expect(store.inspection.selection()).toEqual([]);
        expect(store.layout.dockOpen()).toBe(false);
    });

    it("aborts a pending navigation without focusing or moving a camera after destruction", async () => {
        let resolveLoad!: (features: FeatureWrapper[]) => void;
        const pending = new Promise<FeatureWrapper[]>(resolve => { resolveLoad = resolve; });
        let signal: AbortSignal | undefined;
        const renderer = {
            rendererInvalidated: new Subject<void>(), isFirstPersonViewActive: () => false,
            isCameraInteractionActive: () => false, getLiveCameraState: () => ({camera: "unchanged"})
        };
        const moves = new Subject();
        const moved = vi.fn();
        moves.subscribe(moved);
        const injector = Injector.create({providers: [AppStore,
            {provide: ViewLayerDiagnosticsService, useValue: {cameraInteracting$: new BehaviorSubject(false)}}
        ]});
        const store = injector.get(AppStore);
        store.initializeViews();
        store.setNumViews(2);
        const previousFocus = store.focusedViewId();
        const service = runInInjectionContext(injector, () => new InspectionSelectionService({
            parseMapPartitionKeySafe: () => ["Map", "Layer", 42],
            loadFeatures: (_features: TileFeatureId[], operationSignal: AbortSignal) => {
                signal = operationSignal;
                return pending;
            }
        } as never, {navigationStarted: new Subject<void>(), renderViewFor: () => renderer,
            moveToWgs84PositionTopic: moves, moveToRectangleTopic: moves} as never,
        {registerShortcut() {}} as never, {} as never,
        {run: (callback: () => unknown) => callback()} as never));
        const operation = service.navigate({viewId: store.idAt(1)!,
            target: {features: [feature("Road.1", "Features:Map:Layer:42")]}});
        const rejected = expect(operation).rejects.toMatchObject({detail: {code: "cancelled"}});
        await Promise.resolve();
        expect(signal).toBeDefined();
        injector.destroy();
        expect(signal?.aborted).toBe(true);
        resolveLoad([]);
        await rejected;
        expect(store.focusedViewId()).toBe(previousFocus);
        expect(moved).not.toHaveBeenCalled();
    });
});
