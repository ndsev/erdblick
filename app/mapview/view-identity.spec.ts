import '@angular/compiler';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Subject} from 'rxjs';
import {AppStateService} from '../shared/appstate.service';
import {StateOwners} from '../../test/state-owners';
import {APPLICATION_STORAGE_KEYS} from '../../test/state-storage-keys';
import {MapViewService} from './map-view.service';
import {InspectionSelectionService} from '../inspection/inspection-selection.service';
import {FeatureWrapper} from '../mapdata/feature-inspection.model';

function setup(params: Record<string, unknown> = {}) {
    const messages = {showError: vi.fn(), showWarning: vi.fn()};
    const registry = new AppStateService({events: new Subject(), navigate: vi.fn().mockResolvedValue(true),
        routerState: {snapshot: {root: {queryParams: params}}}} as never, messages as never);
    const owners = new StateOwners(registry, messages as never);
    return {registry, owners, messages};
}

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); });

describe('logical view identity', () => {
    it('registers every deployed storage key once, including local-only owners', () => {
        const {registry} = setup();
        expect([...registry.registeredStates.keys()].sort()).toEqual([...APPLICATION_STORAGE_KEYS].sort());
        expect(() => registry.registerState({name: 'late', defaultValue: false, schema: {} as never})).toThrow('closed');
    });

    it('keeps camera, layers, options, focus and search associations through reorder', () => {
        const {registry, owners: {viewSettings: views, layerState: layers, searchService: searches, inspectionState: inspections, layout}} = setup();
        views.numViews = 2;
        const [first, second] = views.viewIds;
        const firstCamera = {...views.cameraViewDataState.getValue(first), position: [1, 2, 3] as [number, number, number]};
        views.cameraViewDataState.next(first, firstCamera);
        layers.layerNames = ['Map/Lane'];
        layers.layerVisibilityState.next(first, [true]);
        layers.layerVisibilityState.next(second, [false]);
        layers.setStyleOptionValues('Map', 'Lane', 'STY0', 'active', [true, false]);
        searches.addFeatureSearch({query: 'true', selectedViewIndices: [0]});
        inspections.setSelection([{mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1'}]);
        const inspectionBefore = inspections.selection;
        layout.viewPanelSizesState.next([30, 70]);
        views.focusedView = 0;
        const observations: unknown[] = [];
        registry.observe(() => ({ids: views.viewIds, focus: views.focusedView,
            camera: views.cameraViewDataState.getValue(views.viewIdAt(0)), visible: layers.layerVisibilityState.getValue(0)}))
            .subscribe(value => observations.push(value));
        views.retainViews([1, 0], new Map());
        expect(views.viewIds).toEqual([second, first]);
        expect(views.focusedView).toBe(1);
        expect(views.cameraViewDataState.getValue(first)).toEqual(firstCamera);
        expect(layers.layerVisibilityState.getValue(first)).toEqual([true]);
        expect(layers.stylesState.value.get('Map/Lane/STY0/active')).toEqual({[first]: true, [second]: false});
        expect(searches.featureSearchState.value[0].selectedViewIds).toEqual([first]);
        expect(searches.featureSearches[0].selectedViewIndices).toEqual([1]);
        expect(inspections.selection).toBe(inspectionBefore);
        expect(layout.viewPanelSizesState.value).toEqual([30, 70]);
        expect(observations).toHaveLength(2);
    });

    it.each([true, false])('new views inherit selected search membership from their source: %j', selected => {
        const {owners: {viewSettings: views, searchService: searches}} = setup();
        searches.addFeatureSearch({query: 'true', selectedViewIndices: selected ? [0] : []});
        views.numViews = 2;
        const removed = views.viewIdAt(1);
        expect(searches.featureSearches[0].selectedViewIndices).toEqual(selected ? [0, 1] : []);
        views.retainViews([0], new Map());
        views.numViews = 2;
        expect(views.viewIdAt(1)).not.toBe(removed);
        expect(searches.featureSearchState.value[0].selectedViewIds).not.toContain(removed);
        expect(searches.featureSearches[0].selectedViewIndices).toEqual(selected ? [0, 1] : []);
    });

    it('rejects old async targets after removing and restoring the same URL ID', () => {
        const {registry, owners} = setup();
        const views = new MapViewService(registry, {layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() {}, maps: {maps: new Map()}} as never,
            owners.renderPreferences, owners.viewSettings);
        owners.viewSettings.numViews = 2;
        const id = owners.viewSettings.viewIdAt(0);
        const old = {viewId: id, viewIndex: 0, isAvailable: () => true};
        const unregisterOld = views.registerRenderView(old as never);
        const token = views.captureView(id)!;
        owners.viewSettings.retainViews([1], new Map());
        registry.transaction(() => owners.url.hydrate({v2: '1', n: '2', vid: `${id},restored-other`}));
        const replacement = {viewId: id, viewIndex: 0, isAvailable: () => true};
        views.registerRenderView(replacement as never);
        unregisterOld();
        expect(views.renderViewFor(id)).toBe(replacement);
        expect(views.resolveCapturedView(token)).toBeUndefined();
        expect(views.resolveCapturedView(views.captureView(id)!)).toBe(replacement);
    });

    it.each(['reorder', 'restore'])('revalidates feature-navigation targets after an asynchronous load: %s', async operation => {
        const {registry, owners, messages} = setup();
        owners.viewSettings.numViews = 2;
        const views = new MapViewService(registry, {layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() {},
            maps: {maps: new Map()}} as never, owners.renderPreferences, owners.viewSettings);
        const id = owners.viewSettings.viewIdAt(0);
        owners.viewSettings.viewIds.forEach(viewId => views.registerRenderView({viewId, isAvailable: () => true} as never));
        let finish!: (features: FeatureWrapper[]) => void;
        const inspection = new InspectionSelectionService(registry, {loadFeatures: () => new Promise(resolve => finish = resolve)} as never,
            views, {registerShortcut() {}} as never, messages as never, {run: (callback: () => void) => callback()} as never,
            owners.inspectionState, owners.viewSettings);
        vi.spyOn(inspection, 'featureSetZoomTarget').mockReturnValue({x: 1, y: 2, z: 300});
        const moves: unknown[] = [];
        views.moveToWgs84PositionTopic.subscribe(move => moves.push(move));
        const pending = inspection.focusOnFeature(0, {mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1'});
        if (operation === 'reorder') owners.viewSettings.retainViews([1, 0], new Map());
        else {
            owners.viewSettings.retainViews([1], new Map());
            registry.transaction(() => owners.url.hydrate({v2: '1', n: '2', vid: `${id},other`}));
            views.registerRenderView({viewId: id, isAvailable: () => true} as never);
        }
        finish([{} as FeatureWrapper]);
        await pending;
        expect(moves).toEqual(operation === 'reorder' ? [{targetView: 1, x: 1, y: 2, z: 300}] : []);
    });

    it.each([true, false])('preserves unspecified feature-navigation targets and focused fallback: matches=%s', async matches => {
        const {registry, owners, messages} = setup();
        owners.viewSettings.numViews = 3;
        owners.viewSettings.focusedView = 1;
        const views = new MapViewService(registry, {layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() {},
            maps: {maps: new Map()}} as never, owners.renderPreferences, owners.viewSettings);
        owners.viewSettings.viewIds.forEach(viewId => views.registerRenderView({viewId, isAvailable: () => true} as never));
        vi.spyOn(views, 'showsFeatureSearchTileInView').mockImplementation(index => matches && index !== 1);
        const wrapper = {featureTile: {tileId: 1, mapName: 'Map', layerName: 'Lane'}} as FeatureWrapper;
        const inspection = new InspectionSelectionService(registry, {loadFeatures: async () => [wrapper]} as never,
            views, {registerShortcut() {}} as never, messages as never, {run: (callback: () => void) => callback()} as never,
            owners.inspectionState, owners.viewSettings);
        vi.spyOn(inspection, 'featureSetZoomTarget').mockReturnValue({x: 1, y: 2, z: 300});
        const targets: number[] = [];
        views.moveToWgs84PositionTopic.subscribe(move => targets.push(move.targetView));
        await inspection.focusOnFeature(undefined, {mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1'});
        expect(targets).toEqual(matches ? [0, 2] : [1]);
    });

    it.each([{external: 'keep'}, {lon: '12,13'}])('preserves omitted storage values under a partial legacy URL: %j', params => {
        localStorage.setItem('numberOfViews', '2');
        localStorage.setItem('viewIds', JSON.stringify(['old-a', 'old-b']));
        localStorage.setItem('cameraView', JSON.stringify([{lon: 1, lat: 40, alt: 111}, {lon: 2, lat: 50, alt: 222}]));
        localStorage.setItem('layerNames', JSON.stringify(['Map/Lane']));
        localStorage.setItem('visibility', JSON.stringify([[true], [false]]));
        localStorage.setItem('zoomLevel', JSON.stringify([[10], [12]]));
        localStorage.setItem('STY0~0~active', '1:0');
        const {registry, owners: {viewSettings: views, layerState: layers}} = setup(params);
        registry.initializePersistence();
        expect(views.viewIds).toHaveLength(2);
        expect(views.viewIds).not.toEqual(['old-a', 'old-b']);
        expect(views.cameraViewDataState.getValue(0).destination).toMatchObject({lat: 40, alt: 111});
        expect(views.cameraViewDataState.getValue(1).destination).toMatchObject({lat: 50, alt: 222});
        expect(layers.layerVisibilityState.getValue(0)).toEqual([true]);
        expect(layers.layerVisibilityState.getValue(1)).toEqual([false]);
        expect(layers.layerZoomLevelState.getValue(1)).toEqual([12]);
        expect(layers.styles.get('Map/Lane/STY0/active')).toEqual(['1', '0']);
        registry.ngOnDestroy();
    });

    it.each(['same,same', 'bad!id,other', '__proto__,other', 'constructor,other', 'toString,other', 'one', ['one,two', 'three,four']])('rejects malformed explicit IDs without changing valid state: %j', vid => {
        const {registry, owners} = setup();
        owners.viewSettings.numViews = 2;
        const before = registry.exportSnapshot();
        const events: unknown[] = [];
        registry.observe(() => registry.exportSnapshot()).subscribe(value => events.push(value));
        expect(() => registry.transaction(() => owners.url.hydrate({v2: '1', n: '2', vid, m2d: '1,1'}))).toThrow();
        expect(registry.exportSnapshot()).toEqual(before);
        expect(events).toHaveLength(1);
    });

    it('reports invalid startup identities and still completes startup with valid saved state', () => {
        localStorage.setItem('numberOfViews', '2');
        const {registry, owners, messages} = setup({n: '2', vid: 'duplicate,duplicate'});
        registry.initializePersistence();
        expect(registry.ready.value).toBe(true);
        expect(new Set(owners.viewSettings.viewIds).size).toBe(2);
        expect(messages.showError).toHaveBeenCalled();
        registry.ngOnDestroy();
    });
});
