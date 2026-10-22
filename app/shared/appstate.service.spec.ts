import "@angular/compiler";
import {Subject} from 'rxjs';
import {getState} from "@ngrx/signals";
import {observeStore} from "./persisted-state";
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createStateOwners, type StateOwners} from "./state-test-owners";

import type {Event, Router} from '@angular/router';
import {NavigationEnd, NavigationStart} from '@angular/router';
import {Cartographic} from '../integrations/geo';

import {VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../mapview/map-view-state.model";

// @ts-expect-error this is a mock router
interface RouterStub extends Partial<Router> {
    routerState: {
        snapshot: {
            root: {
                queryParams: Record<string, unknown> | null;
            } | null;
        };
    };
    events: Subject<Event>;
    navigate: Router['navigate'];
    getCurrentNavigation: () => ReturnType<Router['getCurrentNavigation']>;
}

const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

const createRouterStub = (queryParams: Record<string, unknown> = {}): RouterStub => {
    return {
        routerState: {
            snapshot: {
                root: {
                    queryParams,
                },
            },
        },
        events: new Subject<Event>(),
        navigate: vi.fn().mockResolvedValue(true) as unknown as Router['navigate'],
        getCurrentNavigation: vi.fn(() => undefined) as unknown as Router['getCurrentNavigation'],
    };
};

const feature = (id: string, mapTileKey = 'map/layer/tile') => ({ featureId: id, mapTileKey });
const sourceData = (mapTileKey = 'SourceData:m1:SourceData-LAYER:1', address?: bigint) => ({ mapTileKey, address });
const infoServiceStub = () => ({
    showError: vi.fn(),
    showSuccess: vi.fn(),
    showWarning: vi.fn(),
    registerDefaultContainer: vi.fn(),
    showAlertDialogDefault: vi.fn()
}) as any;

/** Seed legacy positional style values through the same compatibility projection used by persistence. */
function setTestStyleOptions(owner: StateOwners, value: Map<string, (string | number | boolean)[]>): void {
    const next = owner.persistence.stylesPersistence.replace(getState(owner.store), value);
    owner.store.restorePersistedState(next, "user");
}

/** Seed raw marker coordinates to exercise the released serialization rounding. */
function setTestMarkedPosition(owner: StateOwners, value: number[]): void {
    const next = owner.persistence.descriptor("markedPosition").replace(getState(owner.store), value);
    owner.store.restorePersistedState(next, "user");
}

describe('AppStateService', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
            fontSize: '16px',
        }) as any);
    });

    afterEach(() => {
        window.history.pushState({}, '', '/');
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('hydrates URL state on startup and persists subsequent changes', async () => {
        const routerStub = createRouterStub({ m: '1' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(true);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.store.setMarkerState(false);
        await flushMicrotasks();

        expect(localStorage.getItem('marker')).toBe('0');
        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '0', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.destroy();
        routerStub.events.complete();
    });

    it('restores an explicitly open empty dock and width across reload and unrelated imports', async () => {
        const first = createStateOwners(createRouterStub() as unknown as Router, infoServiceStub());
        first.persistence.initializePersistence();
        first.store.setDockOpen(true);
        first.store.setDockWidth(480);
        await flushMicrotasks();
        expect(localStorage.getItem('dockOpenState')).toBe('1');
        expect(localStorage.getItem('dockWidth')).toBe('480');
        const saved = first.persistence.exportSnapshot();
        first.destroy();

        const restarted = createStateOwners(createRouterStub() as unknown as Router, infoServiceStub());
        try {
            restarted.persistence.initializePersistence();
            await flushMicrotasks();
            expect(restarted.store.inspection.selection()).toEqual([]);
            expect(restarted.store.layout.dockOpen()).toBe(true);
            expect(restarted.store.layout.dockWidth()).toBe(480);
            expect(localStorage.getItem('dockOpenState')).toBe('1');

            expect(restarted.persistence.importSnapshot({marker: 1})).toEqual([]);
            await restarted.persistence.replaceUrlState({v2: '1', m: '0'});
            expect(restarted.store.layout.dockOpen()).toBe(true);
            expect(restarted.store.layout.dockWidth()).toBe(480);

            restarted.store.setSelection([feature('temporary')]);
            expect(restarted.persistence.replaceSnapshotState(saved)).toEqual([]);
            expect(restarted.store.inspection.selection()).toEqual([]);
            expect(restarted.store.layout.dockOpen()).toBe(true);
            expect(restarted.store.layout.dockWidth()).toBe(480);

            restarted.store.setSelection([feature('temporary')]);
            expect(restarted.persistence.importSnapshot({selected: []})).toEqual([]);
            expect(restarted.store.layout.dockOpen()).toBe(false);
        } finally {
            restarted.destroy();
        }
    });

    it('does not rewrite inbound v1 URLs during passive startup hydration', async () => {
        const routerStub = createRouterStub({ m: '1' });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(true);
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('replaces and hydrates URL state through the explicit runtime boundary', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();
        const appliedMarkerValues: boolean[] = [];
        service.persistence.stateApplied.subscribe(() => {
            appliedMarkerValues.push(service.store.views.marker());
        });

        await service.persistence.replaceUrlState({v2: '1', m: '1'});

        expect(routerStub.navigate).toHaveBeenCalledWith([], {
            queryParams: {v2: '1', m: '1'},
            queryParamsHandling: 'replace',
            replaceUrl: true,
        });
        expect(service.store.views.marker()).toBe(true);
        expect(appliedMarkerValues).toEqual([true]);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects explicit URL replacement before persistence is ready', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        await expect(service.persistence.replaceUrlState({v2: '1'})).rejects.toThrow('before AppStateService is ready');
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('clamps the LOD 3 tile threshold', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        expect(service.store.views.lod3TileThreshold()).toBe(128);

        service.store.setLod3TileThreshold(1024);
        expect(service.store.views.lod3TileThreshold()).toBe(1024);

        service.store.setLod3TileThreshold(9999);
        expect(service.store.views.lod3TileThreshold()).toBe(4096);

        service.destroy();
        routerStub.events.complete();
    });

    it('normalizes the persisted subset-render worker preference', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(
            routerStub as unknown as Router,
            infoServiceStub()
        );

        expect(service.store.views.tileSubsetRenderWorkerCount()).toBe(0);

        service.store.setTileSubsetRenderWorkerCount(999);

        expect(service.store.views.tileSubsetRenderWorkerCount()).toBe(32);
        service.destroy();
        routerStub.events.complete();
    });

    it('persists a bounded drill-pick radius without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.store.inspection.drillPickRadius()).toBe(3);

        service.store.setDrillPickRadius(7.8);
        expect(service.store.inspection.drillPickRadius()).toBe(7);

        service.store.setDrillPickRadius(-100);
        expect(service.store.inspection.drillPickRadius()).toBe(1);

        service.store.setDrillPickRadius(100);
        expect(service.store.inspection.drillPickRadius()).toBe(10);
        expect(service.persistence.exportSnapshot()).toHaveProperty('drillPickRadius', 10);
        expect((service as any).url.serializeUrlV2()).not.toHaveProperty('drillPickRadius');

        service.destroy();
        routerStub.events.complete();
    });

    it('persists bounded feature zoom clearance without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.store.views.featureZoomClearanceMeters()).toBe(20);

        service.store.setFeatureZoomClearanceMeters(37.5);
        expect(service.store.views.featureZoomClearanceMeters()).toBe(37.5);

        service.store.setFeatureZoomClearanceMeters(-1);
        expect(service.store.views.featureZoomClearanceMeters()).toBe(0);

        service.store.setFeatureZoomClearanceMeters(101);
        expect(service.store.views.featureZoomClearanceMeters()).toBe(100);
        expect(service.persistence.exportSnapshot()).toHaveProperty(
            'featureZoomClearanceMeters',
            100
        );
        expect((service as any).url.serializeUrlV2()).not.toHaveProperty(
            'featureZoomClearanceMeters'
        );

        service.destroy();
        routerStub.events.complete();
    });

    it.each([
        ['-5', 0],
        ['120', 100],
        ['"not-a-number"', 20]
    ])('normalizes persisted feature zoom clearance %s to %s', async (stored, expected) => {
        localStorage.setItem('featureZoomClearanceMeters', stored);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const routerStub = createRouterStub();
        const service = createStateOwners(
            routerStub as unknown as Router,
            infoServiceStub()
        );

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.featureZoomClearanceMeters()).toBe(expected);
        service.destroy();
        routerStub.events.complete();
    });

    it('enables optional rendering quality effects by default', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        expect(service.store.views.deckAntialiasingEnabled()).toBe(true);
        expect(service.store.views.semanticCompositingEnabled()).toBe(true);
        expect(service.store.views.contactShadingEnabled()).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('persists semantic compositing locally without adding it to shared URLs', async () => {
        localStorage.setItem('semanticCompositingEnabled', '0');
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.semanticCompositingEnabled()).toBe(false);
        expect(service.persistence.descriptor("semanticCompositingEnabled").serialize(getState(service.store), true)).toBeUndefined();

        service.store.setSemanticCompositingEnabled(true);
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('1');

        service.store.setSemanticCompositingEnabled(false);
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('0');
        expect(service.persistence.descriptor("semanticCompositingEnabled").serialize(getState(service.store), true)).toBeUndefined();

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates the focused inspection panel from selection URL state', async () => {
        const routerStub = createRouterStub({ sel: '5~1f~Features:map:layer:tile~feature-1~30:20~abc123~0' });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.focusedInspectionPanelId()).toBe(5);
        expect(service.store.inspection.selection()[0].focused).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates selection from the browser URL before router query params can drop suffixed ids', async () => {
        const encodedSelection =
            '0~0f~Features:Very-Large-Map:Road:220e0770000d:0~Road.545554686.6:attribute%231:validity%230~30:20~fff314~0';
        window.history.pushState({}, '', `/?f=0&sel=${encodedSelection}`);
        const routerStub = createRouterStub({ f: '0' });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()).toHaveLength(1);
        expect(service.store.inspection.selection()[0].features[0]).toEqual({
            mapTileKey: 'Features:Very-Large-Map:Road:220e0770000d:0',
            featureId: 'Road.545554686.6:attribute#1:validity#0'
        });
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates coordinated v2 layer-indexed URL state', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            n: '2',
            map: 'MapA~MapB',
            l: 'Lane:0~Road:1',
            v: '1,0:0,1',
            z: '12,13:14,15',
            az: '1x2:0x2',
            'T93C~0-1~.CenterLines': '1x2:0x2',
            sel: [
                `0~0~F:0:21fa0777000d~${encodeURIComponent('Lane.1:attribute#1')}~30,20~n0`,
                '1~1~SD:1:LaneGeometryLayer-1:21fa0777000e~783783249845~45,32~n3',
            ].join(';'),
        });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.numViews()).toBe(2);
        expect(service.store.layers.layerNames()).toEqual(['MapA/Lane', 'MapB/Road']);
        expect(service.store.layers.layerVisibility()[service.store.idAt(0)!]).toEqual([true, false]);
        expect(service.store.layers.layerVisibility()[service.store.idAt(1)!]).toEqual([false, true]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(0)!]).toEqual([12, 13]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(1)!]).toEqual([14, 15]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(0)!]).toEqual([true, true]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(1)!]).toEqual([false, false]);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('MapA/Lane/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('MapB/Road/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(service.store.inspection.selection()).toEqual([
            {
                id: 0,
                features: [{
                    mapTileKey: 'Features:MapA:Lane:545379780',
                    featureId: 'Lane.1:attribute#1'
                }],
                locked: true,
                size: [30, 20],
                color: '#fff314',
                undocked: false
            },
            {
                id: 1,
                features: [],
                sourceData: {
                    mapTileKey: 'SourceData:MapB:SourceData-LaneGeometryLayer-1:1451349444',
                    address: 783783249845n
                },
                locked: true,
                focused: true,
                size: [45, 32],
                color: '#ff1212',
                undocked: true
            },
        ]);
        expect(service.store.focusedInspectionPanelId()).toBe(1);
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('clears stored inspections when a v2 URL does not contain a selection', async () => {
        localStorage.setItem('selected', JSON.stringify([
            '5~1f~Features:map:layer:tile~feature-1~30:20~abc123~0'
        ]));
        const routerStub = createRouterStub({
            v2: '1',
            map: 'Very-Large-Map',
            l: 'Road:0',
            s: JSON.stringify(['features', '"PROHIBITED"']),
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()).toEqual([]);

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates legacy selection payloads even when a v2 URL marker is present', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            map: 'MapA',
            l: 'Road:0',
            sel: '5~1f~Features:MapA:Road:tile-1:0~Road.1:attribute#0:validity#0~30:20~abc123~0',
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()).toHaveLength(1);
        expect(service.store.inspection.selection()[0].id).toBe(5);
        expect(service.store.inspection.selection()[0].focused).toBe(true);
        expect(service.store.inspection.selection()[0].features[0]).toEqual({
            mapTileKey: 'Features:MapA:Road:tile-1:0',
            featureId: 'Road.1:attribute#0:validity#0',
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates v2 selected feature MapTileKeys through the C++ serializer', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            map: 'Provider%2FSample%20Munich',
            l: 'Road:0',
            sel: '0~0~F:0:545555209~Road.545555209.387~30,20~n0',
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()[0].features[0]).toEqual({
            mapTileKey: 'Features:Provider%2FSample Munich:Road:545555209',
            featureId: 'Road.545555209.387',
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps stored inspections and feature-search state when stale empty URL params exist', async () => {
        localStorage.setItem('selected', JSON.stringify([
            '5~1f~Features:map:layer:tile~feature-1~30:20~abc123~0'
        ]));
        localStorage.setItem('featureSearchState', JSON.stringify([
            {id: 'feature-search-1', query: '**.speed > 80'}
        ]));
        const routerStub = createRouterStub({sel: '', s: '[]'});
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()).toHaveLength(1);
        expect(service.store.inspection.selection()[0].features).toEqual([feature('feature-1', 'Features:map:layer:tile')]);
        expect(service.store.featureSearchEntries()).toHaveLength(1);
        expect(service.store.featureSearchEntries()[0].query).toBe('**.speed > 80');

        service.destroy();
        routerStub.events.complete();
    });

    it('explicitly restores persisted dialogs and panels without waiting for NavigationEnd', async () => {
        localStorage.setItem('dialogLayouts', JSON.stringify({
            'preferences-dialog': {
                position: {left: 10, top: 20},
                size: {width: 400, height: 300},
                open: true
            }
        }));
        localStorage.setItem('dockOpenState', '1');
        localStorage.setItem('dockActiveTabState', JSON.stringify('search'));
        localStorage.setItem('selected', JSON.stringify([
            '7~1f~Features:map:layer:tile~feature-7~30:20~abcdef~0'
        ]));
        localStorage.setItem('featureSearchState', JSON.stringify([
            {id: 'feature-search-7', query: '**.speed > 80'}
        ]));
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.initializePersistence();
        await flushMicrotasks();

        expect(service.persistence.ready.getValue()).toBe(true);
        expect(service.store.isDialogOpen('preferences-dialog')).toBe(true);
        expect(service.store.layout.dockOpen()).toBe(true);
        expect(service.store.layout.dockActiveTab()).toBe('search');
        expect(service.store.inspection.selection()).toHaveLength(1);
        expect(service.store.inspection.selection()[0].id).toBe(7);
        expect(service.store.featureSearchEntries()).toHaveLength(1);
        expect(service.store.featureSearchEntries()[0].id).toBe('feature-search-7');

        service.destroy();
        routerStub.events.complete();
    });

    it('always persists feature-search map-layer selection explicitly', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.initializePersistence();
        service.store.addFeatureSearch({query: '**.speed > 80'});
        await flushMicrotasks();

        const stored = JSON.parse(localStorage.getItem('featureSearchState') ?? '[]');
        expect(stored[0].selectedMapLayers).toEqual([]);
        expect(stored[0].selectedTileLevels).toEqual([]);
        expect(stored[0].selectedViewIndices).toEqual([0]);

        service.destroy();
        routerStub.events.complete();
    });

    it('drops retired omnibox search URL params while preserving unknown params', () => {
        const routerStub = createRouterStub({
            s: JSON.stringify(['features', '**.speed > 80']),
            external: 'keep-me',
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        const params = service.url.serializeUrlV2(true, routerStub.routerState.snapshot.root?.queryParams ?? {});
        expect(params['s']).toBeUndefined();
        expect(params['external']).toBe('keep-me');

        service.destroy();
        routerStub.events.complete();
    });

    it('shares current cameras, layers and selections without copying unknown URL credentials', async () => {
        window.history.pushState({}, '', '/viewer/?access_token=secret&external=private#token');
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        const restoreRouter = createRouterStub();
        let restored: StateOwners | undefined;
        try {
            service.store.setLayerNames(['Map/Lane']);
            service.store.setMapLayerConfig('Map', 'Lane', [{visible: true, level: 13, autoLevel: false}]);
            service.store.setCameraViewData(0, {destination: {lon: 11, lat: 48, alt: 900},
                orientation: {heading: 0, pitch: -0.75, roll: 0}, position: [0, 0, 0]});
            service.store.setSelectionValue([{id: 0, features: [{mapTileKey: 'Features:Map:Lane:545379780', featureId: 'Lane.1'}],
                locked: true, size: [30, 20], color: '#fff314', undocked: false}]);
            const previous = window.location.href;
            const link = new URL(service.url.shareableUrl());
            expect(window.location.href).toBe(previous);
            expect(link.pathname).toBe('/viewer/');
            expect(link.searchParams.has('access_token')).toBe(false);
            expect(link.searchParams.has('external')).toBe(false);
            expect(link.hash).toBe('');
            expect(link.searchParams.get('sel')).toContain('Lane.1');
            expect(routerStub.navigate).not.toHaveBeenCalled();

            window.history.pushState({}, '', link.href);
            restored = createStateOwners(restoreRouter as unknown as Router, infoServiceStub());
            restoreRouter.events.next(new NavigationEnd(1, '/', '/'));
            await flushMicrotasks();
            expect(restored.store.layers.layerNames()).toEqual(['Map/Lane']);
            expect(restored.store.layers.layerVisibility()[restored.store.idAt(0)!]).toEqual([true]);
            expect(restored.store.views.cameraViewData()[restored.store.idAt(0)!]).toEqual(service.store.views.cameraViewData()[service.store.idAt(0)!]);
            expect(restored.store.inspection.selection()[0].features).toEqual(service.store.inspection.selection()[0].features);
        } finally {
            restored?.destroy();
            service.destroy();
            restoreRouter.events.complete();
            routerStub.events.complete();
        }
    });

    it('serializes active and selected-feature layers against one URL layer order', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.store.setLayerNames(['MapA/Lane', 'MapC/POI']);
        service.store.setLayerViewValue("layerVisibility", 0, [true, false]);
        service.store.setLayerViewValue("layerZoomLevel", 0, [12, 15]);
        service.store.setLayerViewValue("layerAutoZoomLevel", 0, [false, false]);
        service.store.setSelectionValue([{
            id: 0,
            features: [{
                mapTileKey: 'Features:MapB:Road:21',
                featureId: 'Road.1',
            }],
            locked: true,
            size: [30, 20],
            color: '#fff314',
            undocked: false,
        }]);

        const params = (service as any).url.serializeUrlV2();
        expect(params).toMatchObject({
            v2: '1',
            map: 'Map:A,B',
            l: 'Lane:0~Road:1',
            v: '1,0',
            z: '12,13',
            az: '0,1',
            sel: '0~0~F:1:21~Road.1~30,20~n0',
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps layers omitted from a v2 URL inactive when the map tree discovers them later', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            map: 'MapA~MapB',
            l: 'Lane:0~Road:1',
            v: '1x2',
            z: '13x2',
            az: '1x2',
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        const config = service.store.initializeMapLayerConfig('Classic-2.5.2-Sample', 'NDS.Classic-BMD');
        expect(config).toEqual([
            {autoLevel: true, visible: false, level: 13},
        ]);
        expect(service.store.layers.layerNames()).toEqual([
            'MapA/Lane',
            'MapB/Road',
            'Classic-2.5.2-Sample/NDS.Classic-BMD',
        ]);
        expect(service.store.layers.layerVisibility()[service.store.idAt(0)!]).toEqual([true, true, false]);

        service.destroy();
        routerStub.events.complete();
    });

    it('serializes an empty active layer list as an authoritative v2 layer list', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.store.setLayerNames(['MapA/Lane']);
        service.store.setLayerViewValue("layerVisibility", 0, [false]);

        const params = (service as any).url.serializeUrlV2();
        expect(params.l).toBe('');
        expect(params.v).toBeUndefined();
        expect(params.z).toBeUndefined();
        expect(params.az).toBeUndefined();

        service.destroy();
        routerStub.events.complete();
    });

    it('cancels pending URL sync before popstate hydration', async () => {
        vi.useFakeTimers();
        const routerStub = createRouterStub({ m: '0' });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        const stateApplied = vi.fn();
        service.persistence.stateApplied.subscribe(stateApplied);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        (service as any).persistence.lastUrlSyncAt = Date.now();
        service.store.setMarkerState(true);
        await flushMicrotasks();
        expect((service as any).persistence.urlSyncHandle).not.toBeNull();
        expect((service as any).persistence.pendingUrlSyncStates.size).toBeGreaterThan(0);

        routerStub.routerState.snapshot.root!.queryParams = { m: '0' };
        // @ts-expect-error this is a call to mock router
        routerStub.getCurrentNavigation.mockReturnValue({ trigger: 'popstate' });
        routerStub.events.next(new NavigationStart(2, '/?m=0'));
        routerStub.events.next(new NavigationEnd(2, '/?m=0', '/?m=0'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(false);
        expect(stateApplied).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(100);
        await flushMicrotasks();
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates marked position from CSV query params', async () => {
        const routerStub = createRouterStub({ mp: '11.141985707869166,48.002375728153766' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.markedPosition()).toEqual([11.14198571, 48.00237573]);

        service.destroy();
        routerStub.events.complete();
    });

    it('serializes marked position to a CSV query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        setTestMarkedPosition(service, [11.141985707869166, 48.002375728153766, 125.123456789]);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                v2: '1',
                mp: '11.14198571,48.00237573,125.12345679',
            }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.destroy();
        routerStub.events.complete();
    });

    it('preserves feature altitude when setting a marker position', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setMarkerPosition(Cartographic.fromDegrees(11.25, 48.5, 127.75));

        expect(service.store.views.markedPosition()).toEqual([11.25, 48.5, 127.75]);
        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates background-layer settings from combined query params', async () => {
        const routerStub = createRouterStub({ n: '2', bg: 'osm~50,world-overview~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(service.store.getBackgroundState(1)).toEqual({ layerId: 'world-overview', opacity: 30 });

        service.destroy();
        routerStub.events.complete();
    });

    it('serializes background-layer settings into a single bg query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.store.setBackgroundState(0, 'osm', 50);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                v2: '1',
                bg: 'osm~50',
            }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.destroy();
        routerStub.events.complete();
    });

    it('migrates legacy osm query params into the new background-layer state', async () => {
        const routerStub = createRouterStub({ n: '2', osm: '1~50,0~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(service.store.getBackgroundState(1)).toEqual({ layerId: null, opacity: 30 });

        service.destroy();
        routerStub.events.complete();
    });

    it('uses the configured default background opacity when a persisted layer no longer exists', async () => {
        const routerStub = createRouterStub({ bg: 'world-overview~100' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        const resolvedState = service.store.resolveBackgroundState(
            0,
            [{
                id: 'osm',
                name: 'OpenStreetMap',
                type: 'xyz',
                urlTemplate: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                attribution: '© OpenStreetMap contributors',
                headers: {},
                defaultOpacity: 6,
                minZoom: 0,
                maxZoom: 19,
                tileSize: 256
            }],
            'osm'
        );

        expect(resolvedState).toEqual({ layerId: 'osm', opacity: 6 });

        service.destroy();
        routerStub.events.complete();
    });

    it('seeds the second view from the primary view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const destination = Cartographic.fromDegrees(11.25, 48.5, 987654);
        const orientation = { heading: 1.25, pitch: -0.75, roll: 0.125 };

        service.store.setView(0, destination, orientation);
        service.store.setProjectionMode(0, true);
        service.store.setLayerSyncOption(0, true);
        service.store.setBackgroundState(0, null, 42);
        service.store.setLayerViewValue("viewTileBorders", 0, false);
        service.store.setLayerViewValue("viewTileGridMode", 0, 'xyz');
        service.store.setLayerViewValue("viewTileGridLevel", 0, 18);
        service.store.setLayerViewValue("viewTileGridAutoLevel", 0, true);
        service.store.setLayerViewValue("viewTileGridColor", 0, '123abc');
        service.store.setLayerViewValue("viewTileGridOpacity", 0, 64);
        service.store.initializeMapLayerConfig('m1', 'layerA', false, 9);
        service.store.setMapLayerConfig('m1', 'layerA', [{ autoLevel: false, visible: true, level: 7 }]);

        service.store.setNumViews(2);

        expect(service.store.numViews()).toBe(2);
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!]).toEqual(service.store.views.cameraViewData()[service.store.idAt(0)!]);
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!]).not.toBe(service.store.views.cameraViewData()[service.store.idAt(0)!]);
        expect(service.store.views.mode2d()[service.store.idAt(1)!]).toBe(true);
        expect(service.store.getLayerSyncOption(1)).toBe(true);
        expect(service.store.getBackgroundState(1)).toEqual({ layerId: null, opacity: 42 });
        expect(service.store.layers.viewTileBorders()[service.store.idAt(1)!]).toBe(false);
        expect(service.store.layers.viewTileGridMode()[service.store.idAt(1)!]).toBe('xyz');
        expect(service.store.layers.viewTileGridLevel()[service.store.idAt(1)!]).toBe(18);
        expect(service.store.layers.viewTileGridAutoLevel()[service.store.idAt(1)!]).toBe(true);
        expect(service.store.layers.viewTileGridColor()[service.store.idAt(1)!]).toBe('123abc');
        expect(service.store.layers.viewTileGridOpacity()[service.store.idAt(1)!]).toBe(64);
        expect(service.store.layers.layerVisibility()[service.store.idAt(1)!]).toEqual([true]);
        expect(service.store.layers.layerVisibility()[service.store.idAt(1)!]).not.toBe(service.store.layers.layerVisibility()[service.store.idAt(0)!]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(1)!]).toEqual([7]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(1)!]).toEqual([false]);

        service.destroy();
        routerStub.events.complete();
    });

    it('copies style option values into the second view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setLayerNames(['m1/layerA']);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [true]);

        service.store.setNumViews(2);

        const stylesMap = service.persistence.stylesPersistence.read(getState(service.store));
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([true, true]);

        service.destroy();
        routerStub.events.complete();
    });

    it.each([0, 1])('retains the other view when view %i is removed', (removed) => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setNumViews(2);
        service.store.setLayerNames(['m1/layerA']);
        for (const index of [0, 1]) {
            service.store.setCameraViewData(index, {
                destination: {lon: 11 + index, lat: 48 + index, alt: 1000 + index},
                orientation: {heading: index, pitch: -0.5, roll: 0},
                position: [index, index + 1, index + 2]
            });
            service.store.setProjectionMode(index, index === 0);
            service.store.setLayerSyncOption(index, index === 1);
            service.store.setBackgroundState(index, index === 0 ? 'osm' : null, 20 + index);
            service.store.setLayerViewValue("layerVisibility", index, [index === 1]);
            service.store.setLayerViewValue("layerZoomLevel", index, [12 + index]);
            service.store.setLayerViewValue("layerAutoZoomLevel", index, [index === 0]);
            service.store.setLayerViewValue("viewTileBorders", index, index === 1);
            service.store.setLayerViewValue("viewTileGridMode", index, index === 0 ? 'nds' : 'xyz');
            service.store.setLayerViewValue("viewTileGridLevel", index, 8 + index);
            service.store.setLayerViewValue("viewTileGridAutoLevel", index, index === 0);
            service.store.setLayerViewValue("viewTileGridColor", index, index === 0 ? '123abc' : 'abcdef');
            service.store.setLayerViewValue("viewTileGridOpacity", index, 30 + index);
            service.store.setMapPresetSelection(index, 'm1', `map-preset-${index}`);
            service.store.setLayerPresetSelection(index, 'm1', 'layerA', {styleId: 'overlay', presetId: `preset-${index}`});
        }
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.2, 0.8]);
        const searches = [[0], [1], [0, 1]].map(selectedViewIndices =>
            service.store.addFeatureSearch({query: 'Way', selectedViewIndices}));
        service.store.setSelection([feature('Way.1')]);
        const selection = service.store.inspection.selection();
        const survivor = 1 - removed;
        // Capture each native per-view record after applying the synchronization
        // policy, then verify that removal retains the selected logical view.
        service.store.setFocusedView(removed);
        service.store.setSynchronization([VIEW_SYNC_POSITION]);
        const records = [
            service.store.views.cameraViewData,
            service.store.views.mode2d,
            service.store.layers.layerSyncOptions,
            service.store.layers.background,
            service.store.layers.layerVisibility,
            service.store.layers.layerZoomLevel,
            service.store.layers.layerAutoZoomLevel,
            service.store.layers.viewTileBorders,
            service.store.layers.viewTileGridMode,
            service.store.layers.viewTileGridLevel,
            service.store.layers.viewTileGridAutoLevel,
            service.store.layers.viewTileGridColor,
            service.store.layers.viewTileGridOpacity,
            service.store.layers.layerPresetSelection,
            service.store.layers.mapPresetSelection,
        ];
        const expected = records.map(record => record()[service.store.idAt(survivor)!]);

        service.store.retainViews([survivor], new Map());

        expect(service.store.numViews()).toBe(1);
        expect(service.store.focusedView()).toBe(0);
        records.forEach((record, index) => {
            expect(Object.values(record())).toEqual([expected[index]]);
        });
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/opacity')).toEqual([survivor ? 0.8 : 0.2]);
        expect(service.store.inspection.selection()).toBe(selection);
        expect(service.store.featureSearchEntries()).toEqual(searches.map(search => ({
            ...search, selectedViewIndices: search.selectedViewIndices.includes(survivor) ? [0] : [],
            selectedViewIds: search.selectedViewIndices.includes(survivor) ? [service.store.viewIds()[0]] : []
        })));
        expect(service.store.views.viewSync()).toEqual([VIEW_SYNC_POSITION]);

        service.store.setNumViews(2);
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!]).toEqual(expected[0]);
        expect(service.store.layers.layerVisibility()[service.store.idAt(1)!]).toEqual(expected[4]);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/opacity')).toEqual(survivor ? [0.8, 0.8] : [0.2, 0.2]);
        service.destroy();
        routerStub.events.complete();
    });

    it('retains sparse defaults and a live camera without propagating synchronization', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setNumViews(3);
        const camera = {...service.store.views.cameraViewData()[service.store.idAt(2)!], position: [1, 2, 3] as [number, number, number]};
        const defaultBackground = service.store.layers.background()[service.store.idAt(2)!];
        service.store.retainViews([0, 2], new Map([[2, camera]]));
        expect(service.store.viewIds().map(id => service.store.layers.background()[id])).toEqual([defaultBackground, defaultBackground]);
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!]).toEqual(camera);
        expect(service.store.views.cameraViewData()[service.store.idAt(0)!].position).not.toEqual(camera.position);
        service.destroy();
        routerStub.events.complete();
    });

    it('writes a style-option batch atomically and emits style state once', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setLayerNames(['m1/layerA']);
        service.store.setNumViews(2);
        const publications = vi.fn();
        const subscription = observeStore(service.store, state => state.layers.options).subscribe(publications);
        publications.mockClear();

        service.store.setStyleOptionValuesBatch([
            {
                mapId: 'm1',
                layerId: 'layerA',
                shortStyleId: 'overlay',
                optionId: 'first',
                values: [true, false]
            },
            {
                mapId: 'm1',
                layerId: 'layerA',
                shortStyleId: 'overlay',
                optionId: 'second',
                values: [true]
            }
        ]);

        subscription.unsubscribe();
        expect(publications).toHaveBeenCalledTimes(1);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/first')).toEqual([true, false]);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/second')).toEqual([true, true]);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects an invalid style-option batch before mutating any option', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setLayerNames(['m1/layerA']);

        expect(() => service.store.setStyleOptionValuesBatch([
            {
                mapId: 'm1',
                layerId: 'layerA',
                shortStyleId: 'overlay',
                optionId: 'valid',
                values: [true]
            },
            {
                mapId: 'missing',
                layerId: 'layer',
                shortStyleId: 'overlay',
                optionId: 'invalid',
                values: [false]
            }
        ])).toThrow("Unknown map layer 'missing/layer'");
        expect(service.persistence.stylesPersistence.read(getState(service.store)).size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('stores qualified layer and map preset selections outside snapshots', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setNumViews(2);

        service.store.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        service.store.setLayerPresetSelection(1, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        service.store.setMapPresetSelection(0, 'Vendor/Map', 'network-topology');

        expect(service.store.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        expect(service.store.getLayerPresetSelection(1, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        expect(service.store.getMapPresetSelection(0, 'Vendor/Map')).toBe('network-topology');
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('stylePresetSelection');
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('mapPresetSelection');

        service.store.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', null);
        expect(service.store.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toBeNull();

        service.destroy();
        routerStub.events.complete();
    });

    it('retires browser-owned map-preset definitions and ignores legacy config state', () => {
        localStorage.setItem('mapPresets', JSON.stringify([{id: 'legacy'}]));
        localStorage.setItem('erdblickConfigDefaultStateMeta', JSON.stringify({
            version: 1,
            sourceHash: 'old',
            entries: {
                mapPresets: {owner: 'user', valueHash: 'old'},
                unrelated: {owner: 'user', valueHash: 'keep'}
            }
        }));
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        const errors = service.persistence.seedConfigDefaultState({mapPresets: [{id: 'legacy'}]}, 'map-preset-config');

        expect(errors).toEqual([]);
        expect(localStorage.getItem('mapPresets')).toBeNull();
        const metadata = JSON.parse(localStorage.getItem('erdblickConfigDefaultStateMeta')!);
        expect(metadata.entries).not.toHaveProperty('mapPresets');
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('mapPresets');

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates legacy unqualified layer-preset selections for unique owner migration', () => {
        localStorage.setItem('stylePresetSelection', JSON.stringify([{
            'Vendor/Map': {
                Lane: 'legacy-lane-preset'
            }
        }]));
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.persistence.initializePersistence();

        expect(service.store.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: '',
            presetId: 'legacy-lane-preset'
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('provides non-URL hover-label defaults for the preview preferences', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.store.inspection.hoverLabelsEnabled()).toBe(true);
        expect(service.store.inspection.hoverLabelFields()).toEqual([{
            expression: "id",
            customExpression: false
        }]);

        const params = (service as any).url.serializeUrlV2();
        expect(JSON.stringify(params)).not.toContain('hoverLabel');

        service.destroy();
        routerStub.events.complete();
    });

    it('seeds each newly added view from the previous view when the view count keeps increasing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setLayerNames(['m1/layerA']);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);

        service.store.setNumViews(2);

        const destination = Cartographic.fromDegrees(7.75, 50.2, 123456);
        const orientation = { heading: 0.5, pitch: -0.4, roll: 0.3 };

        service.store.setNumViews(2);
        service.store.setView(1, destination, orientation);
        service.store.setProjectionMode(1, true);
        service.store.setLayerSyncOption(1, true);
        service.store.setBackgroundState(1, null, 17);
        service.store.setLayerViewValue("viewTileBorders", 1, false);
        service.store.setLayerViewValue("viewTileGridMode", 1, 'xyz');
        service.store.setLayerViewValue("viewTileGridLevel", 1, 20);
        service.store.setLayerViewValue("viewTileGridAutoLevel", 1, true);
        service.store.setLayerViewValue("viewTileGridColor", 1, 'fedcba');
        service.store.setLayerViewValue("viewTileGridOpacity", 1, 71);
        service.store.setMapLayerConfig('m1', 'layerA', [
            { autoLevel: true, visible: true, level: 13 },
            { autoLevel: false, visible: false, level: 5 }
        ]);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5, 0.25]);

        service.store.setNumViews(3);

        expect(service.store.numViews()).toBe(3);
        expect(service.store.views.cameraViewData()[service.store.idAt(2)!]).toEqual(service.store.views.cameraViewData()[service.store.idAt(1)!]);
        expect(service.store.views.cameraViewData()[service.store.idAt(2)!]).not.toBe(service.store.views.cameraViewData()[service.store.idAt(1)!]);
        expect(service.store.views.mode2d()[service.store.idAt(2)!]).toBe(true);
        expect(service.store.getLayerSyncOption(2)).toBe(true);
        expect(service.store.getBackgroundState(2)).toEqual({ layerId: null, opacity: 17 });
        expect(service.store.layers.viewTileBorders()[service.store.idAt(2)!]).toBe(false);
        expect(service.store.layers.viewTileGridMode()[service.store.idAt(2)!]).toBe('xyz');
        expect(service.store.layers.viewTileGridLevel()[service.store.idAt(2)!]).toBe(20);
        expect(service.store.layers.viewTileGridAutoLevel()[service.store.idAt(2)!]).toBe(true);
        expect(service.store.layers.viewTileGridColor()[service.store.idAt(2)!]).toBe('fedcba');
        expect(service.store.layers.viewTileGridOpacity()[service.store.idAt(2)!]).toBe(71);
        expect(service.store.layers.layerVisibility()[service.store.idAt(2)!]).toEqual([false]);
        expect(service.store.layers.layerVisibility()[service.store.idAt(2)!]).not.toBe(service.store.layers.layerVisibility()[service.store.idAt(1)!]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(2)!]).toEqual([5]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(2)!]).toEqual([false]);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.25, 0.25]);

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates selection colors from storage with a leading hash', async () => {
        localStorage.setItem('selected', JSON.stringify(['1~1~Features:map:layer:tile~feature-1~30:20~abc123~0']));
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.inspection.selection()).toHaveLength(1);
        expect(service.store.inspection.selection()[0].color).toBe('#abc123');

        service.destroy();
        routerStub.events.complete();
    });

    it('converts views to degrees when setting a camera view', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const destination = new Cartographic(Math.PI / 2, Math.PI / 4, 500);
        const orientation = { heading: 1, pitch: 2, roll: 3 };

        service.store.setNumViews(2);
        service.store.setView(1, destination, orientation);

        const view = service.store.views.cameraViewData()[service.store.idAt(1)!];
        expect(view.destination).toEqual({ lon: 90, lat: 45, alt: 500 });
        expect(view.orientation).toEqual(orientation);

        service.destroy();
        routerStub.events.complete();
    });

    it('rounds camera state values to 8 decimal places', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const destination = Cartographic.fromDegrees(11.141985707869166, 48.002375728153766, 123.123456789123);
        const orientation = { heading: 1.123456789, pitch: -2.987654321, roll: 3.000000009 };
        const position = [1.123456789, -2.987654321, 3.000000009] as const;

        service.store.setView(0, destination, orientation, position);

        const view = service.store.views.cameraViewData()[service.store.idAt(0)!];
        expect(view.destination).toEqual({
            lon: 11.14198571,
            lat: 48.00237573,
            alt: 123.12345679,
        });
        expect(view.orientation).toEqual({
            heading: 1.12345679,
            pitch: -2.98765432,
            roll: 3.00000001,
        });
        expect(view.position).toEqual([1.12345679, -2.98765432, 3.00000001]);

        const urlState = service.persistence.descriptor("cameraView").serialize(getState(service.store), true);
        expect(urlState).toMatchObject({
            px: '1.12345679',
            py: '-2.98765432',
            pz: '3.00000001'
        });

        const storageState = service.persistence.descriptor("cameraView").serialize(getState(service.store), false);
        const restoredService = createStateOwners(
            createRouterStub() as unknown as Router,
            infoServiceStub
        );
        restoredService.store.restorePersistedState(restoredService.persistence.descriptor("cameraView").deserialize(getState(restoredService.store), storageState!['cameraView']!), "hydration");
        expect(restoredService.store.views.cameraViewData()[restoredService.store.idAt(0)!].position)
            .toEqual([1.12345679, -2.98765432, 3.00000001]);

        service.destroy();
        restoredService.destroy();
        routerStub.events.complete();
    });

    it('defaults legacy camera state to a zero map-centre offset', async () => {
        const routerStub = createRouterStub({
            lon: '11.5',
            lat: '48.25',
            alt: '1000',
            h: '0.5',
            p: '-0.75',
            r: '0'
        });
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.cameraViewData()[service.store.idAt(0)!].position).toEqual([0, 0, 0]);

        service.destroy();
        routerStub.events.complete();
    });

    it('synchronizes the complete target-relative camera position across views', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setNumViews(2);
        service.store.setFocusedView(0);
        const orientation = {heading: 0.25, pitch: -0.5, roll: 0};

        service.store.setView(
            0,
            Cartographic.fromDegrees(11, 48, 1000),
            orientation,
            [0, 0, 125]
        );
        service.store.setView(
            1,
            Cartographic.fromDegrees(12, 49, 2000),
            orientation,
            [0, 0, 250]
        );

        service.store.setSynchronization([VIEW_SYNC_POSITION]);
        service.store.setView(
            0,
            Cartographic.fromDegrees(13, 50, 3000),
            orientation,
            [0, 0, 375]
        );
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!].position).toEqual([0, 0, 375]);

        service.store.setSynchronization([VIEW_SYNC_MOVEMENT]);
        service.store.setView(
            0,
            Cartographic.fromDegrees(14, 51, 4000),
            orientation,
            [0, 0, 500]
        );
        expect(service.store.views.cameraViewData()[service.store.idAt(0)!].position).toEqual([0, 0, 500]);
        expect(service.store.views.cameraViewData()[service.store.idAt(1)!].position).toEqual([0, 0, 375]);

        service.destroy();
        routerStub.events.complete();
    });

    it('throttles rapid URL sync updates to avoid flooding router history operations', async () => {
        vi.useFakeTimers();
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.store.setMarkerState(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.store.setMarkerState(false);
        await flushMicrotasks();
        service.store.setMarkerState(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(400);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(2);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.destroy();
        routerStub.events.complete();
    });

    it('stores style parameters as URL state-friendly payloads', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // Prepare one layer so style options can be encoded
        service.store.setLayerNames(['m1/layerA']);
        service.store.setLayerViewValue("layerVisibility", 0, [true]);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        // Set two options for style 'overlay'
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [false]);
        await flushMicrotasks();

        // Expect StyleState internal map to contain entries for both options
        const stylesMap = service.persistence.stylesPersistence.read(getState(service.store));
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([false]);
        expect(localStorage.getItem('overlay~0~opacity~debug')).toBe('0.5~0');
        expect(localStorage.getItem('styleOptions')).toBeNull();

        // Expect URL sync to use compact style option encoding
        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                v2: '1',
                'overlay~0~opacity~debug': '0.5~0',
            }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates compact style option entries from localStorage', async () => {
        localStorage.setItem('layerNames', JSON.stringify(['m1/layerA']));
        localStorage.setItem('overlay~0~opacity', '0.5');

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/opacity')).toEqual(['0.5']);

        service.destroy();
        routerStub.events.complete();
    });

    it('initializes layer config with fallback values when first requested', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const config = service.store.initializeMapLayerConfig('m1', 'layerA', false, 9);

        expect(config).toEqual([
            { autoLevel: true, visible: false, level: 9 },
        ]);
        expect(service.store.layers.layerNames()).toEqual(['m1/layerA']);
        expect(service.store.layers.layerVisibility()[service.store.idAt(0)!]).toEqual([false]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(0)!]).toEqual([9]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(0)!]).toEqual([true]);
        expect(service.store.layers.viewTileBorders()[service.store.idAt(0)!]).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        // Prime internal state so indices exist before updating.
        service.store.initializeMapLayerConfig('m2', 'layerB');

        service.store.setMapLayerConfig('m2', 'layerB', [{ autoLevel: false, visible: false, level: 7 }]);

        const config = service.store.mapLayerConfig('m2', 'layerB');

        expect(config).toEqual([
            { autoLevel: false, visible: false, level: 7 },
        ]);
        expect(service.store.layers.layerNames()).toEqual(['m2/layerB']);
        expect(service.store.layers.layerVisibility()[service.store.idAt(0)!]).toEqual([false]);
        expect(service.store.layers.layerZoomLevel()[service.store.idAt(0)!]).toEqual([7]);
        expect(service.store.layers.layerAutoZoomLevel()[service.store.idAt(0)!]).toEqual([false]);
        expect(service.store.layers.viewTileBorders()[service.store.idAt(0)!]).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('reuses the last unlocked feature inspection and closes other unlocked feature inspections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('old-docked')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('locked-feature')], locked: true, size: [30, 20], color: '#333333', undocked: false },
            {
                id: 4,
                features: [],
                sourceData: sourceData('SourceData:m1:SourceData-LAYER:99'),
                locked: false,
                size: [30, 40],
                color: '#444444',
                undocked: true,
            },
        ]);

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.store.setSelection(selected);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(2);
        expect(panels).toHaveLength(3);
        expect(panels.find(panel => panel.id === 1)).toBeUndefined();
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 3)?.features).toEqual([feature('locked-feature')]);
        expect(panels.find(panel => panel.id === 4)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:99'));

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps other unlocked feature inspections when selection targets a specific panel id', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('old-first')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-second')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.store.setSelection(selected, 1);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(1);
        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 1)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual([feature('old-second')]);

        service.destroy();
        routerStub.events.complete();
    });

    it('replaces an unlocked inspection dialog when it is the only unlocked feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.store.setSelection(selected);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(2);
        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 2)?.undocked).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('creates a new docked inspection panel when no unlocked panels or dialogs exist', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('locked-dialog')], locked: true, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.store.setSelection(selected);
        const panels = service.store.inspection.selection();
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(panels).toHaveLength(3);
        expect(newPanel?.features).toEqual(selected);
        expect(newPanel?.undocked).toBe(false);
        expect(newPanel?.locked).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('activates the inspection dock tab when adding a docked feature selection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setDockActiveTab('search');
        service.store.setDockOpen(false);
        const panelId = service.store.setSelection([feature('new-feature', 'map/layer/new-tile')]);
        const panel = service.store.inspection.selection().find(item => item.id === panelId);

        expect(panel?.undocked).toBe(false);
        expect(service.store.layout.dockOpen()).toBe(true);
        expect(service.store.layout.dockActiveTab()).toBe('inspection');

        service.destroy();
        routerStub.events.complete();
    });

    it('can create an undocked feature selection without stealing the dock search tab', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setDockActiveTab('search');
        service.store.setDockOpen(true);
        const panelId = service.store.setSelection(
            [feature('new-feature', 'map/layer/new-tile')],
            undefined,
            true,
            true);
        const panel = service.store.inspection.selection().find(item => item.id === panelId);

        expect(panel?.undocked).toBe(true);
        expect(service.store.layout.dockOpen()).toBe(true);
        expect(service.store.layout.dockActiveTab()).toBe('search');

        service.destroy();
        routerStub.events.complete();
    });

    it('reuses an unlocked floating feature inspection even when it focuses an attribute target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            {
                id: 1,
                features: [feature('Road.1:attribute#2:validity#0', 'map/layer/tile')],
                locked: false,
                size: [30, 40],
                color: '#111111',
                undocked: true
            },
            {
                id: 2,
                features: [feature('Road.3', 'map/layer/tile')],
                locked: false,
                size: [30, 20],
                color: '#222222',
                undocked: false
            }
        ]);
        service.store.setDockActiveTab('search');
        service.store.setDockOpen(true);

        const panelId = service.store.setSelection(
            [feature('Road.2', 'map/layer/tile')],
            undefined,
            false,
            true);

        expect(panelId).toBe(1);
        expect(service.store.inspection.selection().find(panel => panel.id === 1)?.features).toEqual([feature('Road.2', 'map/layer/tile')]);
        expect(service.store.inspection.selection().find(panel => panel.id === 2)).toBeDefined();
        expect(service.store.layout.dockActiveTab()).toBe('search');

        service.destroy();
        routerStub.events.complete();
    });

    it('toggles an inspection panel between base feature and attribute-validity target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            {
                id: 7,
                features: [feature('Road.1', 'map/layer/tile')],
                locked: true,
                size: [30, 20],
                color: '#111111',
                undocked: false
            }
        ]);

        service.store.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(service.store.inspection.selection()[0].features[0].featureId).toBe('Road.1:attribute#2:validity#0');
        expect(service.store.inspection.selection()[0].locked).toBe(true);

        service.store.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(service.store.inspection.selection()[0].features[0].featureId).toBe('Road.1');

        service.destroy();
        routerStub.events.complete();
    });

    it('preserves transient inspection tree header expansion state defensively', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        const expandedNodes = new Map<string, boolean | undefined>([['root', true], ['child', false]]);
        const restoreSnapshot = new Map<string, boolean | undefined>([['root', false]]);

        service.store.setInspectionTreeExpansionState(7, {
            expandedNodes,
            fullExpansionActive: true,
            expansionSnapshotBeforeFullExpand: restoreSnapshot,
            fullCollapseActive: false
        });
        expandedNodes.set('root', false);
        restoreSnapshot.set('root', true);

        const firstRead = service.store.getInspectionTreeExpansionState(7)!;
        expect(firstRead.expandedNodes.get('root')).toBe(true);
        expect(firstRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);
        expect(firstRead.fullExpansionActive).toBe(true);
        expect(firstRead.fullCollapseActive).toBe(false);

        firstRead.expandedNodes.set('root', false);
        firstRead.expansionSnapshotBeforeFullExpand?.set('root', true);

        const secondRead = service.store.getInspectionTreeExpansionState(7)!;
        expect(secondRead.expandedNodes.get('root')).toBe(true);
        expect(secondRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps SourceData column defaults and per-panel overrides out of the URL', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.store.setSelectionValue([{
            id: 7,
            features: [],
            locked: false,
            size: [30, 20],
            color: '#ffffff',
            undocked: false
        }]);

        service.store.setSourceDataInspectionDefaultColumns(["schemaType"]);
        service.store.setInspectionTreeHiddenColumns(7, ["displayAddress"]);

        expect(service.store.inspection.sourceDataInspectionDefaultColumns()).toEqual(["schemaType"]);
        expect(service.store.getInspectionTreeHiddenColumns(7)).toEqual(["displayAddress"]);
        expect(service.persistence.descriptor("sourceDataInspectionDefaultColumns").serialize(getState(service.store), true)).toBeUndefined();
        expect(service.persistence.descriptor("inspectionTreeHiddenColumns").serialize(getState(service.store), true)).toBeUndefined();

        service.store.setSelectionValue([]);
        expect(service.store.getInspectionTreeHiddenColumns(7)).toBeUndefined();

        service.destroy();
        routerStub.events.complete();
    });

    it('focuses inspection panels when selections create, reuse, or target an existing panel', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const selected = feature('new-feature', 'map/layer/new-tile');
        expect(service.store.setSelection([selected])).toBe(2);
        expect(service.store.focusedInspectionPanelId()).toBe(2);
        expect(service.store.inspection.selection().find(panel => panel.id === 2)?.focused).toBe(true);

        service.store.setFocusedInspectionPanel(1);
        expect(service.store.setSelection([selected])).toBeUndefined();
        expect(service.store.focusedInspectionPanelId()).toBe(2);
        expect(service.store.inspection.selection().find(panel => panel.id === 1)?.focused).toBeUndefined();
        expect(service.store.inspection.selection().find(panel => panel.id === 2)?.focused).toBe(true);

        const serializedSelection = service.persistence.descriptor("selected").serialize(getState(service.store), false)?.['selected'] ?? '';
        expect(serializedSelection).toContain('2~0f~');

        service.destroy();
        routerStub.events.complete();
    });

    it('reopens the dock for default feature selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setDockOpen(false);
        service.store.setSelectionValue([
            { id: 1, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#111111', undocked: false }
        ]);

        service.store.setSelection([feature('old-feature')]);
        expect(service.store.layout.dockOpen()).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('does not replace unlocked SourceData with a feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:1'), locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 2, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ]);

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.store.setSelection(selected);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(2);
        expect(panels.find(panel => panel.id === 1)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:1'));
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);

        service.destroy();
        routerStub.events.complete();
    });

    it('reuses an unlocked SourceData inspection before creating a new SourceData dialog', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const nextSourceData = sourceData('SourceData:m1:SourceData-LAYER:3');
        const targetPanelId = service.store.setSelection(nextSourceData);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(2);
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(nextSourceData);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual([]);

        service.destroy();
        routerStub.events.complete();
    });

    it('creates a new undocked SourceData dialog when no unlocked SourceData inspection exists', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const targetPanelId = service.store.setSelection(sourceData('SourceData:m1:SourceData-LAYER:9'));
        const panels = service.store.inspection.selection();
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(newPanel?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:9'));
        expect(newPanel?.undocked).toBe(true);
        expect(newPanel?.locked).toBe(false);
        expect(newPanel?.features).toEqual([]);

        service.destroy();
        routerStub.events.complete();
    });

    it('falls back to a remaining inspection panel when the focused panel is removed', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('remove-me')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('fallback')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ]);
        service.store.setFocusedInspectionPanel(1);

        service.store.unsetPanel(1);

        expect(service.store.focusedInspectionPanelId()).toBe(2);
        expect(service.store.inspection.selection().find(panel => panel.id === 2)?.focused).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps SourceData selection in the same panel when requested by SourceData panel id even if locked', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:3'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        const targetPanelId = service.store.setSelection(sourceData('SourceData:m1:SourceData-LAYER:7'), 1);
        const panels = service.store.inspection.selection();

        expect(targetPanelId).toBe(1);
        expect(panels.find(panel => panel.id === 1)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:7'));
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:3'));

        service.destroy();
        routerStub.events.complete();
    });

    it('ignores SourceData panels when deduplicating feature selection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const duplicated = feature('same-feature');
        service.store.setSelectionValue([
            {
                id: 1,
                features: [duplicated],
                sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'),
                locked: false,
                size: [30, 40],
                color: '#111111',
                undocked: true,
            },
        ]);

        const targetPanelId = service.store.setSelection([duplicated]);
        const panels = service.store.inspection.selection();
        const created = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(2);
        expect(created?.features).toEqual([duplicated]);
        expect(created?.sourceData).toBeUndefined();

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps unlocked SourceData inspections when clearing unlocked selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('remove-me')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('stay-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ]);

        service.store.unsetUnlockedSelections();
        const panels = service.store.inspection.selection();

        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 1)).toBeUndefined();
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:2'));
        expect(panels.find(panel => panel.id === 3)?.features).toEqual([feature('stay-locked')]);

        service.destroy();
        routerStub.events.complete();
    });

    it('creates one new panel per feature after clearing unlocked selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('remove-a')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('remove-b')], locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('keep-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
            { id: 4, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:8'), locked: false, size: [30, 40], color: '#444444', undocked: true },
        ]);

        service.store.unsetUnlockedSelections();

        const mergedFeatures = [feature('merged-1'), feature('merged-2'), feature('merged-3')];
        const createdIds = mergedFeatures.map(selected => service.store.setSelection([selected], undefined, true));
        const definedIds = createdIds.filter((panelId): panelId is number => panelId !== undefined);
        const panels = service.store.inspection.selection();

        expect(definedIds).toHaveLength(mergedFeatures.length);
        expect(panels.find(panel => panel.id === 1)).toBeUndefined();
        expect(panels.find(panel => panel.id === 2)).toBeUndefined();
        expect(panels.find(panel => panel.id === 3)?.features).toEqual([feature('keep-locked')]);
        expect(panels.find(panel => panel.id === 4)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:8'));

        definedIds.forEach((panelId, index) => {
            const createdPanel = panels.find(panel => panel.id === panelId);
            expect(createdPanel?.features).toEqual([mergedFeatures[index]]);
            expect(createdPanel?.locked).toBe(false);
            expect(createdPanel?.undocked).toBe(false);
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('stores inspection dialog layout in dialogLayouts state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 11, features: [], locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 22, features: [], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ]);

        service.store.setInspectionDialogPosition(11, { left: 10, top: 20 }, 0);
        service.store.setInspectionDialogPosition(22, { left: 30, top: 40 }, 0);

        const first = service.store.getInspectionDialogLayout(11);
        const second = service.store.getInspectionDialogLayout(22);
        expect(first?.slot).toBe(0);
        expect(second?.slot).toBe(0);

        service.store.setInspectionDialogPosition(11, { left: 12, top: 24 }, 9);
        expect(service.store.getInspectionDialogLayout(11)?.slot).toBe(0);

        service.store.pruneInspectionDialogLayout([22]);
        expect(service.store.getInspectionDialogLayout(11)).toBeUndefined();
        expect(service.store.getInspectionDialogLayout(22)?.position).toEqual({ left: 30, top: 40 });

        service.destroy();
        routerStub.events.complete();
    });

    it('persists comparison and layout states after hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        service.store.setSelectionValue([
            { id: 5, features: [], locked: false, size: [30, 40], color: '#555555', undocked: true },
        ]);
        service.store.setInspectionDialogPosition(5, { left: 100, top: 200 }, 3);
        service.store.openInspectionComparison({
            base: {
                panelId: 5,
                mapId: 'map',
                label: 'base',
                featureIds: [{ mapTileKey: 'map/layer/tile', featureId: 'f1' }]
            },
            others: []
        });
        await flushMicrotasks();

        const persistedSelection = localStorage.getItem('selected') ?? '';
        expect(persistedSelection).toContain('~555555~');
        expect(persistedSelection).not.toContain('#555555');
        expect(localStorage.getItem('selected')).not.toContain('3:100:200');
        expect(localStorage.getItem('dialogLayouts')).toContain('"inspection:5"');
        expect(localStorage.getItem('dialogLayouts')).toContain('"slot":3');
        expect(localStorage.getItem('inspectionComparisonState')).toContain('"panelId":5');

        service.store.closeInspectionComparison();
        await flushMicrotasks();
        expect(service.store.inspection.inspectionComparison()).toBeNull();

        service.destroy();
        routerStub.events.complete();
    });

    it('removes a compared other panel when unsetPanel is called', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ]);
        service.store.openInspectionComparison({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: [{
                panelId: 2,
                mapId: 'map',
                label: 'map.f2',
                featureIds: [feature('f2')]
            }]
        });

        service.store.unsetPanel(2);

        expect(service.store.inspection.inspectionComparison()).toEqual({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: []
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('promotes another comparison entry to base when the current base panel is removed', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
            { id: 3, features: [feature('f3')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ]);
        service.store.openInspectionComparison({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: [
                {
                    panelId: 2,
                    mapId: 'map',
                    label: 'map.f2',
                    featureIds: [feature('f2')]
                },
                {
                    panelId: 3,
                    mapId: 'map',
                    label: 'map.f3',
                    featureIds: [feature('f3')]
                }
            ]
        });

        service.store.unsetPanel(1);

        expect(service.store.inspection.inspectionComparison()).toEqual({
            base: {
                panelId: 2,
                mapId: 'map',
                label: 'map.f2',
                featureIds: [feature('f2')]
            },
            others: [
                {
                    panelId: 3,
                    mapId: 'map',
                    label: 'map.f3',
                    featureIds: [feature('f3')]
                }
            ]
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('removes cleared unlocked panels from comparison during bulk close', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setSelectionValue([
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ]);
        service.store.openInspectionComparison({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: [{
                panelId: 2,
                mapId: 'map',
                label: 'map.f2',
                featureIds: [feature('f2')]
            }]
        });

        service.store.unsetUnlockedSelections();

        expect(service.store.inspection.inspectionComparison()).toEqual({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: []
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('validates and persists Connection preferences seeded through deployment state', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        expect(service.persistence.seedConfigDefaultState({connectionRetryInitialDelayMs: 7000,
            connectionRetryMaxDelayMs: 90000}, "connection-config")).toEqual([]);
        expect(service.store.connectionRetryPolicy().initialDelayMs).toBe(7000);
        service.store.setConnectionRetryPolicy({...service.store.connectionRetryPolicy(), enabled: false, backoffMultiplier: 3});
        expect(service.persistence.exportSnapshot()).toMatchObject({connectionRetryEnabled: 0,
            connectionRetryInitialDelayMs: 7000, connectionRetryBackoffMultiplier: 3});
        expect(() => service.store.setConnectionRetryPolicy({...service.store.connectionRetryPolicy(), maxDelayMs: 0})).toThrow();
        expect(service.store.connectionRetryPolicy().maxDelayMs).toBe(90000);
        service.destroy();
        routerStub.events.complete();
    });

    it('shares validated point-cloud preferences across config, snapshots and persisted state', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        expect(service.persistence.seedConfigDefaultState({pointCloudDetailPixels: 4,
            pointCloudGpuMemoryMiB: 128}, 'point-cloud-config')).toEqual([]);
        expect(service.store.pointCloudPolicy().detailPixels).toBe(4);
        service.store.setPointCloudPolicy({...service.store.pointCloudPolicy(), enabled: false, workingMemoryMiB: 256});
        const snapshot = service.persistence.exportSnapshot();
        expect(snapshot).toMatchObject({pointCloudDownsamplingEnabled: 0,
            pointCloudDetailPixels: 4, pointCloudWorkingMemoryMiB: 256, pointCloudGpuMemoryMiB: 128});
        expect(service.persistence.descriptor("pointCloudDetailPixels").codec.isUrlState()).toBe(false);
        expect(() => service.store.setPointCloudPolicy({...service.store.pointCloudPolicy(), gpuMemoryMiB: 0})).toThrow();
        expect(service.store.pointCloudPolicy().gpuMemoryMiB).toBe(128);
        expect(service.persistence.importSnapshot({pointCloudDetailPixels: 8})).toEqual([]);
        expect(service.store.pointCloudPolicy().detailPixels).toBe(8);
        expect(service.persistence.importSnapshot({pointCloudWorkingMemoryMiB: -1}).length).toBeGreaterThan(0);
        expect(service.store.pointCloudPolicy().workingMemoryMiB).toBe(256);
        service.destroy();
        routerStub.events.complete();
    });

    it('exports app state entries with compact style option storage keys', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setMarkerState(true);
        service.store.setLayerNames(['m1/layerA']);
        service.store.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        const snapshot = service.persistence.exportSnapshot();

        expect(snapshot).toHaveProperty('marker');
        expect(snapshot).toHaveProperty('numberOfViews');
        expect(snapshot).not.toHaveProperty('styleOptions');
        expect(snapshot).toHaveProperty('overlay~0~opacity', '0.5');

        service.destroy();
        routerStub.events.complete();
    });

    it('omits transient dialog visibility flags from exported snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setDialogOpen('advanced-preferences-dialog', true);
        const snapshot = service.persistence.exportSnapshot();

        expect(snapshot).not.toHaveProperty('advancedPreferencesDialogVisible');

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps coordinate preference and legal acceptance out of URLs and snapshots', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.store.setCoordinatesEnabled(false);
        service.store.setCoordinatesLegalTermsAccepted(true);

        const snapshot = service.persistence.exportSnapshot();
        const params = (service as any).url.serializeUrlV2();
        expect(snapshot).not.toHaveProperty('coordinatesEnabled');
        expect(snapshot).not.toHaveProperty('coordinatesLegalTermsAccepted');
        expect(params).not.toHaveProperty('coordinatesEnabled');
        expect(params).not.toHaveProperty('coordinatesLegalTermsAccepted');

        service.destroy();
        routerStub.events.complete();
    });

    it('restores dialog visibility from dialogLayouts snapshot state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.importSnapshot({
            dialogLayouts: {
                "advanced-preferences-dialog": {
                    position: {left: 10, top: 20},
                    size: {width: 400, height: 300},
                    open: true
                }
            }
        });

        expect(errors).toEqual([]);
        expect(service.store.isDialogOpen('advanced-preferences-dialog')).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('restores style dialog state from snapshot data', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.importSnapshot({
            styleEditorTarget: 'generic',
            dialogLayouts: {
                "styles-dialog": {
                    position: {left: 10, top: 20},
                    size: {width: 500, height: 400},
                    open: true
                },
                "style-editor-dialog": {
                    position: {left: 30, top: 40},
                    size: {width: 600, height: 500},
                    open: true
                }
            }
        });

        expect(errors).toEqual([]);
        expect(service.store.isDialogOpen('styles-dialog')).toBe(true);
        expect(service.store.isDialogOpen('style-editor-dialog')).toBe(true);
        expect(service.store.styleEditor.styleEditorTarget()).toBe('generic');

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects snapshot imports with unknown top-level keys and applies nothing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setMarkerState(false);
        const errors = service.persistence.importSnapshot({
            marker: true,
            unknownState: 1
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.store.views.marker()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('imports valid partial snapshots and keeps missing states unchanged', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.store.setMarkerState(false);

        const errors = service.persistence.importSnapshot({
            marker: true
        });

        expect(errors).toEqual([]);
        expect(service.store.views.marker()).toBe(true);
        expect(service.store.isDialogOpen('preferences-dialog')).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('resets omitted query-scene state and replaces camera and style options', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        service.store.setMapsOpen(true);
        setTestStyleOptions(service, new Map([['old/Lane/style/topology', [true]]]));
        await service.persistence.replaceUrlState({v2: '1', n: '1', lon: '11.66', lat: '48.25', alt: '128000', map: 'Very-Large-Map', l: 'Road:0', v: '1'}, true);
        expect(service.store.layers.mapsOpen()).toBe(false);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).has('old/Lane/style/topology')).toBe(false);
        expect(service.store.layers.layerNames()).toEqual(['Very-Large-Map/Road']);
        expect(service.store.views.cameraViewData()[service.store.idAt(0)!].destination.lon).toBeCloseTo(11.66);
        expect(service.store.views.cameraViewData()[service.store.idAt(0)!].destination.lat).toBeCloseTo(48.25);
        service.destroy();
        routerStub.events.complete();
    });

    it('rejects presentation snapshot replacement before persistence is ready', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(() => service.persistence.replaceSnapshotState({marker: true}))
            .toThrow('before AppStateService is ready');

        service.destroy();
        routerStub.events.complete();
    });

    it('validates presentation snapshot replacement before mutating any state', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        const stateApplied = vi.fn();
        service.persistence.stateApplied.subscribe(stateApplied);

        service.store.setMarkerState(false);
        const errors = service.persistence.replaceSnapshotState({
            marker: true,
            unknownPresentationState: 1
        });

        expect(errors).not.toEqual([]);
        expect(service.store.views.marker()).toBe(false);
        expect(stateApplied).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('replaces presentation state, resets omissions, and clears stale style options without persistence', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        service.store.setMarkerState(true);
        service.store.setMapsOpen(true);
        service.store.setLayerNames(['m1/layerA']);
        setTestStyleOptions(service, new Map([
            ['m1/layerA/overlay/stale', [true]]
        ]));
        await flushMicrotasks();
        localStorage.clear();
        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();
        const appliedSnapshots: Array<Record<string, unknown>> = [];
        service.persistence.stateApplied.subscribe(() => appliedSnapshots.push(service.persistence.exportSnapshot()));

        const errors = service.persistence.replaceSnapshotState({
            numberOfViews: 1,
            marker: false,
            layerNames: ['m2/layerB'],
            'overlay~0~opacity': '0.75'
        });
        await flushMicrotasks();

        expect(errors).toEqual([]);
        expect(service.store.views.marker()).toBe(false);
        expect(service.store.layers.mapsOpen()).toBe(false);
        expect(service.store.layers.layerNames()).toEqual(['m2/layerB']);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).has('m1/layerA/overlay/stale')).toBe(false);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m2/layerB/overlay/opacity')).toEqual(['0.75']);
        expect(appliedSnapshots).toHaveLength(1);
        expect(routerStub.navigate).not.toHaveBeenCalled();
        expect(localStorage.length).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('imports compact style option entries after applying layer state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.importSnapshot({
            layerNames: ['m1/layerA'],
            'overlay~0~opacity~debug': '0.5~1'
        });

        expect(errors).toEqual([]);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/opacity')).toEqual(['0.5']);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).get('m1/layerA/overlay/debug')).toEqual(['1']);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects non-string compact style option snapshot values before mutation', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.importSnapshot({
            marker: true,
            'overlay~0~opacity': [0.5]
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.store.views.marker()).toBe(false);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects prototype-pollution keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"marker": true, "__proto__": {"polluted": true}}');
        const errors = service.persistence.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.store.views.marker()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects nested __proto__ keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"styleOptions": {"valid/key": [true], "__proto__": {"polluted": true}}}');
        const errors = service.persistence.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.persistence.stylesPersistence.read(getState(service.store)).size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects constructor.prototype payloads in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"styleOptions": {"constructor": {"prototype": {"polluted": true}}}}');
        const errors = service.persistence.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.persistence.stylesPersistence.read(getState(service.store)).size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects oversized snapshot strings before state mutation', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        const limits = service.persistence.getSnapshotImportLimits();

        const errors = service.persistence.importSnapshot({
            erdblickVersion: 'x'.repeat(limits.maxStringLength + 1)
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.store.config.erdblickVersion()).toBe('');

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects snapshots that exceed the max nesting depth', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        const limits = service.persistence.getSnapshotImportLimits();

        const deepValue: Record<string, unknown> = {};
        let cursor: Record<string, unknown> = deepValue;
        for (let index = 0; index < limits.maxNestingDepth + 1; index++) {
            cursor['next'] = {};
            cursor = cursor['next'] as Record<string, unknown>;
        }

        const errors = service.persistence.importSnapshot({
            styleOptions: deepValue
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.persistence.stylesPersistence.read(getState(service.store)).size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('applies config default state for a fresh profile before hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.seedConfigDefaultState({
            marker: true,
            featureZoomClearanceMeters: 35
        }, "cfg-hash-1");
        expect(errors).toEqual([]);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(true);
        expect(service.store.views.featureZoomClearanceMeters()).toBe(35);

        service.destroy();
        routerStub.events.complete();
    });

    it('applies the coordinate config default without making it snapshot state', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        const errors = service.persistence.seedConfigDefaultState({coordinatesEnabled: false}, "coordinates-cfg");
        expect(errors).toEqual([]);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.coordinatePolicy.coordinatesEnabled()).toBe(false);
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('coordinatesEnabled');

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps legacy localStorage values without metadata over seeded config defaults', async () => {
        localStorage.setItem('marker', '0');

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.seedConfigDefaultState({marker: true}, "cfg-hash-2");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('replaces config-owned localStorage values with current config defaults', async () => {
        localStorage.setItem('marker', '0');
        localStorage.setItem('erdblickConfigDefaultStateMeta', JSON.stringify({
            version: 1,
            sourceHash: 'old-cfg',
            entries: {
                marker: {
                    owner: 'config',
                    valueHash: 'old'
                }
            }
        }));

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.seedConfigDefaultState({marker: true}, "cfg-hash-3");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps user-owned localStorage values over seeded config defaults', async () => {
        localStorage.setItem('marker', '0');
        localStorage.setItem('erdblickConfigDefaultStateMeta', JSON.stringify({
            version: 1,
            sourceHash: 'cfg',
            entries: {
                marker: {
                    owner: 'user',
                    valueHash: 'user'
                }
            }
        }));

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.seedConfigDefaultState({marker: true}, "cfg-hash-4");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps URL parameters as highest precedence over config and localStorage', async () => {
        localStorage.setItem('marker', '0');
        localStorage.setItem('erdblickConfigDefaultStateMeta', JSON.stringify({
            version: 1,
            sourceHash: 'cfg',
            entries: {
                marker: {
                    owner: 'user',
                    valueHash: 'user'
                }
            }
        }));

        const routerStub = createRouterStub({m: '1'});
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.persistence.seedConfigDefaultState({marker: false}, "cfg-hash-5");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('returns validation errors for invalid config default snapshots and leaves defaults unchanged', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.seedConfigDefaultState({marker: ["bad"]}, "cfg-hash-6");
        expect(errors.length).toBeGreaterThan(0);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(false);
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
        service.destroy();
        routerStub.events.complete();
    });

    it('ignores empty config default snapshots', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const errors = service.persistence.seedConfigDefaultState({}, "cfg-hash-empty");
        expect(errors).toEqual([]);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.store.views.marker()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });
});
