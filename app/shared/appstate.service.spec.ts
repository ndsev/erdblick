import "@angular/compiler";
import {Subject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createStateOwners, type StateOwners} from "./state-test-owners";

import type {Event, Router} from '@angular/router';
import {NavigationEnd, NavigationStart} from '@angular/router';
import {Cartographic} from '../integrations/geo';

import {MapTreeNode} from "../mapdata/map.tree.model";
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

const layerInfo = (layerId: string, type = "Feature") => ({
    layerId,
    type,
    canRead: true,
    canWrite: false,
    coverage: [],
    featureTypes: [],
    version: {major: 1, minor: 0, patch: 0},
    zoomLevels: [],
});

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

        expect(service.views.markerState.getValue()).toBe(true);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.views.markerState.next(false);
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

        expect(service.views.markerState.getValue()).toBe(true);
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
            appliedMarkerValues.push(service.views.markerState.getValue());
        });

        await service.persistence.replaceUrlState({v2: '1', m: '1'});

        expect(routerStub.navigate).toHaveBeenCalledWith([], {
            queryParams: {v2: '1', m: '1'},
            queryParamsHandling: 'replace',
            replaceUrl: true,
        });
        expect(service.views.markerState.getValue()).toBe(true);
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

    it('keeps selected features with packed tile ids during datasource pruning', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.inspections.selection = [{
            id: 0,
            features: [feature(
                "Intersection.545554858.3348",
                "Features:Very-Large-Map:Road:22100770000d"
            )],
            locked: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }];

        service.layers.prune(new Map([
            ["Very-Large-Map", new MapTreeNode({
                mapId: "Very-Large-Map",
                sourceId: "Very-Large-Map",
                stringPoolId: "Very-Large-Map",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: {Road: layerInfo("Road")},
            } as any)]
        ]), new Map());

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].features[0].mapTileKey).toBe("Features:Very-Large-Map:Road:22100770000d");
    });


    it('keeps selected features while datasource layers are still initializing', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.inspections.selection = [{
            id: 0,
            features: [feature(
                "Intersection.545554858.3348",
                "Features:Very-Large-Map:Road:545554858"
            )],
            locked: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }];

        service.layers.prune(new Map([
            ["Very-Large-Map", new MapTreeNode({
                mapId: "Very-Large-Map",
                sourceId: "Very-Large-Map",
                stringPoolId: "Very-Large-Map",
                maxParallelJobs: 0,
                addOn: false,
                status: "initializing",
                extraJsonAttachment: {},
                layers: {},
            } as any)]
        ]), new Map());

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].features[0].mapTileKey).toBe("Features:Very-Large-Map:Road:545554858");
    });

    it('preserves focused selection metadata while pruning unavailable selections', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.inspections.selection = [{
            id: 0,
            features: [
                feature("Road.1", "Features:Very-Large-Map:Road:545554858"),
                feature("Lane.1", "Features:Very-Large-Map:Lane:545554858"),
            ],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }];

        service.layers.prune(new Map([
            ["Very-Large-Map", new MapTreeNode({
                mapId: "Very-Large-Map",
                sourceId: "Very-Large-Map",
                stringPoolId: "Very-Large-Map",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: {Road: layerInfo("Road")},
            } as any)]
        ]), new Map());

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].focused).toBe(true);
        expect(service.inspections.selection[0].features).toEqual([
            feature("Road.1", "Features:Very-Large-Map:Road:545554858"),
        ]);
    });

    it('keeps selections whose MapTileKey encodes slashes in the map id', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.inspections.selection = [{
            id: 0,
            features: [feature(
                "Landmark.545666604.12",
                "Features:Provider%2FSample Munich:Landmark:545666604"
            )],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }];

        service.layers.prune(new Map([
            ["Provider/Sample Munich", new MapTreeNode({
                mapId: "Provider/Sample Munich",
                sourceId: "Provider/Sample Munich",
                stringPoolId: "Provider/Sample Munich",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: {Landmark: layerInfo("Landmark")},
            } as any)]
        ]), new Map());

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].focused).toBe(true);
        expect(service.inspections.selection[0].features[0]).toEqual(feature(
            "Landmark.545666604.12",
            "Features:Provider%2FSample Munich:Landmark:545666604"
        ));
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

        expect(service.views.lod3TileThreshold).toBe(128);

        service.views.lod3TileThreshold = 1024;
        expect(service.views.lod3TileThreshold).toBe(1024);

        service.views.lod3TileThreshold = 9999;
        expect(service.views.lod3TileThreshold).toBe(4096);

        service.destroy();
        routerStub.events.complete();
    });

    it('normalizes the persisted subset-render worker preference', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(
            routerStub as unknown as Router,
            infoServiceStub()
        );

        expect(service.views.tileSubsetRenderWorkerCount).toBe(0);

        service.views.tileSubsetRenderWorkerCount = 999;

        expect(service.views.tileSubsetRenderWorkerCount).toBe(32);
        service.destroy();
        routerStub.events.complete();
    });

    it('persists a bounded drill-pick radius without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.inspections.drillPickRadius).toBe(3);

        service.inspections.drillPickRadius = 7.8;
        expect(service.inspections.drillPickRadius).toBe(7);

        service.inspections.drillPickRadius = -100;
        expect(service.inspections.drillPickRadius).toBe(1);

        service.inspections.drillPickRadius = 100;
        expect(service.inspections.drillPickRadius).toBe(10);
        expect(service.persistence.exportSnapshot()).toHaveProperty('drillPickRadius', 10);
        expect((service as any).url.serializeUrlV2()).not.toHaveProperty('drillPickRadius');

        service.destroy();
        routerStub.events.complete();
    });

    it('persists bounded feature zoom clearance without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.views.featureZoomClearanceMeters).toBe(20);

        service.views.featureZoomClearanceMeters = 37.5;
        expect(service.views.featureZoomClearanceMeters).toBe(37.5);

        service.views.featureZoomClearanceMeters = -1;
        expect(service.views.featureZoomClearanceMeters).toBe(0);

        service.views.featureZoomClearanceMeters = 101;
        expect(service.views.featureZoomClearanceMeters).toBe(100);
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

        expect(service.views.featureZoomClearanceMeters).toBe(expected);
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

        expect(service.views.deckAntialiasingEnabled).toBe(true);
        expect(service.views.semanticCompositingEnabled).toBe(true);
        expect(service.views.contactShadingEnabled).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('persists semantic compositing locally without adding it to shared URLs', async () => {
        localStorage.setItem('semanticCompositingEnabled', '0');
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.views.semanticCompositingEnabled).toBe(false);
        expect(service.views.semanticCompositingEnabledState.serialize(true)).toBeUndefined();

        service.views.semanticCompositingEnabled = true;
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('1');

        service.views.semanticCompositingEnabled = false;
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('0');
        expect(service.views.semanticCompositingEnabledState.serialize(true)).toBeUndefined();

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

        expect(service.inspections.focusedInspectionPanelId).toBe(5);
        expect(service.inspections.selection[0].focused).toBe(true);

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

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].features[0]).toEqual({
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

        expect(service.views.numViews).toBe(2);
        expect(service.layers.layerNamesState.getValue()).toEqual(['MapA/Lane', 'MapB/Road']);
        expect(service.layers.layerVisibilityState.getValue(0)).toEqual([true, false]);
        expect(service.layers.layerVisibilityState.getValue(1)).toEqual([false, true]);
        expect(service.layers.layerZoomLevelState.getValue(0)).toEqual([12, 13]);
        expect(service.layers.layerZoomLevelState.getValue(1)).toEqual([14, 15]);
        expect(service.layers.layerAutoZoomLevelState.getValue(0)).toEqual([true, true]);
        expect(service.layers.layerAutoZoomLevelState.getValue(1)).toEqual([false, false]);
        expect(service.layers.stylesState.getValue().get('MapA/Lane/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(service.layers.stylesState.getValue().get('MapB/Road/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(service.inspections.selection).toEqual([
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
        expect(service.inspections.focusedInspectionPanelId).toBe(1);
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

        expect(service.inspections.selection).toEqual([]);

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

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].id).toBe(5);
        expect(service.inspections.selection[0].focused).toBe(true);
        expect(service.inspections.selection[0].features[0]).toEqual({
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

        expect(service.inspections.selection[0].features[0]).toEqual({
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

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].features).toEqual([feature('feature-1', 'Features:map:layer:tile')]);
        expect(service.searches.featureSearches).toHaveLength(1);
        expect(service.searches.featureSearches[0].query).toBe('**.speed > 80');

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
        expect(service.layout.isDialogOpen('preferences-dialog')).toBe(true);
        expect(service.layout.isDockOpen).toBe(true);
        expect(service.layout.dockActiveTab).toBe('search');
        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].id).toBe(7);
        expect(service.searches.featureSearches).toHaveLength(1);
        expect(service.searches.featureSearches[0].id).toBe('feature-search-7');

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
        service.searches.addFeatureSearch({query: '**.speed > 80'});
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
            service.layers.layerNames = ['Map/Lane'];
            service.layers.setMapLayerConfig('Map', 'Lane', [{visible: true, level: 13, autoLevel: false}]);
            service.views.cameraViewDataState.next(0, {destination: {lon: 11, lat: 48, alt: 900},
                orientation: {heading: 0, pitch: -0.75, roll: 0}, position: [0, 0, 0]});
            service.inspections.selection = [{id: 0, features: [{mapTileKey: 'Features:Map:Lane:545379780', featureId: 'Lane.1'}],
                locked: true, size: [30, 20], color: '#fff314', undocked: false}];
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
            expect(restored.layers.layerNames).toEqual(['Map/Lane']);
            expect(restored.layers.layerVisibilityState.getValue(0)).toEqual([true]);
            expect(restored.views.cameraViewDataState.getValue(0)).toEqual(service.views.cameraViewDataState.getValue(0));
            expect(restored.inspections.selection[0].features).toEqual(service.inspections.selection[0].features);
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

        service.layers.layerNamesState.next(['MapA/Lane', 'MapC/POI']);
        service.layers.layerVisibilityState.next(0, [true, false]);
        service.layers.layerZoomLevelState.next(0, [12, 15]);
        service.layers.layerAutoZoomLevelState.next(0, [false, false]);
        service.inspections.selection = [{
            id: 0,
            features: [{
                mapTileKey: 'Features:MapB:Road:21',
                featureId: 'Road.1',
            }],
            locked: true,
            size: [30, 20],
            color: '#fff314',
            undocked: false,
        }];

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

        const config = service.layers.initializeMapLayerConfig('Classic-2.5.2-Sample', 'NDS.Classic-BMD');
        expect(config).toEqual([
            {autoLevel: true, visible: false, level: 13},
        ]);
        expect(service.layers.layerNamesState.getValue()).toEqual([
            'MapA/Lane',
            'MapB/Road',
            'Classic-2.5.2-Sample/NDS.Classic-BMD',
        ]);
        expect(service.layers.layerVisibilityState.getValue(0)).toEqual([true, true, false]);

        service.destroy();
        routerStub.events.complete();
    });

    it('serializes an empty active layer list as an authoritative v2 layer list', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.layers.layerNamesState.next(['MapA/Lane']);
        service.layers.layerVisibilityState.next(0, [false]);

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
        service.views.markerState.next(true);
        await flushMicrotasks();
        expect((service as any).persistence.urlSyncHandle).not.toBeNull();
        expect((service as any).persistence.pendingUrlSyncStates.size).toBeGreaterThan(0);

        routerStub.routerState.snapshot.root!.queryParams = { m: '0' };
        // @ts-expect-error this is a call to mock router
        routerStub.getCurrentNavigation.mockReturnValue({ trigger: 'popstate' });
        routerStub.events.next(new NavigationStart(2, '/?m=0'));
        routerStub.events.next(new NavigationEnd(2, '/?m=0', '/?m=0'));
        await flushMicrotasks();

        expect(service.views.markerState.getValue()).toBe(false);
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

        expect(service.views.markedPositionState.getValue()).toEqual([11.14198571, 48.00237573]);

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

        service.views.markedPositionState.next([11.141985707869166, 48.002375728153766, 125.123456789]);
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

        service.views.setMarkerPosition(Cartographic.fromDegrees(11.25, 48.5, 127.75));

        expect(service.views.markedPosition).toEqual([11.25, 48.5, 127.75]);
        service.destroy();
        routerStub.events.complete();
    });

    it('hydrates background-layer settings from combined query params', async () => {
        const routerStub = createRouterStub({ n: '2', bg: 'osm~50,world-overview~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.layers.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(service.layers.getBackgroundState(1)).toEqual({ layerId: 'world-overview', opacity: 30 });

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

        service.layers.setBackgroundState(0, 'osm', 50);
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

        expect(service.layers.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(service.layers.getBackgroundState(1)).toEqual({ layerId: null, opacity: 30 });

        service.destroy();
        routerStub.events.complete();
    });

    it('uses the configured default background opacity when a persisted layer no longer exists', async () => {
        const routerStub = createRouterStub({ bg: 'world-overview~100' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        const resolvedState = service.layers.resolveBackgroundState(
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

        service.views.setView(0, destination, orientation);
        service.views.setProjectionMode(0, true);
        service.layers.setLayerSyncOption(0, true);
        service.layers.setBackgroundState(0, null, 42);
        service.layers.viewTileBordersState.next(0, false);
        service.layers.viewTileGridModeState.next(0, 'xyz');
        service.layers.viewTileGridLevelState.next(0, 18);
        service.layers.viewTileGridAutoLevelState.next(0, true);
        service.layers.viewTileGridColorState.next(0, '123abc');
        service.layers.viewTileGridOpacityState.next(0, 64);
        service.layers.initializeMapLayerConfig('m1', 'layerA', false, 9);
        service.layers.setMapLayerConfig('m1', 'layerA', [{ autoLevel: false, visible: true, level: 7 }]);

        service.views.numViews = 2;

        expect(service.views.numViews).toBe(2);
        expect(service.views.cameraViewDataState.getValue(1)).toEqual(service.views.cameraViewDataState.getValue(0));
        expect(service.views.cameraViewDataState.getValue(1)).not.toBe(service.views.cameraViewDataState.getValue(0));
        expect(service.views.mode2dState.getValue(1)).toBe(true);
        expect(service.layers.getLayerSyncOption(1)).toBe(true);
        expect(service.layers.getBackgroundState(1)).toEqual({ layerId: null, opacity: 42 });
        expect(service.layers.viewTileBordersState.getValue(1)).toBe(false);
        expect(service.layers.viewTileGridModeState.getValue(1)).toBe('xyz');
        expect(service.layers.viewTileGridLevelState.getValue(1)).toBe(18);
        expect(service.layers.viewTileGridAutoLevelState.getValue(1)).toBe(true);
        expect(service.layers.viewTileGridColorState.getValue(1)).toBe('123abc');
        expect(service.layers.viewTileGridOpacityState.getValue(1)).toBe(64);
        expect(service.layers.layerVisibilityState.getValue(1)).toEqual([true]);
        expect(service.layers.layerVisibilityState.getValue(1)).not.toBe(service.layers.layerVisibilityState.getValue(0));
        expect(service.layers.layerZoomLevelState.getValue(1)).toEqual([7]);
        expect(service.layers.layerAutoZoomLevelState.getValue(1)).toEqual([false]);

        service.destroy();
        routerStub.events.complete();
    });

    it('copies style option values into the second view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.layers.layerNamesState.next(['m1/layerA']);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [true]);

        service.views.numViews = 2;

        const stylesMap = service.layers.stylesState.getValue();
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([true, true]);

        service.destroy();
        routerStub.events.complete();
    });

    it.each([0, 1])('retains the other view when view %i is removed', (removed) => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.views.numViews = 2;
        service.layers.layerNamesState.next(['m1/layerA']);
        for (const index of [0, 1]) {
            service.views.cameraViewDataState.next(index, {
                destination: {lon: 11 + index, lat: 48 + index, alt: 1000 + index},
                orientation: {heading: index, pitch: -0.5, roll: 0},
                position: [index, index + 1, index + 2]
            });
            service.views.mode2dState.next(index, index === 0);
            service.layers.setLayerSyncOption(index, index === 1);
            service.layers.setBackgroundState(index, index === 0 ? 'osm' : null, 20 + index);
            service.layers.layerVisibilityState.next(index, [index === 1]);
            service.layers.layerZoomLevelState.next(index, [12 + index]);
            service.layers.layerAutoZoomLevelState.next(index, [index === 0]);
            service.layers.viewTileBordersState.next(index, index === 1);
            service.layers.viewTileGridModeState.next(index, index === 0 ? 'nds' : 'xyz');
            service.layers.viewTileGridLevelState.next(index, 8 + index);
            service.layers.viewTileGridAutoLevelState.next(index, index === 0);
            service.layers.viewTileGridColorState.next(index, index === 0 ? '123abc' : 'abcdef');
            service.layers.viewTileGridOpacityState.next(index, 30 + index);
            service.layers.setMapPresetSelection(index, 'm1', `map-preset-${index}`);
            service.layers.setLayerPresetSelection(index, 'm1', 'layerA', {styleId: 'overlay', presetId: `preset-${index}`});
        }
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.2, 0.8]);
        const searches = [[0], [1], [0, 1]].map(selectedViewIndices =>
            service.searches.addFeatureSearch({query: 'Way', selectedViewIndices}));
        service.inspections.setSelection([feature('Way.1')]);
        const selection = service.inspections.selectionState.signal();
        const survivor = 1 - removed;
        const slots = [service.views.cameraViewDataState, service.views.mode2dState, service.layers.layerSyncOptionsState,
            service.layers.backgroundState, service.layers.layerVisibilityState, service.layers.layerZoomLevelState,
            service.layers.layerAutoZoomLevelState, service.layers.viewTileBordersState, service.layers.viewTileGridModeState,
            service.layers.viewTileGridLevelState, service.layers.viewTileGridAutoLevelState, service.layers.viewTileGridColorState,
            service.layers.viewTileGridOpacityState, service.layers.layerPresetSelectionState, service.layers.mapPresetSelectionState];
        const expected = slots.map(slot => slot.getValue(survivor));
        service.views.focusedView = removed;
        service.views.viewSync = [VIEW_SYNC_POSITION];

        service.views.retainViews([survivor], new Map());

        expect(service.views.numViews).toBe(1);
        expect(service.views.focusedView).toBe(0);
        slots.forEach((slot, index) => {
            expect(slot.appState.getValue()).toEqual([expected[index]]);
        });
        expect(service.layers.styles.get('m1/layerA/overlay/opacity')).toEqual([survivor ? 0.8 : 0.2]);
        expect(service.inspections.selectionState.signal()).toBe(selection);
        expect(service.searches.featureSearches).toEqual(searches.map(search => ({
            ...search, selectedViewIndices: search.selectedViewIndices.includes(survivor) ? [0] : [],
            selectedViewIds: search.selectedViewIndices.includes(survivor) ? [service.views.viewIds()[0]] : []
        })));
        expect(service.views.viewSync).toEqual([VIEW_SYNC_POSITION]);

        service.views.numViews = 2;
        expect(service.views.cameraViewDataState.getValue(1)).toEqual(expected[0]);
        expect(service.layers.layerVisibilityState.getValue(1)).toEqual(expected[4]);
        expect(service.layers.styles.get('m1/layerA/overlay/opacity')).toEqual(survivor ? [0.8, 0.8] : [0.2, 0.2]);
        service.destroy();
        routerStub.events.complete();
    });

    it('retains sparse defaults and a live camera without propagating synchronization', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.views.numViewsState.next(3);
        const camera = {...service.views.cameraViewDataState.getValue(2), position: [1, 2, 3] as [number, number, number]};
        const defaultBackground = service.layers.backgroundState.getValue(2);
        service.views.retainViews([0, 2], new Map([[2, camera]]));
        expect(service.layers.backgroundState.appState.getValue()).toEqual([defaultBackground, defaultBackground]);
        expect(service.views.cameraViewDataState.getValue(1)).toEqual(camera);
        expect(service.views.cameraViewDataState.getValue(0).position).not.toEqual(camera.position);
        service.destroy();
        routerStub.events.complete();
    });

    it('writes a style-option batch atomically and emits style state once', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.layers.layerNamesState.next(['m1/layerA']);
        service.views.numViews = 2;
        const nextSpy = vi.spyOn(service.layers.stylesState, 'next');

        service.layers.setStyleOptionValuesBatch([
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

        expect(nextSpy).toHaveBeenCalledTimes(1);
        expect(service.layers.styles.get('m1/layerA/overlay/first')).toEqual([true, false]);
        expect(service.layers.styles.get('m1/layerA/overlay/second')).toEqual([true, true]);

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects an invalid style-option batch before mutating any option', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.layers.layerNamesState.next(['m1/layerA']);

        expect(() => service.layers.setStyleOptionValuesBatch([
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
        expect(service.layers.styles.size).toBe(0);

        service.destroy();
        routerStub.events.complete();
    });

    it('stores qualified layer and map preset selections outside snapshots', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.views.numViews = 2;

        service.layers.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        service.layers.setLayerPresetSelection(1, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        service.layers.setMapPresetSelection(0, 'Vendor/Map', 'network-topology');

        expect(service.layers.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        expect(service.layers.getLayerPresetSelection(1, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        expect(service.layers.getMapPresetSelection(0, 'Vendor/Map')).toBe('network-topology');
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('stylePresetSelection');
        expect(service.persistence.exportSnapshot()).not.toHaveProperty('mapPresetSelection');

        service.layers.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', null);
        expect(service.layers.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toBeNull();

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

        expect(service.layers.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: '',
            presetId: 'legacy-lane-preset'
        });

        service.destroy();
        routerStub.events.complete();
    });

    it('provides non-URL hover-label defaults for the preview preferences', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        expect(service.inspections.hoverLabelsEnabled).toBe(true);
        expect(service.inspections.hoverLabelFields).toEqual([{
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

        service.layers.layerNamesState.next(['m1/layerA']);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);

        service.views.numViews = 2;

        const destination = Cartographic.fromDegrees(7.75, 50.2, 123456);
        const orientation = { heading: 0.5, pitch: -0.4, roll: 0.3 };

        service.views.numViews = 2;
        service.views.setView(1, destination, orientation);
        service.views.setProjectionMode(1, true);
        service.layers.setLayerSyncOption(1, true);
        service.layers.setBackgroundState(1, null, 17);
        service.layers.viewTileBordersState.next(1, false);
        service.layers.viewTileGridModeState.next(1, 'xyz');
        service.layers.viewTileGridLevelState.next(1, 20);
        service.layers.viewTileGridAutoLevelState.next(1, true);
        service.layers.viewTileGridColorState.next(1, 'fedcba');
        service.layers.viewTileGridOpacityState.next(1, 71);
        service.layers.setMapLayerConfig('m1', 'layerA', [
            { autoLevel: true, visible: true, level: 13 },
            { autoLevel: false, visible: false, level: 5 }
        ]);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5, 0.25]);

        service.views.numViews = 3;

        expect(service.views.numViews).toBe(3);
        expect(service.views.cameraViewDataState.getValue(2)).toEqual(service.views.cameraViewDataState.getValue(1));
        expect(service.views.cameraViewDataState.getValue(2)).not.toBe(service.views.cameraViewDataState.getValue(1));
        expect(service.views.mode2dState.getValue(2)).toBe(true);
        expect(service.layers.getLayerSyncOption(2)).toBe(true);
        expect(service.layers.getBackgroundState(2)).toEqual({ layerId: null, opacity: 17 });
        expect(service.layers.viewTileBordersState.getValue(2)).toBe(false);
        expect(service.layers.viewTileGridModeState.getValue(2)).toBe('xyz');
        expect(service.layers.viewTileGridLevelState.getValue(2)).toBe(20);
        expect(service.layers.viewTileGridAutoLevelState.getValue(2)).toBe(true);
        expect(service.layers.viewTileGridColorState.getValue(2)).toBe('fedcba');
        expect(service.layers.viewTileGridOpacityState.getValue(2)).toBe(71);
        expect(service.layers.layerVisibilityState.getValue(2)).toEqual([false]);
        expect(service.layers.layerVisibilityState.getValue(2)).not.toBe(service.layers.layerVisibilityState.getValue(1));
        expect(service.layers.layerZoomLevelState.getValue(2)).toEqual([5]);
        expect(service.layers.layerAutoZoomLevelState.getValue(2)).toEqual([false]);
        expect(service.layers.stylesState.getValue().get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.25, 0.25]);

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

        expect(service.inspections.selection).toHaveLength(1);
        expect(service.inspections.selection[0].color).toBe('#abc123');

        service.destroy();
        routerStub.events.complete();
    });

    it('converts views to degrees when setting a camera view', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const destination = new Cartographic(Math.PI / 2, Math.PI / 4, 500);
        const orientation = { heading: 1, pitch: 2, roll: 3 };

        service.views.numViews = 2;
        service.views.setView(1, destination, orientation);

        const view = service.views.cameraViewDataState.getValue(1);
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

        service.views.setView(0, destination, orientation, position);

        const view = service.views.cameraViewDataState.getValue(0);
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

        const urlState = service.views.cameraViewDataState.appState.serialize(true);
        expect(urlState).toMatchObject({
            px: '1.12345679',
            py: '-2.98765432',
            pz: '3.00000001'
        });

        const storageState = service.views.cameraViewDataState.appState.serialize(false);
        const restoredService = createStateOwners(
            createRouterStub() as unknown as Router,
            infoServiceStub
        );
        restoredService.views.cameraViewDataState.appState.deserialize(storageState!['cameraView']!);
        expect(restoredService.views.cameraViewDataState.getValue(0).position)
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

        expect(service.views.cameraViewDataState.getValue(0).position).toEqual([0, 0, 0]);

        service.destroy();
        routerStub.events.complete();
    });

    it('synchronizes the complete target-relative camera position across views', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.views.numViews = 2;
        service.views.focusedView = 0;
        const orientation = {heading: 0.25, pitch: -0.5, roll: 0};

        service.views.setView(
            0,
            Cartographic.fromDegrees(11, 48, 1000),
            orientation,
            [0, 0, 125]
        );
        service.views.setView(
            1,
            Cartographic.fromDegrees(12, 49, 2000),
            orientation,
            [0, 0, 250]
        );

        service.views.viewSync = [VIEW_SYNC_POSITION];
        service.views.setView(
            0,
            Cartographic.fromDegrees(13, 50, 3000),
            orientation,
            [0, 0, 375]
        );
        expect(service.views.cameraViewDataState.getValue(1).position).toEqual([0, 0, 375]);

        service.views.viewSync = [VIEW_SYNC_MOVEMENT];
        service.views.setView(
            0,
            Cartographic.fromDegrees(14, 51, 4000),
            orientation,
            [0, 0, 500]
        );
        expect(service.views.cameraViewDataState.getValue(0).position).toEqual([0, 0, 500]);
        expect(service.views.cameraViewDataState.getValue(1).position).toEqual([0, 0, 375]);

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

        service.views.markerState.next(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.views.markerState.next(false);
        await flushMicrotasks();
        service.views.markerState.next(true);
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
        service.layers.layerNamesState.next(['m1/layerA']);
        service.layers.layerVisibilityState.next(0, [true]);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        // Set two options for style 'overlay'
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [false]);
        await flushMicrotasks();

        // Expect StyleState internal map to contain entries for both options
        const stylesMap = service.layers.stylesState.getValue();
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

        expect(service.layers.stylesState.getValue().get('m1/layerA/overlay/opacity')).toEqual(['0.5']);

        service.destroy();
        routerStub.events.complete();
    });

    it('initializes layer config with fallback values when first requested', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        const config = service.layers.initializeMapLayerConfig('m1', 'layerA', false, 9);

        expect(config).toEqual([
            { autoLevel: true, visible: false, level: 9 },
        ]);
        expect(service.layers.layerNamesState.getValue()).toEqual(['m1/layerA']);
        expect(service.layers.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layers.layerZoomLevelState.getValue(0)).toEqual([9]);
        expect(service.layers.layerAutoZoomLevelState.getValue(0)).toEqual([true]);
        expect(service.layers.viewTileBordersState.getValue(0)).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        // Prime internal state so indices exist before updating.
        service.layers.initializeMapLayerConfig('m2', 'layerB');

        service.layers.setMapLayerConfig('m2', 'layerB', [{ autoLevel: false, visible: false, level: 7 }]);

        const config = service.layers.mapLayerConfig('m2', 'layerB');

        expect(config).toEqual([
            { autoLevel: false, visible: false, level: 7 },
        ]);
        expect(service.layers.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(service.layers.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layers.layerZoomLevelState.getValue(0)).toEqual([7]);
        expect(service.layers.layerAutoZoomLevelState.getValue(0)).toEqual([false]);
        expect(service.layers.viewTileBordersState.getValue(0)).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('reuses the last unlocked feature inspection and closes other unlocked feature inspections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
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
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.inspections.setSelection(selected);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('old-first')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-second')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.inspections.setSelection(selected, 1);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.inspections.setSelection(selected);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('locked-dialog')], locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.inspections.setSelection(selected);
        const panels = service.inspections.selection;
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

        service.layout.dockActiveTab = 'search';
        service.layout.isDockOpen = false;
        const panelId = service.inspections.setSelection([feature('new-feature', 'map/layer/new-tile')]);
        const panel = service.inspections.selection.find(item => item.id === panelId);

        expect(panel?.undocked).toBe(false);
        expect(service.layout.isDockOpen).toBe(true);
        expect(service.layout.dockActiveTab).toBe('inspection');

        service.destroy();
        routerStub.events.complete();
    });

    it('can create an undocked feature selection without stealing the dock search tab', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.layout.dockActiveTab = 'search';
        service.layout.isDockOpen = true;
        const panelId = service.inspections.setSelection(
            [feature('new-feature', 'map/layer/new-tile')],
            undefined,
            true,
            true);
        const panel = service.inspections.selection.find(item => item.id === panelId);

        expect(panel?.undocked).toBe(true);
        expect(service.layout.isDockOpen).toBe(true);
        expect(service.layout.dockActiveTab).toBe('search');

        service.destroy();
        routerStub.events.complete();
    });

    it('reuses an unlocked floating feature inspection even when it focuses an attribute target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
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
        ];
        service.layout.dockActiveTab = 'search';
        service.layout.isDockOpen = true;

        const panelId = service.inspections.setSelection(
            [feature('Road.2', 'map/layer/tile')],
            undefined,
            false,
            true);

        expect(panelId).toBe(1);
        expect(service.inspections.selection.find(panel => panel.id === 1)?.features).toEqual([feature('Road.2', 'map/layer/tile')]);
        expect(service.inspections.selection.find(panel => panel.id === 2)).toBeDefined();
        expect(service.layout.dockActiveTab).toBe('search');

        service.destroy();
        routerStub.events.complete();
    });

    it('toggles an inspection panel between base feature and attribute-validity target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
            {
                id: 7,
                features: [feature('Road.1', 'map/layer/tile')],
                locked: true,
                size: [30, 20],
                color: '#111111',
                undocked: false
            }
        ];

        service.inspections.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(service.inspections.selection[0].features[0].featureId).toBe('Road.1:attribute#2:validity#0');
        expect(service.inspections.selection[0].locked).toBe(true);

        service.inspections.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(service.inspections.selection[0].features[0].featureId).toBe('Road.1');

        service.destroy();
        routerStub.events.complete();
    });

    it('preserves transient inspection tree header expansion state defensively', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);
        const expandedNodes = new Map<string, boolean | undefined>([['root', true], ['child', false]]);
        const restoreSnapshot = new Map<string, boolean | undefined>([['root', false]]);

        service.inspections.setInspectionTreeExpansionState(7, {
            expandedNodes,
            fullExpansionActive: true,
            expansionSnapshotBeforeFullExpand: restoreSnapshot,
            fullCollapseActive: false
        });
        expandedNodes.set('root', false);
        restoreSnapshot.set('root', true);

        const firstRead = service.inspections.getInspectionTreeExpansionState(7)!;
        expect(firstRead.expandedNodes.get('root')).toBe(true);
        expect(firstRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);
        expect(firstRead.fullExpansionActive).toBe(true);
        expect(firstRead.fullCollapseActive).toBe(false);

        firstRead.expandedNodes.set('root', false);
        firstRead.expansionSnapshotBeforeFullExpand?.set('root', true);

        const secondRead = service.inspections.getInspectionTreeExpansionState(7)!;
        expect(secondRead.expandedNodes.get('root')).toBe(true);
        expect(secondRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps SourceData column defaults and per-panel overrides out of the URL', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        service.inspections.selection = [{
            id: 7,
            features: [],
            locked: false,
            size: [30, 20],
            color: '#ffffff',
            undocked: false
        }];

        service.inspections.sourceDataInspectionDefaultColumns = ["schemaType"];
        service.inspections.setInspectionTreeHiddenColumns(7, ["displayAddress"]);

        expect(service.inspections.sourceDataInspectionDefaultColumns).toEqual(["schemaType"]);
        expect(service.inspections.getInspectionTreeHiddenColumns(7)).toEqual(["displayAddress"]);
        expect(service.inspections.sourceDataInspectionDefaultColumnsState.serialize(true)).toBeUndefined();
        expect(service.inspections.inspectionTreeHiddenColumnsState.serialize(true)).toBeUndefined();

        service.inspections.selection = [];
        expect(service.inspections.getInspectionTreeHiddenColumns(7)).toBeUndefined();

        service.destroy();
        routerStub.events.complete();
    });

    it('focuses inspection panels when selections create, reuse, or target an existing panel', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = feature('new-feature', 'map/layer/new-tile');
        expect(service.inspections.setSelection([selected])).toBe(2);
        expect(service.inspections.focusedInspectionPanelId).toBe(2);
        expect(service.inspections.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        service.inspections.focusedInspectionPanelId = 1;
        expect(service.inspections.setSelection([selected])).toBeUndefined();
        expect(service.inspections.focusedInspectionPanelId).toBe(2);
        expect(service.inspections.selection.find(panel => panel.id === 1)?.focused).toBeUndefined();
        expect(service.inspections.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        const serializedSelection = service.inspections.selectionState.serialize(false)?.['selected'] ?? '';
        expect(serializedSelection).toContain('2~0f~');

        service.destroy();
        routerStub.events.complete();
    });

    it('reopens the dock for default feature selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.layout.isDockOpen = false;
        service.inspections.selection = [
            { id: 1, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#111111', undocked: false }
        ];

        service.inspections.setSelection([feature('old-feature')]);
        expect(service.layout.isDockOpen).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('does not replace unlocked SourceData with a feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:1'), locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 2, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.inspections.setSelection(selected);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const nextSourceData = sourceData('SourceData:m1:SourceData-LAYER:3');
        const targetPanelId = service.inspections.setSelection(nextSourceData);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = service.inspections.setSelection(sourceData('SourceData:m1:SourceData-LAYER:9'));
        const panels = service.inspections.selection;
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

        service.inspections.selection = [
            { id: 1, features: [feature('remove-me')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('fallback')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ];
        service.inspections.focusedInspectionPanelId = 1;

        service.inspections.unsetPanel(1);

        expect(service.inspections.focusedInspectionPanelId).toBe(2);
        expect(service.inspections.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps SourceData selection in the same panel when requested by SourceData panel id even if locked', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:3'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = service.inspections.setSelection(sourceData('SourceData:m1:SourceData-LAYER:7'), 1);
        const panels = service.inspections.selection;

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
        service.inspections.selection = [
            {
                id: 1,
                features: [duplicated],
                sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'),
                locked: false,
                size: [30, 40],
                color: '#111111',
                undocked: true,
            },
        ];

        const targetPanelId = service.inspections.setSelection([duplicated]);
        const panels = service.inspections.selection;
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

        service.inspections.selection = [
            { id: 1, features: [feature('remove-me')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('stay-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];

        service.inspections.unsetUnlockedSelections();
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 1, features: [feature('remove-a')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('remove-b')], locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('keep-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
            { id: 4, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:8'), locked: false, size: [30, 40], color: '#444444', undocked: true },
        ];

        service.inspections.unsetUnlockedSelections();

        const mergedFeatures = [feature('merged-1'), feature('merged-2'), feature('merged-3')];
        const createdIds = mergedFeatures.map(selected => service.inspections.setSelection([selected], undefined, true));
        const definedIds = createdIds.filter((panelId): panelId is number => panelId !== undefined);
        const panels = service.inspections.selection;

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

        service.inspections.selection = [
            { id: 11, features: [], locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 22, features: [], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        service.inspections.setInspectionDialogPosition(11, { left: 10, top: 20 }, 0);
        service.inspections.setInspectionDialogPosition(22, { left: 30, top: 40 }, 0);

        const first = service.inspections.getInspectionDialogLayout(11);
        const second = service.inspections.getInspectionDialogLayout(22);
        expect(first?.slot).toBe(0);
        expect(second?.slot).toBe(0);

        service.inspections.setInspectionDialogPosition(11, { left: 12, top: 24 }, 9);
        expect(service.inspections.getInspectionDialogLayout(11)?.slot).toBe(0);

        service.inspections.pruneInspectionDialogLayout([22]);
        expect(service.inspections.getInspectionDialogLayout(11)).toBeUndefined();
        expect(service.inspections.getInspectionDialogLayout(22)?.position).toEqual({ left: 30, top: 40 });

        service.destroy();
        routerStub.events.complete();
    });

    it('persists comparison and layout states after hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        service.inspections.selection = [
            { id: 5, features: [], locked: false, size: [30, 40], color: '#555555', undocked: true },
        ];
        service.inspections.setInspectionDialogPosition(5, { left: 100, top: 200 }, 3);
        service.inspections.openInspectionComparison({
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

        service.inspections.closeInspectionComparison();
        await flushMicrotasks();
        expect(service.inspections.inspectionComparison).toBeNull();

        service.destroy();
        routerStub.events.complete();
    });

    it('removes a compared other panel when unsetPanel is called', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.inspections.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ];
        service.inspections.openInspectionComparison({
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

        service.inspections.unsetPanel(2);

        expect(service.inspections.inspectionComparison).toEqual({
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

        service.inspections.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
            { id: 3, features: [feature('f3')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];
        service.inspections.openInspectionComparison({
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

        service.inspections.unsetPanel(1);

        expect(service.inspections.inspectionComparison).toEqual({
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

        service.inspections.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];
        service.inspections.openInspectionComparison({
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

        service.inspections.unsetUnlockedSelections();

        expect(service.inspections.inspectionComparison).toEqual({
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
        expect(service.connection.connectionRetryPolicy.initialDelayMs).toBe(7000);
        service.connection.setConnectionRetryPolicy({...service.connection.connectionRetryPolicy, enabled: false, backoffMultiplier: 3});
        expect(service.persistence.exportSnapshot()).toMatchObject({connectionRetryEnabled: 0,
            connectionRetryInitialDelayMs: 7000, connectionRetryBackoffMultiplier: 3});
        expect(() => service.connection.setConnectionRetryPolicy({...service.connection.connectionRetryPolicy, maxDelayMs: 0})).toThrow();
        expect(service.connection.connectionRetryPolicy.maxDelayMs).toBe(90000);
        service.destroy();
        routerStub.events.complete();
    });

    it('shares validated point-cloud preferences across config, snapshots and persisted state', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        expect(service.persistence.seedConfigDefaultState({pointCloudDetailPixels: 4,
            pointCloudGpuMemoryMiB: 128}, 'point-cloud-config')).toEqual([]);
        expect(service.views.pointCloudPolicy.detailPixels).toBe(4);
        service.views.setPointCloudPolicy({...service.views.pointCloudPolicy, enabled: false, workingMemoryMiB: 256});
        const snapshot = service.persistence.exportSnapshot();
        expect(snapshot).toMatchObject({pointCloudDownsamplingEnabled: 0,
            pointCloudDetailPixels: 4, pointCloudWorkingMemoryMiB: 256, pointCloudGpuMemoryMiB: 128});
        expect(service.views.pointCloudDetailPixelsState.isUrlState()).toBe(false);
        expect(() => service.views.setPointCloudPolicy({...service.views.pointCloudPolicy, gpuMemoryMiB: 0})).toThrow();
        expect(service.views.pointCloudPolicy.gpuMemoryMiB).toBe(128);
        expect(service.persistence.importSnapshot({pointCloudDetailPixels: 8})).toEqual([]);
        expect(service.views.pointCloudPolicy.detailPixels).toBe(8);
        expect(service.persistence.importSnapshot({pointCloudWorkingMemoryMiB: -1}).length).toBeGreaterThan(0);
        expect(service.views.pointCloudPolicy.workingMemoryMiB).toBe(256);
        service.destroy();
        routerStub.events.complete();
    });

    it('exports app state entries with compact style option storage keys', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.views.markerState.next(true);
        service.layers.layerNamesState.next(['m1/layerA']);
        service.layers.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
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

        service.layout.openDialog('advanced-preferences-dialog');
        const snapshot = service.persistence.exportSnapshot();

        expect(snapshot).not.toHaveProperty('advancedPreferencesDialogVisible');

        service.destroy();
        routerStub.events.complete();
    });

    it('keeps coordinate preference and legal acceptance out of URLs and snapshots', () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());

        service.coordinatePolicy.coordinatesEnabledState.next(false);
        service.coordinatePolicy.coordinatesLegalTermsAcceptedState.next(true);

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
        expect(service.layout.isDialogOpen('advanced-preferences-dialog')).toBe(true);

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
        expect(service.layout.isDialogOpen('styles-dialog')).toBe(true);
        expect(service.layout.isDialogOpen('style-editor-dialog')).toBe(true);
        expect(service.styleEditor.styleEditorTargetId).toBe('generic');

        service.destroy();
        routerStub.events.complete();
    });

    it('rejects snapshot imports with unknown top-level keys and applies nothing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.views.markerState.next(false);
        const errors = service.persistence.importSnapshot({
            marker: true,
            unknownState: 1
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.views.markerState.getValue()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('imports valid partial snapshots and keeps missing states unchanged', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub);

        service.views.markerState.next(false);

        const errors = service.persistence.importSnapshot({
            marker: true
        });

        expect(errors).toEqual([]);
        expect(service.views.markerState.getValue()).toBe(true);
        expect(service.layout.isDialogOpen('preferences-dialog')).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });

    it('resets omitted query-scene state and replaces camera and style options', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        service.layers.mapsOpenState.next(true);
        service.layers.stylesState.next(new Map([['old/Lane/style/topology', [true]]]));
        await service.persistence.replaceUrlState({v2: '1', n: '1', lon: '11.66', lat: '48.25', alt: '128000', map: 'Very-Large-Map', l: 'Road:0', v: '1'}, true);
        expect(service.layers.mapsOpenState.getValue()).toBe(false);
        expect(service.layers.stylesState.getValue().has('old/Lane/style/topology')).toBe(false);
        expect(service.layers.layerNamesState.getValue()).toEqual(['Very-Large-Map/Road']);
        expect(service.views.cameraViewDataState.getValue(0).destination.lon).toBeCloseTo(11.66);
        expect(service.views.cameraViewDataState.getValue(0).destination.lat).toBeCloseTo(48.25);
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

        service.views.markerState.next(false);
        const errors = service.persistence.replaceSnapshotState({
            marker: true,
            unknownPresentationState: 1
        });

        expect(errors).not.toEqual([]);
        expect(service.views.markerState.getValue()).toBe(false);
        expect(stateApplied).not.toHaveBeenCalled();

        service.destroy();
        routerStub.events.complete();
    });

    it('replaces presentation state, resets omissions, and clears stale style options without persistence', async () => {
        const routerStub = createRouterStub();
        const service = createStateOwners(routerStub as unknown as Router, infoServiceStub());
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        service.views.markerState.next(true);
        service.layers.mapsOpenState.next(true);
        service.layers.layerNamesState.next(['m1/layerA']);
        service.layers.stylesState.next(new Map([
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
        expect(service.views.markerState.getValue()).toBe(false);
        expect(service.layers.mapsOpenState.getValue()).toBe(false);
        expect(service.layers.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(service.layers.stylesState.getValue().has('m1/layerA/overlay/stale')).toBe(false);
        expect(service.layers.stylesState.getValue().get('m2/layerB/overlay/opacity')).toEqual(['0.75']);
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
        expect(service.layers.stylesState.getValue().get('m1/layerA/overlay/opacity')).toEqual(['0.5']);
        expect(service.layers.stylesState.getValue().get('m1/layerA/overlay/debug')).toEqual(['1']);

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
        expect(service.views.markerState.getValue()).toBe(false);
        expect(service.layers.stylesState.getValue().size).toBe(0);

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
        expect(service.views.markerState.getValue()).toBe(false);

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
        expect(service.layers.stylesState.getValue().size).toBe(0);

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
        expect(service.layers.stylesState.getValue().size).toBe(0);

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
        expect(service.config.erdblickVersion.getValue()).toBe('');

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
        expect(service.layers.stylesState.getValue().size).toBe(0);

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

        expect(service.views.markerState.getValue()).toBe(true);
        expect(service.views.featureZoomClearanceMeters).toBe(35);

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

        expect(service.coordinatePolicy.coordinatesEnabledState.getValue()).toBe(false);
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

        expect(service.views.markerState.getValue()).toBe(false);

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

        expect(service.views.markerState.getValue()).toBe(true);

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

        expect(service.views.markerState.getValue()).toBe(false);

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

        expect(service.views.markerState.getValue()).toBe(true);

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

        expect(service.views.markerState.getValue()).toBe(false);
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

        expect(service.views.markerState.getValue()).toBe(false);

        service.destroy();
        routerStub.events.complete();
    });
});
