import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AppStateService } from "../../../app/appstate/appstate.service";
import { StateOwners } from '../../support/state-owners';
import { APPLICATION_STORAGE_KEYS } from '../../support/state-storage-keys';
import { MapViewService } from '../../../app/mapview/mapview.service';
import { InspectionSelectionService } from '../../../app/inspection/inspection-selection.service';
import { FeatureWrapper } from '../../../app/mapdata/feature-inspection';
import { Cartographic } from '../../../app/integrations/geo';
import { VIEW_SYNC_POSITION, VIEW_SYNC_PROJECTION } from "../../../app/mapview/mapview.model";

function setup(params: Record<string, unknown> = {}) {
    const messages = { showError: vi.fn(), showWarning: vi.fn() };
    const toasts = { add: vi.fn() };
    const registry = new AppStateService({
        events: new Subject(), navigate: vi.fn().mockResolvedValue(true),
        routerState: { snapshot: { root: { queryParams: params } } }
    } as never, toasts as never);
    const owners = new StateOwners(registry, messages as never);
    return { registry, owners, messages, toasts };
}

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); });

describe('logical view identity', () => {
    it('registers every deployed preference key once, retiring only runtime version metadata', () => {
        const { registry } = setup();
        const retained = APPLICATION_STORAGE_KEYS.filter(key =>
            key !== 'distributionVersions' && key !== 'erdblickVersion');
        expect([...registry.registeredStates.keys()].sort()).toEqual([...retained].sort());
        expect(() => registry.registerState({ name: 'late', defaultValue: false, schema: {} as never })).toThrow('closed');
    });

    it.each(['url', 'storage'])('starts one view from legacy %s values with trailing old view entries', async source => {
        localStorage.setItem('marker', '1');
        if (source === 'url') {
            window.history.replaceState({}, '', '?osm=0~6,0~6&lon=42.5&lat=11.615&alt=500&h=0.02&p=-0.75&r=0');
        } else {
            localStorage.setItem('osm', JSON.stringify(['0~6', '1~45']));
            localStorage.setItem('cameraView', JSON.stringify([
                { lon: 42.5, lat: 11.615, alt: 500, h: 0.02, p: -0.75, r: 0 },
                { lon: 99, lat: 50, alt: 800 }
            ]));
            localStorage.setItem('layerNames', JSON.stringify(['Map/Lane']));
            localStorage.setItem('visibility', JSON.stringify([[false], [true]]));
            localStorage.setItem('STY0~0~active', '0:1');
        }
        const { registry, owners: { viewSettings: views, coordinates, layerState: layers }, toasts } = setup();
        try {
            expect(() => registry.initializePersistence()).not.toThrow();
            expect(registry.ready.value).toBe(true);
            expect(views.numViews).toBe(1);
            expect(views.viewIds).toHaveLength(1);
            expect(views.getBackgroundState(0)).toEqual({ layerId: null, opacity: 6 });
            expect(views.cameraViewDataState.getValue(0)).toEqual({
                destination: { lon: 42.5, lat: 11.615, alt: 500 },
                orientation: { heading: 0.02, pitch: -0.75, roll: 0 },
                position: [0, 0, 0]
            });
            expect(coordinates.state.marker).toBe(true);
            expect(toasts.add).not.toHaveBeenCalled();
            expect(() => views.setBackgroundState(1, 'osm', 50)).toThrow('unavailable');
            if (source === 'storage') {
                expect(layers.layerVisibilityState.getValue(0)).toEqual([false]);
                expect(layers.styles.get('Map/Lane/STY0/active')).toEqual(['0']);
            }
            await Promise.resolve();
            expect(JSON.parse(localStorage.getItem('background')!)).toEqual(['~6']);
            expect(JSON.parse(localStorage.getItem('numberOfViews')!)).toBe(1);
        } finally {
            registry.ngOnDestroy();
        }
    });

    it('ignores legacy URL background values after rejecting its explicit view identities', () => {
        localStorage.setItem('viewIds', '["saved-view"]');
        localStorage.setItem('numberOfViews', '1');
        localStorage.setItem('osm', JSON.stringify(['1~27', '0~40']));
        localStorage.setItem('cameraView', JSON.stringify([{ lon: 7, lat: 8, alt: 900 }]));
        const { registry, owners: { viewSettings: views }, toasts } = setup({
            n: '2', vid: 'duplicate,duplicate', osm: '0~6', lon: '42.5'
        });
        try {
            expect(() => registry.initializePersistence()).not.toThrow();
            expect(registry.ready.value).toBe(true);
            expect(views.viewIds).toEqual(['saved-view']);
            expect(views.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 27 });
            expect(views.cameraViewDataState.getValue(0).destination).toEqual({ lon: 7, lat: 8, alt: 900 });
            expect(toasts.add).toHaveBeenCalled();
        } finally {
            registry.ngOnDestroy();
        }
    });

    it('preserves scalar and per-view boolean storage codecs independently of compact URL encoding', () => {
        const { registry, owners: { coordinates, viewSettings: views, layerState: layers } } = setup();
        views.numViews = 2;
        coordinates.setMarker({ enabled: true, position: null });
        views.mode2dState.next(0, true);
        views.mode2dState.next(1, false);
        layers.layerNames = ['Map/Lane', 'Map/Road'];
        layers.layerVisibilityState.next(0, [true, false]);
        layers.layerVisibilityState.next(1, [false, true]);
        const snapshot = registry.exportSnapshot();
        expect(snapshot['marker']).toBe(1);
        expect(snapshot['mode2d']).toEqual([true, false]);
        expect(snapshot['visibility']).toEqual([[true, false], [false, true]]);
        expect(coordinates.state.markerState.serialize(false)).toEqual({ marker: '1' });
        expect(views.mode2dState.appState.serialize(false)).toEqual({ mode2d: '[true,false]' });
        expect(layers.layerVisibilityState.appState.serialize(false)).toEqual({ visibility: '[[true,false],[false,true]]' });
        expect(views.mode2dState.appState.serialize(true)).toEqual({ m2d: '1,0' });
        expect(layers.layerVisibilityState.appState.serialize(true)).toEqual({ v: '1,0:0,1' });
        coordinates.setMarkerState(false);
        expect(registry.exportSnapshot()['marker']).toBe(0);
    });

    it('keeps camera, layers, options, focus and search associations through reorder', () => {
        const { registry, owners: { viewSettings: views, layerState: layers, searchService: searches, inspectionState: inspections, layout } } = setup();
        views.numViews = 2;
        const [first, second] = views.viewIds;
        const firstCamera = { ...views.cameraViewDataState.getValue(first), position: [1, 2, 3] as [number, number, number] };
        views.cameraViewDataState.next(first, firstCamera);
        layers.layerNames = ['Map/Lane'];
        layers.layerVisibilityState.next(first, [true]);
        layers.layerVisibilityState.next(second, [false]);
        layers.setStyleOptionValues('Map', 'Lane', 'STY0', 'active', [true, false]);
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: [0] });
        inspections.setSelection([{ mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1' }]);
        const inspectionBefore = inspections.state.selection;
        layout.state.viewPanelSizesState.next([30, 70]);
        views.focusedView = 0;
        const observations: unknown[] = [];
        registry.observe(() => ({
            ids: views.viewIds, focus: views.focusedView,
            camera: views.cameraViewDataState.getValue(views.viewIdAt(0)), visible: layers.layerVisibilityState.getValue(0)
        }))
            .subscribe(value => observations.push(value));
        views.retainViews([1, 0], new Map());
        expect(views.viewIds).toEqual([second, first]);
        expect(views.focusedView).toBe(1);
        expect(views.cameraViewDataState.getValue(first)).toEqual(firstCamera);
        expect(layers.layerVisibilityState.getValue(first)).toEqual([true]);
        expect(layers.stylesState.value.get('Map/Lane/STY0/active')).toEqual({ [first]: true, [second]: false });
        expect(searches.state.featureSearchState.value[0].selectedViewIds).toEqual([first]);
        expect(searches.state.featureSearches[0].selectedViewIndices).toEqual([1]);
        expect(inspections.state.selection).toBe(inspectionBefore);
        expect(layout.state.viewPanelSizesState.value).toEqual([30, 70]);
        expect(observations).toHaveLength(2);
    });

    it.each(['snapshot', 'url'])('imports reordered identities through membership owners: %s', format => {
        const { registry, owners: { viewSettings: views, layerState: layers, searchService: searches, url } } = setup();
        views.importViews(['first', 'second']);
        const camera = { ...views.cameraViewDataState.getValue('first'), destination: { lon: 11, lat: 48, alt: 300 } };
        views.cameraViewDataState.next('first', camera);
        layers.layerNames = ['Map/Lane'];
        layers.layerVisibilityState.next('first', [true]);
        layers.layerVisibilityState.next('second', [false]);
        layers.setStyleOptionValues('Map', 'Lane', 'STY0', 'active', [true, false]);
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: [0] });
        views.focusedView = 0;
        const observations: unknown[] = [];
        registry.observe(() => registry.exportSnapshot()).subscribe(value => observations.push(value));
        if (format === 'snapshot') expect(registry.importSnapshot({ viewIds: ['second', 'first'] })).toEqual([]);
        else registry.transaction(() => url.hydrate({ vid: 'second,first' }));
        expect(views.viewIds).toEqual(['second', 'first']);
        expect(views.focusedView).toBe(1);
        expect(views.cameraViewDataState.getValue('first')).toEqual(camera);
        expect(layers.layerVisibilityState.getValue('first')).toEqual([true]);
        expect(layers.stylesState.value.get('Map/Lane/STY0/active')).toEqual({ first: true, second: false });
        expect(searches.state.featureSearchState.value[0].selectedViewIds).toEqual(['first']);
        expect(observations).toHaveLength(2);
        registry.ngOnDestroy();
    });

    it('preserves omitted positional values but prunes removed search associations during snapshot replacement', () => {
        const { registry, owners: { viewSettings: views, layerState: layers, searchService: searches } } = setup();
        views.importViews(['first', 'second']);
        const camera = { ...views.cameraViewDataState.getValue('first'), destination: { lon: 11, lat: 48, alt: 300 } };
        views.cameraViewDataState.next('first', camera);
        layers.layerNames = ['Map/Lane'];
        layers.layerVisibilityState.next('first', [false]);
        layers.setStyleOptionValues('Map', 'Lane', 'STY0', 'active', [true, false]);
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: [0] });
        expect(registry.importSnapshot({ viewIds: ['replacement', 'second'] })).toEqual([]);
        expect(views.cameraViewDataState.getValue('replacement')).toEqual(camera);
        expect(layers.layerVisibilityState.getValue('replacement')).toEqual([false]);
        expect(layers.stylesState.value.get('Map/Lane/STY0/active')).toEqual({ replacement: true, second: false });
        expect(searches.state.featureSearchState.value[0].selectedViewIds).toEqual([]);
        expect(registry.importSnapshot({ viewIds: ['first', 'second'] })).toEqual([]);
        expect(searches.state.featureSearchState.value[0].selectedViewIds).toEqual([]);
        registry.ngOnDestroy();
    });

    it('resets omitted owner values during a full snapshot replacement', () => {
        const { registry, owners: { viewSettings: views, layerState: layers, searchService: searches } } = setup();
        registry.initializePersistence();
        const defaultCamera = views.cameraViewDataState.getValue(0);
        views.importViews(['first', 'second']);
        views.cameraViewDataState.next('first', { ...defaultCamera, destination: { lon: 11, lat: 48, alt: 300 } });
        layers.layerNames = ['Map/Lane'];
        layers.layerVisibilityState.next('first', [false]);
        layers.setStyleOptionValues('Map', 'Lane', 'STY0', 'active', [true, false]);
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: [0] });
        expect(registry.replaceSnapshotState({ viewIds: ['replacement'] })).toEqual([]);
        expect(views.viewIds).toEqual(['replacement']);
        expect(views.cameraViewDataState.getValue(0)).toEqual(defaultCamera);
        expect(layers.layerNames).toEqual([]);
        expect(layers.stylesState.value.size).toBe(0);
        // Search definitions are intentionally outside snapshots; their removed view references are pruned.
        expect(searches.state.featureSearchState.value[0].selectedViewIds).toEqual([]);
        registry.ngOnDestroy();
    });

    it('publishes ordinary synchronized camera and projection methods once each', () => {
        const { registry, owners: { viewSettings: views } } = setup();
        views.importViews(['first', 'second', 'third']);
        views.viewSync = [VIEW_SYNC_POSITION, VIEW_SYNC_PROJECTION];
        const observations: unknown[] = [];
        registry.observe(() => views.viewIds.map(id => ({ camera: views.cameraViewDataState.getValue(id), mode2d: views.mode2dState.getValue(id) })))
            .subscribe(value => observations.push(value));
        views.setView(0, Cartographic.fromDegrees(11, 48, 300));
        expect(observations).toHaveLength(2);
        const cameras = views.viewIds.map(id => views.cameraViewDataState.getValue(id));
        expect(cameras.every(camera => camera.destination.lon === 11 && camera.destination.lat === 48)).toBe(true);
        views.setProjectionMode(0, true);
        expect(observations).toHaveLength(3);
        expect(views.viewIds.map(id => views.mode2dState.getValue(id))).toEqual([true, true, true]);
        registry.ngOnDestroy();
    });

    it.each([true, false])('new views inherit selected search membership from their source: %j', selected => {
        const { owners: { viewSettings: views, searchService: searches } } = setup();
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: selected ? [0] : [] });
        views.numViews = 2;
        const removed = views.viewIdAt(1);
        expect(searches.state.featureSearches[0].selectedViewIndices).toEqual(selected ? [0, 1] : []);
        views.retainViews([0], new Map());
        views.numViews = 2;
        expect(views.viewIdAt(1)).not.toBe(removed);
        expect(searches.state.featureSearchState.value[0].selectedViewIds).not.toContain(removed);
        expect(searches.state.featureSearches[0].selectedViewIndices).toEqual(selected ? [0, 1] : []);
    });

    it.each([false, true])('copies the chosen source into a third view with search membership=%s', selected => {
        const { registry, owners: { viewSettings: views, layerState: layers, searchService: searches } } = setup();
        views.numViews = 2;
        const [source, other] = views.viewIds;
        layers.materializeLayerDefaults('Map', 'Lane');
        layers.layerVisibilityState.next(source, [true]);
        layers.layerVisibilityState.next(other, [false]);
        layers.stylesState.next(new Map([['Map/Lane/style/labels', { [source]: true, [other]: false }]]));
        searches.state.addFeatureSearch({ query: 'true', selectedViewIndices: selected ? [0] : [1] });
        const added = views.addView(source);
        expect(views.cameraViewDataState.getValue(added)).toEqual(views.cameraViewDataState.getValue(source));
        expect(layers.layerVisibilityState.getValue(added)).toEqual([true]);
        expect(layers.stylesState.value.get('Map/Lane/style/labels')?.[added]).toBe(true);
        expect(searches.state.featureSearchState.value[0].selectedViewIds.includes(added)).toBe(selected);
        registry.ngOnDestroy();
    });

    it('rejects old async targets after removing and restoring the same URL ID', () => {
        const { registry, owners } = setup();
        const views = new MapViewService(registry, { layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() { }, maps: { maps: new Map() } } as never,
            owners.viewSettings, owners.configService);
        owners.viewSettings.numViews = 2;
        const id = owners.viewSettings.viewIdAt(0);
        const old = { viewId: id, viewIndex: 0, isAvailable: () => true };
        const unregisterOld = views.registerRenderView(old as never);
        const token = views.captureView(id)!;
        owners.viewSettings.retainViews([1], new Map());
        registry.transaction(() => owners.url.hydrate({ v2: '1', n: '2', vid: `${id},restored-other` }));
        const replacement = { viewId: id, viewIndex: 0, isAvailable: () => true };
        views.registerRenderView(replacement as never);
        unregisterOld();
        expect(views.renderViewFor(id)).toBe(replacement);
        expect(views.resolveCapturedView(token)).toBeUndefined();
        expect(views.resolveCapturedView(views.captureView(id)!)).toBe(replacement);
    });

    it.each(['reorder', 'restore'])('revalidates feature-navigation targets after an asynchronous load: %s', async operation => {
        const { registry, owners, messages } = setup();
        owners.viewSettings.numViews = 2;
        const views = new MapViewService(registry, {
            layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() { },
            maps: { maps: new Map() }
        } as never, owners.viewSettings, owners.configService);
        const id = owners.viewSettings.viewIdAt(0);
        owners.viewSettings.viewIds.forEach(viewId => views.registerRenderView({ viewId, isAvailable: () => true } as never));
        let finish!: (features: FeatureWrapper[]) => void;
        const inspection = new InspectionSelectionService(registry, { loadFeatures: () => new Promise(resolve => finish = resolve) } as never,
            views, { registerShortcut() { } } as never, messages as never, { run: (callback: () => void) => callback() } as never,
            owners.inspectionState, owners.viewSettings);
        vi.spyOn(inspection, 'featureSetZoomTarget').mockReturnValue({ x: 1, y: 2, z: 300 });
        const moves: unknown[] = [];
        views.moveToWgs84PositionTopic.subscribe(move => moves.push(move));
        const pending = inspection.focusOnFeature(0, { mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1' });
        if (operation === 'reorder') owners.viewSettings.retainViews([1, 0], new Map());
        else {
            owners.viewSettings.retainViews([1], new Map());
            registry.transaction(() => owners.url.hydrate({ v2: '1', n: '2', vid: `${id},other` }));
            views.registerRenderView({ viewId: id, isAvailable: () => true } as never);
        }
        finish([{} as FeatureWrapper]);
        await pending;
        expect(moves).toEqual(operation === 'reorder' ? [{ targetView: 1, x: 1, y: 2, z: 300 }] : []);
    });

    it.each([true, false])('preserves unspecified feature-navigation targets and focused fallback: matches=%s', async matches => {
        const { registry, owners, messages } = setup();
        owners.viewSettings.numViews = 3;
        owners.viewSettings.focusedView = 1;
        const views = new MapViewService(registry, {
            layerStateChanged: new Subject(), reapplySyncOptionsForAllViews() { },
            maps: { maps: new Map() }
        } as never, owners.viewSettings, owners.configService);
        owners.viewSettings.viewIds.forEach(viewId => views.registerRenderView({ viewId, isAvailable: () => true } as never));
        vi.spyOn(views, 'showsFeatureSearchTileInView').mockImplementation(index => matches && index !== 1);
        const wrapper = { featureTile: { tileId: 1, mapName: 'Map', layerName: 'Lane' } } as FeatureWrapper;
        const inspection = new InspectionSelectionService(registry, { loadFeatures: async () => [wrapper] } as never,
            views, { registerShortcut() { } } as never, messages as never, { run: (callback: () => void) => callback() } as never,
            owners.inspectionState, owners.viewSettings);
        vi.spyOn(inspection, 'featureSetZoomTarget').mockReturnValue({ x: 1, y: 2, z: 300 });
        const targets: number[] = [];
        views.moveToWgs84PositionTopic.subscribe(move => targets.push(move.targetView));
        await inspection.focusOnFeature(undefined, { mapTileKey: 'Features:Map:Lane:1', featureId: 'Road.1' });
        expect(targets).toEqual(matches ? [0, 2] : [1]);
    });

    it.each([{}, { external: 'keep' }, { lon: '12,13' }])('preserves omitted storage values under a partial legacy URL: %j', params => {
        localStorage.setItem('numberOfViews', '2');
        localStorage.setItem('viewIds', JSON.stringify(['old-a', 'old-b']));
        localStorage.setItem('cameraView', JSON.stringify([{ lon: 1, lat: 40, alt: 111 }, { lon: 2, lat: 50, alt: 222 }]));
        localStorage.setItem('layerNames', JSON.stringify(['Map/Lane']));
        localStorage.setItem('visibility', JSON.stringify([[true], [false]]));
        localStorage.setItem('zoomLevel', JSON.stringify([[10], [12]]));
        localStorage.setItem('STY0~0~active', '1:0');
        const { registry, owners: { viewSettings: views, layerState: layers } } = setup(params);
        registry.initializePersistence();
        expect(views.viewIds).toHaveLength(2);
        expect(views.viewIds).toEqual(['old-a', 'old-b']);
        expect(views.cameraViewDataState.getValue(0).destination).toMatchObject({ lat: 40, alt: 111 });
        expect(views.cameraViewDataState.getValue(1).destination).toMatchObject({ lat: 50, alt: 222 });
        expect(layers.layerVisibilityState.getValue(0)).toEqual([true]);
        expect(layers.layerVisibilityState.getValue(1)).toEqual([false]);
        expect(layers.layerZoomLevelState.getValue(1)).toEqual([12]);
        expect(layers.styles.get('Map/Lane/STY0/active')).toEqual(['1', '0']);
        registry.ngOnDestroy();
    });

    it('retains identity and omitted values across partial legacy navigation, extending only new views', () => {
        const { registry, owners: { viewSettings: views, layerState: layers, url } } = setup();
        views.importViews(['first', 'second']);
        views.cameraViewDataState.next('second', { ...views.cameraViewDataState.getValue('second'), destination: { lon: 11, lat: 22, alt: 33 } });
        layers.layerNamesState.next(['Map/Lane']);
        layers.layerVisibilityState.next('second', [false]);
        registry.transaction(() => url.hydrate({ n: '3', lon: '1,2,3' }));
        expect(views.viewIds.slice(0, 2)).toEqual(['first', 'second']);
        expect(views.cameraViewDataState.getValue('second').destination).toEqual({ lon: 2, lat: 22, alt: 33 });
        expect(layers.layerVisibilityState.getValue('second')).toEqual([false]);
        const replacement = url.prepareUrl({ n: '2' }, true);
        expect(replacement['vid'].split(',')).not.toContain('first');
    });

    it.each(['startup', 'partial', 'replacement'])('derives membership count from explicit IDs without n during %s', async mode => {
        localStorage.setItem('numberOfViews', '1');
        localStorage.setItem('viewIds', '["saved"]');
        const { registry, owners: { viewSettings: views, url } } = setup(mode === 'startup' ? { vid: 'first,second' } : {});
        registry.initializePersistence();
        if (mode === 'partial') registry.transaction(() => url.hydrate({ vid: 'first,second' }));
        if (mode === 'replacement') await registry.replaceUrlState({ vid: 'first,second' }, true);
        expect(views.viewIds).toEqual(['first', 'second']);
        expect(views.numViews).toBe(2);
        registry.ngOnDestroy();
    });

    it.each(['same,same', 'bad!id,other', '__proto__,other', 'constructor,other', 'toString,other', 'one', ['one,two', 'three,four']])('rejects malformed explicit IDs without changing valid state: %j', vid => {
        const { registry, owners } = setup();
        owners.viewSettings.numViews = 2;
        const before = registry.exportSnapshot();
        const events: unknown[] = [];
        registry.observe(() => registry.exportSnapshot()).subscribe(value => events.push(value));
        expect(() => registry.transaction(() => owners.url.hydrate({ v2: '1', n: '2', vid, m2d: '1,1' }))).toThrow();
        expect(registry.exportSnapshot()).toEqual(before);
        expect(events).toHaveLength(1);
    });

    it.each(['{', '["same","same"]', '["constructor"]', '[]', '"not-an-array"'])('recovers corrupt saved identities without losing other saved values: %s', saved => {
        localStorage.setItem('viewIds', saved);
        localStorage.setItem('numberOfViews', '2');
        localStorage.setItem('cameraView', JSON.stringify([{ lon: 11, lat: 48, alt: 300 }, { lon: 12, lat: 49, alt: 400 }]));
        localStorage.setItem('marker', 'true');
        const { registry, owners, messages, toasts } = setup();
        expect(() => registry.initializePersistence()).not.toThrow();
        expect(registry.ready.value).toBe(true);
        expect(new Set(owners.viewSettings.viewIds).size).toBe(2);
        expect(owners.viewSettings.cameraViewDataState.getValue(1).destination).toEqual({ lon: 12, lat: 49, alt: 400 });
        expect(owners.coordinates.state.marker).toBe(true);
        expect(toasts.add).toHaveBeenCalled();
        registry.ngOnDestroy();
    });

    it.each(['{', '0', '100', '"bad"'])('recovers a corrupt saved count while retaining valid identities: %s', count => {
        localStorage.setItem('viewIds', '["saved-first","saved-second"]');
        localStorage.setItem('numberOfViews', count);
        const { registry, owners, messages, toasts } = setup();
        expect(() => registry.initializePersistence()).not.toThrow();
        expect(registry.ready.value).toBe(true);
        expect(owners.viewSettings.viewIds).toEqual(['saved-first', 'saved-second']);
        expect(toasts.add).toHaveBeenCalled();
        registry.ngOnDestroy();
    });

    it('reports invalid startup identities and still completes startup with valid saved state', () => {
        localStorage.setItem('numberOfViews', '2');
        const { registry, owners, messages, toasts } = setup({ n: '2', vid: 'duplicate,duplicate' });
        registry.initializePersistence();
        expect(registry.ready.value).toBe(true);
        expect(new Set(owners.viewSettings.viewIds).size).toBe(2);
        expect(toasts.add).toHaveBeenCalled();
        registry.ngOnDestroy();
    });
});
