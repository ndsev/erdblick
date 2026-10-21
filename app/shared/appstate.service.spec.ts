import "@angular/compiler";
import { stateOwners } from '../../test/state-owners';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

import type { Event, Router } from '@angular/router';
import { NavigationEnd, NavigationStart } from '@angular/router';
import { Cartographic } from '../integrations/geo';

import { AppStateService } from "./appstate.service";
import { VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION } from "../mapview/map-view-state.model";
import { MapTreeNode } from "../mapdata/map.tree.model";

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
    version: { major: 1, minor: 0, patch: 0 },
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        stateOwners(service).coordinates.markerState.next(false);
        await flushMicrotasks();

        expect(localStorage.getItem('marker')).toBe('0');
        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '0', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('replaces and hydrates URL state through the explicit runtime boundary', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();
        const appliedMarkerValues: boolean[] = [];
        service.stateApplied.subscribe(() => {
            appliedMarkerValues.push(stateOwners(service).coordinates.markerState.getValue());
        });

        await service.replaceUrlState({ v2: '1', m: '1' });

        expect(routerStub.navigate).toHaveBeenCalledWith([], {
            queryParams: { v2: '1', m: '1' },
            queryParamsHandling: 'replace',
            replaceUrl: true,
        });
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);
        expect(appliedMarkerValues).toEqual([true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects explicit URL replacement before persistence is ready', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        await expect(service.replaceUrlState({ v2: '1' })).rejects.toThrow('before AppStateService is ready');
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps selected features with packed tile ids during datasource pruning', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).inspectionState.selection = [{
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

        stateOwners(service).inspectionState.pruneCatalog(new Map([
            ["Very-Large-Map", new MapTreeNode({
                mapId: "Very-Large-Map",
                sourceId: "Very-Large-Map",
                stringPoolId: "Very-Large-Map",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: { Road: layerInfo("Road") },
            } as any)]
        ]));

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].features[0].mapTileKey).toBe("Features:Very-Large-Map:Road:22100770000d");
    });

    it('keeps selected features while datasource layers are still initializing', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).inspectionState.selection = [{
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

        stateOwners(service).inspectionState.pruneCatalog(new Map([
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
        ]));

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].features[0].mapTileKey).toBe("Features:Very-Large-Map:Road:545554858");
    });

    it('preserves focused selection metadata while pruning unavailable selections', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).inspectionState.selection = [{
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

        stateOwners(service).inspectionState.pruneCatalog(new Map([
            ["Very-Large-Map", new MapTreeNode({
                mapId: "Very-Large-Map",
                sourceId: "Very-Large-Map",
                stringPoolId: "Very-Large-Map",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: { Road: layerInfo("Road") },
            } as any)]
        ]));

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].focused).toBe(true);
        expect(stateOwners(service).inspectionState.selection[0].features).toEqual([
            feature("Road.1", "Features:Very-Large-Map:Road:545554858"),
        ]);
    });

    it('keeps selections whose MapTileKey encodes slashes in the map id', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).inspectionState.selection = [{
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

        stateOwners(service).inspectionState.pruneCatalog(new Map([
            ["Provider/Sample Munich", new MapTreeNode({
                mapId: "Provider/Sample Munich",
                sourceId: "Provider/Sample Munich",
                stringPoolId: "Provider/Sample Munich",
                maxParallelJobs: 1,
                addOn: false,
                extraJsonAttachment: {},
                layers: { Landmark: layerInfo("Landmark") },
            } as any)]
        ]));

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].focused).toBe(true);
        expect(stateOwners(service).inspectionState.selection[0].features[0]).toEqual(feature(
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const serviceRenderPreferences = stateOwners(service).renderPreferences;

        expect(serviceRenderPreferences.lod3TileThreshold).toBe(128);

        serviceRenderPreferences.lod3TileThreshold = 1024;
        expect(serviceRenderPreferences.lod3TileThreshold).toBe(1024);

        serviceRenderPreferences.lod3TileThreshold = 9999;
        expect(serviceRenderPreferences.lod3TileThreshold).toBe(4096);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('normalizes the persisted subset-render worker preference', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(
            routerStub as unknown as Router,
            infoServiceStub()
        );
        stateOwners(service);
        const serviceRenderPreferences = stateOwners(service).renderPreferences;

        expect(serviceRenderPreferences.tileSubsetRenderWorkerCount).toBe(0);

        serviceRenderPreferences.tileSubsetRenderWorkerCount = 999;

        expect(serviceRenderPreferences.tileSubsetRenderWorkerCount).toBe(32);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists a bounded drill-pick radius without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        expect(stateOwners(service).inspectionState.drillPickRadius).toBe(3);

        stateOwners(service).inspectionState.drillPickRadius = 7.8;
        expect(stateOwners(service).inspectionState.drillPickRadius).toBe(7);

        stateOwners(service).inspectionState.drillPickRadius = -100;
        expect(stateOwners(service).inspectionState.drillPickRadius).toBe(1);

        stateOwners(service).inspectionState.drillPickRadius = 100;
        expect(stateOwners(service).inspectionState.drillPickRadius).toBe(10);
        expect(service.exportSnapshot()).toHaveProperty('drillPickRadius', 10);
        expect((service as any).serializeUrlV2()).not.toHaveProperty('drillPickRadius');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists bounded feature zoom clearance without adding it to shared URLs', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(20);

        stateOwners(service).viewSettings.featureZoomClearanceMeters = 37.5;
        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(37.5);

        stateOwners(service).viewSettings.featureZoomClearanceMeters = -1;
        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(0);

        stateOwners(service).viewSettings.featureZoomClearanceMeters = 101;
        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(100);
        expect(service.exportSnapshot()).toHaveProperty(
            'featureZoomClearanceMeters',
            100
        );
        expect((service as any).serializeUrlV2()).not.toHaveProperty(
            'featureZoomClearanceMeters'
        );

        service.ngOnDestroy();
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
        const service = new AppStateService(
            routerStub as unknown as Router,
            infoServiceStub()
        );
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(expected);
        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const serviceRenderPreferences = stateOwners(service).renderPreferences;

        expect(serviceRenderPreferences.deckAntialiasingEnabled).toBe(true);
        expect(serviceRenderPreferences.semanticCompositingEnabled).toBe(true);
        expect(serviceRenderPreferences.contactShadingEnabled).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists semantic compositing locally without adding it to shared URLs', async () => {
        localStorage.setItem('semanticCompositingEnabled', '0');
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        const serviceRenderPreferences = stateOwners(service).renderPreferences;

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(serviceRenderPreferences.semanticCompositingEnabled).toBe(false);
        expect(serviceRenderPreferences.semanticCompositingEnabledState.serialize(true)).toBeUndefined();

        serviceRenderPreferences.semanticCompositingEnabled = true;
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('1');

        serviceRenderPreferences.semanticCompositingEnabled = false;
        await flushMicrotasks();
        expect(localStorage.getItem('semanticCompositingEnabled')).toBe('0');
        expect(serviceRenderPreferences.semanticCompositingEnabledState.serialize(true)).toBeUndefined();

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.focusedInspectionPanelId).toBe(5);
        expect(stateOwners(service).inspectionState.selection[0].focused).toBe(true);

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].features[0]).toEqual({
            mapTileKey: 'Features:Very-Large-Map:Road:220e0770000d:0',
            featureId: 'Road.545554686.6:attribute#1:validity#0'
        });
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).viewSettings.numViews).toBe(2);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual(['MapA/Lane', 'MapB/Road']);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(0)).toEqual([true, false]);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(1)).toEqual([false, true]);
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(0)).toEqual([12, 13]);
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(1)).toEqual([14, 15]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(0)).toEqual([true, true]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(1)).toEqual([false, false]);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('MapA/Lane/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('MapB/Road/T93C/showCenterLines')).toEqual(['1', '0']);
        expect(stateOwners(service).inspectionState.selection).toEqual([
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
        expect(stateOwners(service).inspectionState.focusedInspectionPanelId).toBe(1);
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection).toEqual([]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates legacy selection payloads even when a v2 URL marker is present', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            map: 'MapA',
            l: 'Road:0',
            sel: '5~1f~Features:MapA:Road:tile-1:0~Road.1:attribute#0:validity#0~30:20~abc123~0',
        });
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].id).toBe(5);
        expect(stateOwners(service).inspectionState.selection[0].focused).toBe(true);
        expect(stateOwners(service).inspectionState.selection[0].features[0]).toEqual({
            mapTileKey: 'Features:MapA:Road:tile-1:0',
            featureId: 'Road.1:attribute#0:validity#0',
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates v2 selected feature MapTileKeys through the C++ serializer', async () => {
        const routerStub = createRouterStub({
            v2: '1',
            map: 'Provider%2FSample%20Munich',
            l: 'Road:0',
            sel: '0~0~F:0:545555209~Road.545555209.387~30,20~n0',
        });
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection[0].features[0]).toEqual({
            mapTileKey: 'Features:Provider%2FSample Munich:Road:545555209',
            featureId: 'Road.545555209.387',
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps stored inspections and feature-search state when stale empty URL params exist', async () => {
        localStorage.setItem('selected', JSON.stringify([
            '5~1f~Features:map:layer:tile~feature-1~30:20~abc123~0'
        ]));
        localStorage.setItem('featureSearchState', JSON.stringify([
            { id: 'feature-search-1', query: '**.speed > 80' }
        ]));
        const routerStub = createRouterStub({ sel: '', s: '[]' });
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].features).toEqual([feature('feature-1', 'Features:map:layer:tile')]);
        expect(stateOwners(service).searchService.featureSearches).toHaveLength(1);
        expect(stateOwners(service).searchService.featureSearches[0].query).toBe('**.speed > 80');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('explicitly restores persisted dialogs and panels without waiting for NavigationEnd', async () => {
        localStorage.setItem('dialogLayouts', JSON.stringify({
            'preferences-dialog': {
                position: { left: 10, top: 20 },
                size: { width: 400, height: 300 },
                open: true
            }
        }));
        localStorage.setItem('dockOpenState', '1');
        localStorage.setItem('dockActiveTabState', JSON.stringify('search'));
        localStorage.setItem('selected', JSON.stringify([
            '7~1f~Features:map:layer:tile~feature-7~30:20~abcdef~0'
        ]));
        localStorage.setItem('featureSearchState', JSON.stringify([
            { id: 'feature-search-7', query: '**.speed > 80' }
        ]));
        const routerStub = createRouterStub();
        const infoServiceStub = {
            showError: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            registerDefaultContainer: vi.fn(),
            showAlertDialogDefault: vi.fn()
        } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        service.initializePersistence();
        await flushMicrotasks();

        expect(service.ready.getValue()).toBe(true);
        expect(stateOwners(service).layout.isDialogOpen('preferences-dialog')).toBe(true);
        expect(stateOwners(service).layout.isDockOpen).toBe(true);
        expect(stateOwners(service).layout.dockActiveTab).toBe('search');
        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].id).toBe(7);
        expect(stateOwners(service).searchService.featureSearches).toHaveLength(1);
        expect(stateOwners(service).searchService.featureSearches[0].id).toBe('feature-search-7');

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        stateOwners(service).viewSettings.numViews = 2;

        service.initializePersistence();
        stateOwners(service).searchService.addFeatureSearch({ query: '**.speed > 80' });
        await flushMicrotasks();

        const stored = JSON.parse(localStorage.getItem('featureSearchState') ?? '[]');
        expect(stored[0].selectedMapLayers).toEqual([]);
        expect(stored[0].selectedTileLevels).toEqual([]);
        expect(stored[0].selectedViewIndices).toEqual([0, 1]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('drops retired omnibox search URL params while preserving unknown params', () => {
        const routerStub = createRouterStub({
            s: JSON.stringify(['features', '**.speed > 80']),
            external: 'keep-me',
        });
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        const params = (service as any).serializeUrlV2();
        expect(params.s).toBeUndefined();
        expect(params.external).toBe('keep-me');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('shares current cameras, layers and selections without copying unknown URL credentials', async () => {
        window.history.pushState({}, '', '/viewer/?access_token=secret&external=private#token');
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        const restoreRouter = createRouterStub();
        let restored: AppStateService | undefined;
        try {
            stateOwners(service).layerState.layerNames = ['Map/Lane'];
            stateOwners(service).layerState.setMapLayerConfig('Map', 'Lane', [{ visible: true, level: 13, autoLevel: false }]);
            stateOwners(service).viewSettings.cameraViewDataState.next(0, {
                destination: { lon: 11, lat: 48, alt: 900 },
                orientation: { heading: 0, pitch: -0.75, roll: 0 }, position: [0, 0, 0]
            });
            stateOwners(service).inspectionState.selection = [{
                id: 0, features: [{ mapTileKey: 'Features:Map:Lane:545379780', featureId: 'Lane.1' }],
                locked: true, size: [30, 20], color: '#fff314', undocked: false
            }];
            const previous = window.location.href;
            const link = new URL(service.shareableUrl());
            expect(window.location.href).toBe(previous);
            expect(link.pathname).toBe('/viewer/');
            expect(link.searchParams.has('access_token')).toBe(false);
            expect(link.searchParams.has('external')).toBe(false);
            expect(link.hash).toBe('');
            expect(link.searchParams.get('sel')).toContain('Lane.1');
            expect(routerStub.navigate).not.toHaveBeenCalled();

            window.history.pushState({}, '', link.href);
            restored = new AppStateService(restoreRouter as unknown as Router, infoServiceStub());
            stateOwners(restored);
            restoreRouter.events.next(new NavigationEnd(1, '/', '/'));
            await flushMicrotasks();
            expect(stateOwners(restored).layerState.layerNames).toEqual(['Map/Lane']);
            expect(stateOwners(restored).layerState.layerVisibilityState.getValue(0)).toEqual([true]);
            expect(stateOwners(restored).viewSettings.cameraViewDataState.getValue(0)).toEqual(stateOwners(service).viewSettings.cameraViewDataState.getValue(0));
            expect(stateOwners(restored).inspectionState.selection[0].features).toEqual(stateOwners(service).inspectionState.selection[0].features);
        } finally {
            restored?.ngOnDestroy();
            service.ngOnDestroy();
            restoreRouter.events.complete();
            routerStub.events.complete();
        }
    });

    it('serializes active and selected-feature layers against one URL layer order', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        stateOwners(service).layerState.layerNamesState.next(['MapA/Lane', 'MapC/POI']);
        stateOwners(service).layerState.layerVisibilityState.next(0, [true, false]);
        stateOwners(service).layerState.layerZoomLevelState.next(0, [12, 15]);
        stateOwners(service).layerState.layerAutoZoomLevelState.next(0, [false, false]);
        stateOwners(service).inspectionState.selection = [{
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

        const params = (service as any).serializeUrlV2();
        expect(params).toMatchObject({
            v2: '1',
            map: 'Map:A,B',
            l: 'Lane:0~Road:1',
            v: '1,0',
            z: '12,13',
            az: '0,1',
            sel: '0~0~F:1:21~Road.1~30,20~n0',
        });

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        const config = stateOwners(service).layerState.materializeLayerDefaults('Classic-2.5.2-Sample', 'NDS.Classic-BMD');
        expect(config).toEqual([
            { autoLevel: true, visible: false, level: 13 },
        ]);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual([
            'MapA/Lane',
            'MapB/Road',
            'Classic-2.5.2-Sample/NDS.Classic-BMD',
        ]);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(0)).toEqual([true, true, false]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('serializes an empty active layer list as an authoritative v2 layer list', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        stateOwners(service).layerState.layerNamesState.next(['MapA/Lane']);
        stateOwners(service).layerState.layerVisibilityState.next(0, [false]);

        const params = (service as any).serializeUrlV2();
        expect(params.l).toBe('');
        expect(params.v).toBeUndefined();
        expect(params.z).toBeUndefined();
        expect(params.az).toBeUndefined();

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const stateApplied = vi.fn();
        service.stateApplied.subscribe(stateApplied);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        (service as any).lastUrlSyncAt = Date.now();
        stateOwners(service).coordinates.markerState.next(true);
        await flushMicrotasks();
        expect((service as any).urlSyncHandle).not.toBeNull();
        expect((service as any).pendingUrlSyncStates.size).toBeGreaterThan(0);

        routerStub.routerState.snapshot.root!.queryParams = { m: '0' };
        // @ts-expect-error this is a call to mock router
        routerStub.getCurrentNavigation.mockReturnValue({ trigger: 'popstate' });
        routerStub.events.next(new NavigationStart(2, '/?m=0'));
        routerStub.events.next(new NavigationEnd(2, '/?m=0', '/?m=0'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);
        expect(stateApplied).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(100);
        await flushMicrotasks();
        expect(routerStub.navigate).not.toHaveBeenCalled();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates marked position from CSV query params', async () => {
        const routerStub = createRouterStub({ mp: '11.141985707869166,48.002375728153766' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markedPositionState.getValue()).toEqual([11.14198571, 48.00237573]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('serializes marked position to a CSV query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        stateOwners(service).coordinates.markedPositionState.next([11.141985707869166, 48.002375728153766, 125.123456789]);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                v2: '1',
                mp: '11.14198571,48.00237573,125.12345679',
            }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).coordinates.setMarkerPosition(Cartographic.fromDegrees(11.25, 48.5, 127.75));

        expect(stateOwners(service).coordinates.markedPosition).toEqual([11.25, 48.5, 127.75]);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates background-layer settings from combined query params', async () => {
        const routerStub = createRouterStub({ n: '2', bg: 'osm~50,world-overview~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).viewSettings.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(stateOwners(service).viewSettings.getBackgroundState(1)).toEqual({ layerId: 'world-overview', opacity: 30 });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('serializes background-layer settings into a single bg query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        stateOwners(service).viewSettings.setBackgroundState(0, 'osm', 50);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                v2: '1',
                bg: 'osm~50',
            }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('migrates legacy osm query params into the new background-layer state', async () => {
        const routerStub = createRouterStub({ n: '2', osm: '1~50,0~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).viewSettings.getBackgroundState(0)).toEqual({ layerId: 'osm', opacity: 50 });
        expect(stateOwners(service).viewSettings.getBackgroundState(1)).toEqual({ layerId: null, opacity: 30 });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('uses the configured default background opacity when a persisted layer no longer exists', async () => {
        const routerStub = createRouterStub({ bg: 'world-overview~100' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        const resolvedState = stateOwners(service).viewSettings.resolveBackgroundState(
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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('seeds the second view from the primary view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const destination = Cartographic.fromDegrees(11.25, 48.5, 987654);
        const orientation = { heading: 1.25, pitch: -0.75, roll: 0.125 };

        stateOwners(service).viewSettings.setView(0, destination, orientation);
        stateOwners(service).viewSettings.setProjectionMode(0, true);
        stateOwners(service).layerState.setLayerSyncOption(0, true);
        stateOwners(service).viewSettings.setBackgroundState(0, null, 42);
        stateOwners(service).viewSettings.viewTileBordersState.next(0, false);
        stateOwners(service).viewSettings.viewTileGridModeState.next(0, 'xyz');
        stateOwners(service).viewSettings.viewTileGridLevelState.next(0, 18);
        stateOwners(service).viewSettings.viewTileGridAutoLevelState.next(0, true);
        stateOwners(service).viewSettings.viewTileGridColorState.next(0, '123abc');
        stateOwners(service).viewSettings.viewTileGridOpacityState.next(0, 64);
        stateOwners(service).layerState.materializeLayerDefaults('m1', 'layerA', false, 9);
        stateOwners(service).layerState.setMapLayerConfig('m1', 'layerA', [{ autoLevel: false, visible: true, level: 7 }]);

        stateOwners(service).viewSettings.numViews = 2;

        expect(stateOwners(service).viewSettings.numViews).toBe(2);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1)).toEqual(stateOwners(service).viewSettings.cameraViewDataState.getValue(0));
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1)).not.toBe(stateOwners(service).viewSettings.cameraViewDataState.getValue(0));
        expect(stateOwners(service).viewSettings.mode2dState.getValue(1)).toBe(true);
        expect(stateOwners(service).layerState.getLayerSyncOption(1)).toBe(true);
        expect(stateOwners(service).viewSettings.getBackgroundState(1)).toEqual({ layerId: null, opacity: 42 });
        expect(stateOwners(service).viewSettings.viewTileBordersState.getValue(1)).toBe(false);
        expect(stateOwners(service).viewSettings.viewTileGridModeState.getValue(1)).toBe('xyz');
        expect(stateOwners(service).viewSettings.viewTileGridLevelState.getValue(1)).toBe(18);
        expect(stateOwners(service).viewSettings.viewTileGridAutoLevelState.getValue(1)).toBe(true);
        expect(stateOwners(service).viewSettings.viewTileGridColorState.getValue(1)).toBe('123abc');
        expect(stateOwners(service).viewSettings.viewTileGridOpacityState.getValue(1)).toBe(64);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(1)).toEqual([true]);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(1)).not.toBe(stateOwners(service).layerState.layerVisibilityState.getValue(0));
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(1)).toEqual([7]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(1)).toEqual([false]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('copies style option values into the second view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [true]);

        stateOwners(service).viewSettings.numViews = 2;

        const stylesMap = stateOwners(service).layerState.stylesState.positionalValues();
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([true, true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it.each([0, 1])('retains the other view when view %i is removed', (removed) => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).viewSettings.numViews = 2;
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        for (const index of [0, 1]) {
            stateOwners(service).viewSettings.cameraViewDataState.next(index, {
                destination: { lon: 11 + index, lat: 48 + index, alt: 1000 + index },
                orientation: { heading: index, pitch: -0.5, roll: 0 },
                position: [index, index + 1, index + 2]
            });
            stateOwners(service).viewSettings.mode2dState.next(index, index === 0);
            stateOwners(service).layerState.setLayerSyncOption(index, index === 1);
            stateOwners(service).viewSettings.setBackgroundState(index, index === 0 ? 'osm' : null, 20 + index);
            stateOwners(service).layerState.layerVisibilityState.next(index, [index === 1]);
            stateOwners(service).layerState.layerZoomLevelState.next(index, [12 + index]);
            stateOwners(service).layerState.layerAutoZoomLevelState.next(index, [index === 0]);
            stateOwners(service).viewSettings.viewTileBordersState.next(index, index === 1);
            stateOwners(service).viewSettings.viewTileGridModeState.next(index, index === 0 ? 'nds' : 'xyz');
            stateOwners(service).viewSettings.viewTileGridLevelState.next(index, 8 + index);
            stateOwners(service).viewSettings.viewTileGridAutoLevelState.next(index, index === 0);
            stateOwners(service).viewSettings.viewTileGridColorState.next(index, index === 0 ? '123abc' : 'abcdef');
            stateOwners(service).viewSettings.viewTileGridOpacityState.next(index, 30 + index);
            stateOwners(service).layerState.setMapPresetSelection(index, 'm1', `map-preset-${index}`);
            stateOwners(service).layerState.setLayerPresetSelection(index, 'm1', 'layerA', { styleId: 'overlay', presetId: `preset-${index}` });
        }
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.2, 0.8]);
        const searches = [[0], [1], [0, 1]].map(selectedViewIndices =>
            stateOwners(service).searchService.addFeatureSearch({ query: 'Way', selectedViewIndices }));
        stateOwners(service).inspectionState.setSelection([feature('Way.1')]);
        const selection = stateOwners(service).inspectionState.selectionState.getValue();
        const survivor = 1 - removed;
        const slots = [stateOwners(service).viewSettings.cameraViewDataState, stateOwners(service).viewSettings.mode2dState, stateOwners(service).layerState.layerSyncOptionsState,
        stateOwners(service).viewSettings.backgroundState, stateOwners(service).layerState.layerVisibilityState, stateOwners(service).layerState.layerZoomLevelState,
        stateOwners(service).layerState.layerAutoZoomLevelState, stateOwners(service).viewSettings.viewTileBordersState, stateOwners(service).viewSettings.viewTileGridModeState,
        stateOwners(service).viewSettings.viewTileGridLevelState, stateOwners(service).viewSettings.viewTileGridAutoLevelState, stateOwners(service).viewSettings.viewTileGridColorState,
        stateOwners(service).viewSettings.viewTileGridOpacityState, stateOwners(service).layerState.layerPresetSelectionState, stateOwners(service).layerState.mapPresetSelectionState];
        const expected = slots.map(slot => slot.getValue(survivor));
        stateOwners(service).viewSettings.focusedView = removed;
        stateOwners(service).viewSettings.viewSync = [VIEW_SYNC_POSITION];

        stateOwners(service).viewSettings.retainViews([survivor], new Map());

        expect(stateOwners(service).viewSettings.numViews).toBe(1);
        expect(stateOwners(service).viewSettings.focusedView).toBe(0);
        slots.forEach((slot, index) => {
            expect(slot.getValue(0)).toEqual(expected[index]);
            expect(Object.keys(slot.appState.value)).toEqual([...stateOwners(service).viewSettings.viewIds]);
        });
        expect(stateOwners(service).layerState.styles.get('m1/layerA/overlay/opacity')).toEqual([survivor ? 0.8 : 0.2]);
        expect(stateOwners(service).inspectionState.selectionState.getValue()).toBe(selection);
        expect(stateOwners(service).searchService.featureSearches).toEqual(searches.map(search => ({
            ...search, selectedViewIndices: search.selectedViewIndices.includes(survivor) ? [0] : []
        })));
        expect(stateOwners(service).viewSettings.viewSync).toEqual([VIEW_SYNC_POSITION]);

        stateOwners(service).viewSettings.numViews = 2;
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1)).toEqual(expected[0]);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(1)).toEqual(expected[4]);
        expect(stateOwners(service).layerState.styles.get('m1/layerA/overlay/opacity')).toEqual(survivor ? [0.8, 0.8] : [0.2, 0.2]);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('retains sparse defaults and a live camera without propagating synchronization', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).viewSettings.numViewsState.next(3);
        const camera = { ...stateOwners(service).viewSettings.cameraViewDataState.getValue(2), position: [1, 2, 3] as [number, number, number] };
        const defaultBackground = stateOwners(service).viewSettings.backgroundState.getValue(2);
        stateOwners(service).viewSettings.retainViews([0, 2], new Map([[2, camera]]));
        expect(Array.from({ length: stateOwners(service).viewSettings.numViews }, (_, index) => stateOwners(service).viewSettings.backgroundState.getValue(index))).toEqual([defaultBackground, defaultBackground]);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1)).toEqual(camera);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(0).position).not.toEqual(camera.position);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('writes a style-option batch atomically and emits style state once', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).viewSettings.numViews = 2;
        const nextSpy = vi.spyOn(stateOwners(service).layerState.stylesState, 'next');

        stateOwners(service).layerState.setStyleOptionValuesBatch([
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
        expect(stateOwners(service).layerState.styles.get('m1/layerA/overlay/first')).toEqual([true, false]);
        expect(stateOwners(service).layerState.styles.get('m1/layerA/overlay/second')).toEqual([true, true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects an invalid style-option batch before mutating any option', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);

        expect(() => stateOwners(service).layerState.setStyleOptionValuesBatch([
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
        expect(stateOwners(service).layerState.styles.size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('stores qualified layer and map preset selections outside snapshots', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).viewSettings.numViews = 2;

        stateOwners(service).layerState.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        stateOwners(service).layerState.setLayerPresetSelection(1, 'Vendor/Map', 'Lane', {
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        stateOwners(service).layerState.setMapPresetSelection(0, 'Vendor/Map', 'network-topology');

        expect(stateOwners(service).layerState.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-topology'
        });
        expect(stateOwners(service).layerState.getLayerPresetSelection(1, 'Vendor/Map', 'Lane')).toEqual({
            styleId: 'NDS.Live/Lanes', presetId: 'lane-boundary'
        });
        expect(stateOwners(service).layerState.getMapPresetSelection(0, 'Vendor/Map')).toBe('network-topology');
        expect(service.exportSnapshot()).not.toHaveProperty('stylePresetSelection');
        expect(service.exportSnapshot()).not.toHaveProperty('mapPresetSelection');

        stateOwners(service).layerState.setLayerPresetSelection(0, 'Vendor/Map', 'Lane', null);
        expect(stateOwners(service).layerState.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toBeNull();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('retires browser-owned map-preset definitions and ignores legacy config state', () => {
        localStorage.setItem('mapPresets', JSON.stringify([{ id: 'legacy' }]));
        localStorage.setItem('erdblickConfigDefaultStateMeta', JSON.stringify({
            version: 1,
            sourceHash: 'old',
            entries: {
                mapPresets: { owner: 'user', valueHash: 'old' },
                unrelated: { owner: 'user', valueHash: 'keep' }
            }
        }));
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        const errors = service.seedConfigDefaultState({ mapPresets: [{ id: 'legacy' }] }, 'map-preset-config');

        expect(errors).toEqual([]);
        expect(localStorage.getItem('mapPresets')).toBeNull();
        const metadata = JSON.parse(localStorage.getItem('erdblickConfigDefaultStateMeta')!);
        expect(metadata.entries).not.toHaveProperty('mapPresets');
        expect(service.exportSnapshot()).not.toHaveProperty('mapPresets');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates legacy unqualified layer-preset selections for unique owner migration', () => {
        localStorage.setItem('stylePresetSelection', JSON.stringify([{
            'Vendor/Map': {
                Lane: 'legacy-lane-preset'
            }
        }]));
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        service.initializePersistence();

        expect(stateOwners(service).layerState.getLayerPresetSelection(0, 'Vendor/Map', 'Lane')).toEqual({
            styleId: '',
            presetId: 'legacy-lane-preset'
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('provides non-URL hover-label defaults for the preview preferences', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        expect(stateOwners(service).inspectionState.hoverLabelsEnabled).toBe(true);
        expect(stateOwners(service).inspectionState.hoverLabelFields).toEqual([{
            expression: "id",
            customExpression: false
        }]);

        const params = (service as any).serializeUrlV2();
        expect(JSON.stringify(params)).not.toContain('hoverLabel');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('seeds each newly added view from the previous view when the view count keeps increasing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);

        stateOwners(service).viewSettings.numViews = 2;

        const destination = Cartographic.fromDegrees(7.75, 50.2, 123456);
        const orientation = { heading: 0.5, pitch: -0.4, roll: 0.3 };

        stateOwners(service).viewSettings.setView(1, destination, orientation);
        stateOwners(service).viewSettings.setProjectionMode(1, true);
        stateOwners(service).layerState.setLayerSyncOption(1, true);
        stateOwners(service).viewSettings.setBackgroundState(1, null, 17);
        stateOwners(service).viewSettings.viewTileBordersState.next(1, false);
        stateOwners(service).viewSettings.viewTileGridModeState.next(1, 'xyz');
        stateOwners(service).viewSettings.viewTileGridLevelState.next(1, 20);
        stateOwners(service).viewSettings.viewTileGridAutoLevelState.next(1, true);
        stateOwners(service).viewSettings.viewTileGridColorState.next(1, 'fedcba');
        stateOwners(service).viewSettings.viewTileGridOpacityState.next(1, 71);
        stateOwners(service).layerState.setMapLayerConfig('m1', 'layerA', [
            { autoLevel: true, visible: true, level: 13 },
            { autoLevel: false, visible: false, level: 5 }
        ]);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5, 0.25]);

        stateOwners(service).viewSettings.numViews = 3;

        expect(stateOwners(service).viewSettings.numViews).toBe(3);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(2)).toEqual(stateOwners(service).viewSettings.cameraViewDataState.getValue(1));
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(2)).not.toBe(stateOwners(service).viewSettings.cameraViewDataState.getValue(1));
        expect(stateOwners(service).viewSettings.mode2dState.getValue(2)).toBe(true);
        expect(stateOwners(service).layerState.getLayerSyncOption(2)).toBe(true);
        expect(stateOwners(service).viewSettings.getBackgroundState(2)).toEqual({ layerId: null, opacity: 17 });
        expect(stateOwners(service).viewSettings.viewTileBordersState.getValue(2)).toBe(false);
        expect(stateOwners(service).viewSettings.viewTileGridModeState.getValue(2)).toBe('xyz');
        expect(stateOwners(service).viewSettings.viewTileGridLevelState.getValue(2)).toBe(20);
        expect(stateOwners(service).viewSettings.viewTileGridAutoLevelState.getValue(2)).toBe(true);
        expect(stateOwners(service).viewSettings.viewTileGridColorState.getValue(2)).toBe('fedcba');
        expect(stateOwners(service).viewSettings.viewTileGridOpacityState.getValue(2)).toBe(71);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(2)).toEqual([false]);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(2)).not.toBe(stateOwners(service).layerState.layerVisibilityState.getValue(1));
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(2)).toEqual([5]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(2)).toEqual([false]);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.25, 0.25]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates selection colors from storage with a leading hash', async () => {
        localStorage.setItem('selected', JSON.stringify(['1~1~Features:map:layer:tile~feature-1~30:20~abc123~0']));
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).inspectionState.selection).toHaveLength(1);
        expect(stateOwners(service).inspectionState.selection[0].color).toBe('#abc123');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('converts views to degrees when setting a camera view', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        stateOwners(service).viewSettings.numViews = 2;

        const destination = new Cartographic(Math.PI / 2, Math.PI / 4, 500);
        const orientation = { heading: 1, pitch: 2, roll: 3 };

        stateOwners(service).viewSettings.setView(1, destination, orientation);

        const view = stateOwners(service).viewSettings.cameraViewDataState.getValue(1);
        expect(view.destination).toEqual({ lon: 90, lat: 45, alt: 500 });
        expect(view.orientation).toEqual(orientation);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rounds camera state values to 8 decimal places', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const destination = Cartographic.fromDegrees(11.141985707869166, 48.002375728153766, 123.123456789123);
        const orientation = { heading: 1.123456789, pitch: -2.987654321, roll: 3.000000009 };
        const position = [1.123456789, -2.987654321, 3.000000009] as const;

        stateOwners(service).viewSettings.setView(0, destination, orientation, position);

        const view = stateOwners(service).viewSettings.cameraViewDataState.getValue(0);
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

        const urlState = stateOwners(service).viewSettings.cameraViewDataState.appState.serialize(true);
        expect(urlState).toMatchObject({
            px: '1.12345679',
            py: '-2.98765432',
            pz: '3.00000001'
        });

        const storageState = stateOwners(service).viewSettings.cameraViewDataState.appState.serialize(false);
        const restoredService = new AppStateService(
            createRouterStub() as unknown as Router,
            infoServiceStub
        );
        stateOwners(restoredService);
        stateOwners(restoredService).viewSettings.cameraViewDataState.appState.deserialize(storageState!['cameraView']!);
        expect(stateOwners(restoredService).viewSettings.cameraViewDataState.getValue(0).position)
            .toEqual([1.12345679, -2.98765432, 3.00000001]);

        service.ngOnDestroy();
        restoredService.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(0).position).toEqual([0, 0, 0]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('synchronizes the complete target-relative camera position across views', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).viewSettings.numViews = 2;
        stateOwners(service).viewSettings.focusedView = 0;
        const orientation = { heading: 0.25, pitch: -0.5, roll: 0 };

        stateOwners(service).viewSettings.setView(
            0,
            Cartographic.fromDegrees(11, 48, 1000),
            orientation,
            [0, 0, 125]
        );
        stateOwners(service).viewSettings.setView(
            1,
            Cartographic.fromDegrees(12, 49, 2000),
            orientation,
            [0, 0, 250]
        );

        stateOwners(service).viewSettings.viewSync = [VIEW_SYNC_POSITION];
        stateOwners(service).viewSettings.setView(
            0,
            Cartographic.fromDegrees(13, 50, 3000),
            orientation,
            [0, 0, 375]
        );
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1).position).toEqual([0, 0, 375]);

        stateOwners(service).viewSettings.viewSync = [VIEW_SYNC_MOVEMENT];
        stateOwners(service).viewSettings.setView(
            0,
            Cartographic.fromDegrees(14, 51, 4000),
            orientation,
            [0, 0, 500]
        );
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(0).position).toEqual([0, 0, 500]);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(1).position).toEqual([0, 0, 375]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('throttles rapid URL sync updates to avoid flooding router history operations', async () => {
        vi.useFakeTimers();
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        stateOwners(service).coordinates.markerState.next(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1', v2: '1' }),
            queryParamsHandling: 'replace',
            replaceUrl: true,
        }));

        stateOwners(service).coordinates.markerState.next(false);
        await flushMicrotasks();
        stateOwners(service).coordinates.markerState.next(true);
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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('stores style parameters as URL state-friendly payloads', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // Prepare one layer so style options can be encoded
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).layerState.layerVisibilityState.next(0, [true]);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        // Set two options for style 'overlay'
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [false]);
        await flushMicrotasks();

        // Expect StyleState internal map to contain entries for both options
        const stylesMap = stateOwners(service).layerState.stylesState.positionalValues();
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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates compact style option entries from localStorage', async () => {
        localStorage.setItem('layerNames', JSON.stringify(['m1/layerA']));
        localStorage.setItem('overlay~0~opacity', '0.5');

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).layerState.stylesState.positionalValues().get('m1/layerA/overlay/opacity')).toEqual(['0.5']);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('materializes discovered layer defaults explicitly', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const config = stateOwners(service).layerState.materializeLayerDefaults('m1', 'layerA', false, 9);

        expect(config).toEqual([
            { autoLevel: true, visible: false, level: 9 },
        ]);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual(['m1/layerA']);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(0)).toEqual([9]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(0)).toEqual([true]);
        expect(stateOwners(service).viewSettings.viewTileBordersState.getValue(0)).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        // Prime internal state so indices exist before updating.
        stateOwners(service).layerState.materializeLayerDefaults('m2', 'layerB');

        stateOwners(service).layerState.setMapLayerConfig('m2', 'layerB', [{ autoLevel: false, visible: false, level: 7 }]);

        const config = stateOwners(service).layerState.materializeLayerDefaults('m2', 'layerB');

        expect(config).toEqual([
            { autoLevel: false, visible: false, level: 7 },
        ]);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(stateOwners(service).layerState.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(stateOwners(service).layerState.layerZoomLevelState.getValue(0)).toEqual([7]);
        expect(stateOwners(service).layerState.layerAutoZoomLevelState.getValue(0)).toEqual([false]);
        expect(stateOwners(service).viewSettings.viewTileBordersState.getValue(0)).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reuses the last unlocked feature inspection and closes other unlocked feature inspections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
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
        const targetPanelId = stateOwners(service).inspectionState.setSelection(selected);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(2);
        expect(panels).toHaveLength(3);
        expect(panels.find(panel => panel.id === 1)).toBeUndefined();
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 3)?.features).toEqual([feature('locked-feature')]);
        expect(panels.find(panel => panel.id === 4)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:99'));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps other unlocked feature inspections when selection targets a specific panel id', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('old-first')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-second')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = stateOwners(service).inspectionState.setSelection(selected, 1);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(1);
        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 1)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual([feature('old-second')]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('replaces an unlocked inspection dialog when it is the only unlocked feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = stateOwners(service).inspectionState.setSelection(selected);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(2);
        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 2)?.undocked).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('creates a new docked inspection panel when no unlocked panels or dialogs exist', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('locked-dialog')], locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = stateOwners(service).inspectionState.setSelection(selected);
        const panels = stateOwners(service).inspectionState.selection;
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(panels).toHaveLength(3);
        expect(newPanel?.features).toEqual(selected);
        expect(newPanel?.undocked).toBe(false);
        expect(newPanel?.locked).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('activates the inspection dock tab when adding a docked feature selection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layout.dockActiveTab = 'search';
        stateOwners(service).layout.isDockOpen = false;
        const panelId = stateOwners(service).inspectionState.setSelection([feature('new-feature', 'map/layer/new-tile')]);
        const panel = stateOwners(service).inspectionState.selection.find(item => item.id === panelId);

        expect(panel?.undocked).toBe(false);
        expect(stateOwners(service).layout.isDockOpen).toBe(true);
        expect(stateOwners(service).layout.dockActiveTab).toBe('inspection');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('can create an undocked feature selection without stealing the dock search tab', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layout.dockActiveTab = 'search';
        stateOwners(service).layout.isDockOpen = true;
        const panelId = stateOwners(service).inspectionState.setSelection(
            [feature('new-feature', 'map/layer/new-tile')],
            undefined,
            true,
            true);
        const panel = stateOwners(service).inspectionState.selection.find(item => item.id === panelId);

        expect(panel?.undocked).toBe(true);
        expect(stateOwners(service).layout.isDockOpen).toBe(true);
        expect(stateOwners(service).layout.dockActiveTab).toBe('search');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reuses an unlocked floating feature inspection even when it focuses an attribute target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
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
        stateOwners(service).layout.dockActiveTab = 'search';
        stateOwners(service).layout.isDockOpen = true;

        const panelId = stateOwners(service).inspectionState.setSelection(
            [feature('Road.2', 'map/layer/tile')],
            undefined,
            false,
            true);

        expect(panelId).toBe(1);
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 1)?.features).toEqual([feature('Road.2', 'map/layer/tile')]);
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 2)).toBeDefined();
        expect(stateOwners(service).layout.dockActiveTab).toBe('search');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('toggles an inspection panel between base feature and attribute-validity target', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            {
                id: 7,
                features: [feature('Road.1', 'map/layer/tile')],
                locked: true,
                size: [30, 20],
                color: '#111111',
                undocked: false
            }
        ];

        stateOwners(service).inspectionState.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(stateOwners(service).inspectionState.selection[0].features[0].featureId).toBe('Road.1:attribute#2:validity#0');
        expect(stateOwners(service).inspectionState.selection[0].locked).toBe(true);

        stateOwners(service).inspectionState.toggleInspectionFeatureHighlight(7, 'map/layer/tile', 'Road.1:attribute#2:validity#0');
        expect(stateOwners(service).inspectionState.selection[0].features[0].featureId).toBe('Road.1');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('preserves transient inspection tree header expansion state defensively', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const expandedNodes = new Map<string, boolean | undefined>([['root', true], ['child', false]]);
        const restoreSnapshot = new Map<string, boolean | undefined>([['root', false]]);

        stateOwners(service).inspectionState.setInspectionTreeExpansionState(7, {
            expandedNodes,
            fullExpansionActive: true,
            expansionSnapshotBeforeFullExpand: restoreSnapshot,
            fullCollapseActive: false
        });
        expandedNodes.set('root', false);
        restoreSnapshot.set('root', true);

        const firstRead = stateOwners(service).inspectionState.getInspectionTreeExpansionState(7)!;
        expect(firstRead.expandedNodes.get('root')).toBe(true);
        expect(firstRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);
        expect(firstRead.fullExpansionActive).toBe(true);
        expect(firstRead.fullCollapseActive).toBe(false);

        firstRead.expandedNodes.set('root', false);
        firstRead.expansionSnapshotBeforeFullExpand?.set('root', true);

        const secondRead = stateOwners(service).inspectionState.getInspectionTreeExpansionState(7)!;
        expect(secondRead.expandedNodes.get('root')).toBe(true);
        expect(secondRead.expansionSnapshotBeforeFullExpand?.get('root')).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps SourceData column defaults and per-panel overrides out of the URL', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        stateOwners(service).inspectionState.selection = [{
            id: 7,
            features: [],
            locked: false,
            size: [30, 20],
            color: '#ffffff',
            undocked: false
        }];

        stateOwners(service).inspectionState.sourceDataInspectionDefaultColumns = ["schemaType"];
        stateOwners(service).inspectionState.setInspectionTreeHiddenColumns(7, ["displayAddress"]);

        expect(stateOwners(service).inspectionState.sourceDataInspectionDefaultColumns).toEqual(["schemaType"]);
        expect(stateOwners(service).inspectionState.getInspectionTreeHiddenColumns(7)).toEqual(["displayAddress"]);
        expect(stateOwners(service).inspectionState.sourceDataInspectionDefaultColumnsState.serialize(true)).toBeUndefined();
        expect(stateOwners(service).inspectionState.inspectionTreeHiddenColumnsState.serialize(true)).toBeUndefined();

        stateOwners(service).inspectionState.selection = [];
        expect(stateOwners(service).inspectionState.getInspectionTreeHiddenColumns(7)).toBeUndefined();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('focuses inspection panels when selections create, reuse, or target an existing panel', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = feature('new-feature', 'map/layer/new-tile');
        expect(stateOwners(service).inspectionState.setSelection([selected])).toBe(2);
        expect(stateOwners(service).inspectionState.focusedInspectionPanelId).toBe(2);
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        stateOwners(service).inspectionState.focusedInspectionPanelId = 1;
        expect(stateOwners(service).inspectionState.setSelection([selected])).toBeUndefined();
        expect(stateOwners(service).inspectionState.focusedInspectionPanelId).toBe(2);
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 1)?.focused).toBeUndefined();
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        const serializedSelection = stateOwners(service).inspectionState.selectionState.serialize(false)?.['selected'] ?? '';
        expect(serializedSelection).toContain('2~0f~');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reopens the dock for default feature selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layout.isDockOpen = false;
        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#111111', undocked: false }
        ];

        stateOwners(service).inspectionState.setSelection([feature('old-feature')]);
        expect(stateOwners(service).layout.isDockOpen).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('does not replace unlocked SourceData with a feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:1'), locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 2, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = stateOwners(service).inspectionState.setSelection(selected);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(2);
        expect(panels.find(panel => panel.id === 1)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:1'));
        expect(panels.find(panel => panel.id === 2)?.features).toEqual(selected);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reuses an unlocked SourceData inspection before creating a new SourceData dialog', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const nextSourceData = sourceData('SourceData:m1:SourceData-LAYER:3');
        const targetPanelId = stateOwners(service).inspectionState.setSelection(nextSourceData);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(2);
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(nextSourceData);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual([]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('creates a new undocked SourceData dialog when no unlocked SourceData inspection exists', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = stateOwners(service).inspectionState.setSelection(sourceData('SourceData:m1:SourceData-LAYER:9'));
        const panels = stateOwners(service).inspectionState.selection;
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(newPanel?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:9'));
        expect(newPanel?.undocked).toBe(true);
        expect(newPanel?.locked).toBe(false);
        expect(newPanel?.features).toEqual([]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('falls back to a remaining inspection panel when the focused panel is removed', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('remove-me')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('fallback')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ];
        stateOwners(service).inspectionState.focusedInspectionPanelId = 1;

        stateOwners(service).inspectionState.unsetPanel(1);

        expect(stateOwners(service).inspectionState.focusedInspectionPanelId).toBe(2);
        expect(stateOwners(service).inspectionState.selection.find(panel => panel.id === 2)?.focused).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps SourceData selection in the same panel when requested by SourceData panel id even if locked', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:3'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = stateOwners(service).inspectionState.setSelection(sourceData('SourceData:m1:SourceData-LAYER:7'), 1);
        const panels = stateOwners(service).inspectionState.selection;

        expect(targetPanelId).toBe(1);
        expect(panels.find(panel => panel.id === 1)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:7'));
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:3'));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('ignores SourceData panels when deduplicating feature selection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const duplicated = feature('same-feature');
        stateOwners(service).inspectionState.selection = [
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

        const targetPanelId = stateOwners(service).inspectionState.setSelection([duplicated]);
        const panels = stateOwners(service).inspectionState.selection;
        const created = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(2);
        expect(created?.features).toEqual([duplicated]);
        expect(created?.sourceData).toBeUndefined();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps unlocked SourceData inspections when clearing unlocked selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('remove-me')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('stay-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];

        stateOwners(service).inspectionState.unsetUnlockedSelections();
        const panels = stateOwners(service).inspectionState.selection;

        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 1)).toBeUndefined();
        expect(panels.find(panel => panel.id === 2)?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:2'));
        expect(panels.find(panel => panel.id === 3)?.features).toEqual([feature('stay-locked')]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('creates one new panel per feature after clearing unlocked selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('remove-a')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('remove-b')], locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('keep-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
            { id: 4, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:8'), locked: false, size: [30, 40], color: '#444444', undocked: true },
        ];

        stateOwners(service).inspectionState.unsetUnlockedSelections();

        const mergedFeatures = [feature('merged-1'), feature('merged-2'), feature('merged-3')];
        const createdIds = mergedFeatures.map(selected => stateOwners(service).inspectionState.setSelection([selected], undefined, true));
        const definedIds = createdIds.filter((panelId): panelId is number => panelId !== undefined);
        const panels = stateOwners(service).inspectionState.selection;

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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('stores inspection dialog layout in dialogLayouts state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 11, features: [], locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 22, features: [], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        stateOwners(service).inspectionState.setInspectionDialogPosition(11, { left: 10, top: 20 }, 0);
        stateOwners(service).inspectionState.setInspectionDialogPosition(22, { left: 30, top: 40 }, 0);

        const first = stateOwners(service).inspectionState.getInspectionDialogLayout(11);
        const second = stateOwners(service).inspectionState.getInspectionDialogLayout(22);
        expect(first?.slot).toBe(0);
        expect(second?.slot).toBe(0);

        stateOwners(service).inspectionState.setInspectionDialogPosition(11, { left: 12, top: 24 }, 9);
        expect(stateOwners(service).inspectionState.getInspectionDialogLayout(11)?.slot).toBe(0);

        stateOwners(service).inspectionState.pruneInspectionDialogLayout([22]);
        expect(stateOwners(service).inspectionState.getInspectionDialogLayout(11)).toBeUndefined();
        expect(stateOwners(service).inspectionState.getInspectionDialogLayout(22)?.position).toEqual({ left: 30, top: 40 });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists comparison and layout states after hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        stateOwners(service).inspectionState.selection = [
            { id: 5, features: [], locked: false, size: [30, 40], color: '#555555', undocked: true },
        ];
        stateOwners(service).inspectionState.setInspectionDialogPosition(5, { left: 100, top: 200 }, 3);
        stateOwners(service).inspectionState.openInspectionComparison({
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

        stateOwners(service).inspectionState.closeInspectionComparison();
        await flushMicrotasks();
        expect(stateOwners(service).inspectionState.inspectionComparison).toBeNull();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('removes a compared other panel when unsetPanel is called', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ];
        stateOwners(service).inspectionState.openInspectionComparison({
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

        stateOwners(service).inspectionState.unsetPanel(2);

        expect(stateOwners(service).inspectionState.inspectionComparison).toEqual({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: []
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('promotes another comparison entry to base when the current base panel is removed', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
            { id: 3, features: [feature('f3')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];
        stateOwners(service).inspectionState.openInspectionComparison({
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

        stateOwners(service).inspectionState.unsetPanel(1);

        expect(stateOwners(service).inspectionState.inspectionComparison).toEqual({
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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('removes cleared unlocked panels from comparison during bulk close', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).inspectionState.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];
        stateOwners(service).inspectionState.openInspectionComparison({
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

        stateOwners(service).inspectionState.unsetUnlockedSelections();

        expect(stateOwners(service).inspectionState.inspectionComparison).toEqual({
            base: {
                panelId: 1,
                mapId: 'map',
                label: 'map.f1',
                featureIds: [feature('f1')]
            },
            others: []
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('validates and persists Connection preferences seeded through deployment state', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        expect(service.seedConfigDefaultState({
            connectionRetryInitialDelayMs: 7000,
            connectionRetryMaxDelayMs: 90000
        }, "connection-config")).toEqual([]);
        expect(stateOwners(service).connectionPreferences.connectionRetryPolicy.initialDelayMs).toBe(7000);
        stateOwners(service).connectionPreferences.setConnectionRetryPolicy({ ...stateOwners(service).connectionPreferences.connectionRetryPolicy, enabled: false, backoffMultiplier: 3 });
        expect(service.exportSnapshot()).toMatchObject({
            connectionRetryEnabled: 0,
            connectionRetryInitialDelayMs: 7000, connectionRetryBackoffMultiplier: 3
        });
        expect(() => stateOwners(service).connectionPreferences.setConnectionRetryPolicy({ ...stateOwners(service).connectionPreferences.connectionRetryPolicy, maxDelayMs: 0 })).toThrow();
        expect(stateOwners(service).connectionPreferences.connectionRetryPolicy.maxDelayMs).toBe(90000);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('shares validated point-cloud preferences across config, snapshots and persisted state', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        const serviceRenderPreferences = stateOwners(service).renderPreferences;
        expect(service.seedConfigDefaultState({
            pointCloudDetailPixels: 4,
            pointCloudGpuMemoryMiB: 128
        }, 'point-cloud-config')).toEqual([]);
        expect(serviceRenderPreferences.pointCloudPolicy.detailPixels).toBe(4);
        serviceRenderPreferences.setPointCloudPolicy({ ...serviceRenderPreferences.pointCloudPolicy, enabled: false, workingMemoryMiB: 256 });
        const snapshot = service.exportSnapshot();
        expect(snapshot).toMatchObject({
            pointCloudDownsamplingEnabled: 0,
            pointCloudDetailPixels: 4, pointCloudWorkingMemoryMiB: 256, pointCloudGpuMemoryMiB: 128
        });
        expect(serviceRenderPreferences.pointCloudDetailPixelsState.isUrlState()).toBe(false);
        expect(() => serviceRenderPreferences.setPointCloudPolicy({ ...serviceRenderPreferences.pointCloudPolicy, gpuMemoryMiB: 0 })).toThrow();
        expect(serviceRenderPreferences.pointCloudPolicy.gpuMemoryMiB).toBe(128);
        expect(service.importSnapshot({ pointCloudDetailPixels: 8 })).toEqual([]);
        expect(serviceRenderPreferences.pointCloudPolicy.detailPixels).toBe(8);
        expect(service.importSnapshot({ pointCloudWorkingMemoryMiB: -1 }).length).toBeGreaterThan(0);
        expect(serviceRenderPreferences.pointCloudPolicy.workingMemoryMiB).toBe(256);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('exports app state entries with compact style option storage keys', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).coordinates.markerState.next(true);
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).layerState.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        const snapshot = service.exportSnapshot();

        expect(snapshot).toHaveProperty('marker');
        expect(snapshot).toHaveProperty('numberOfViews');
        expect(snapshot).not.toHaveProperty('styleOptions');
        expect(snapshot).toHaveProperty('overlay~0~opacity', '0.5');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('omits transient dialog visibility flags from exported snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).layout.openDialog('advanced-preferences-dialog');
        const snapshot = service.exportSnapshot();

        expect(snapshot).not.toHaveProperty('advancedPreferencesDialogVisible');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps coordinate preference and legal acceptance out of URLs and snapshots', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        stateOwners(service).coordinatePolicy.coordinatesEnabledState.next(false);
        stateOwners(service).coordinatePolicy.coordinatesLegalTermsAcceptedState.next(true);

        const snapshot = service.exportSnapshot();
        const params = (service as any).serializeUrlV2();
        expect(snapshot).not.toHaveProperty('coordinatesEnabled');
        expect(snapshot).not.toHaveProperty('coordinatesLegalTermsAccepted');
        expect(params).not.toHaveProperty('coordinatesEnabled');
        expect(params).not.toHaveProperty('coordinatesLegalTermsAccepted');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('restores dialog visibility from dialogLayouts snapshot state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.importSnapshot({
            dialogLayouts: {
                "advanced-preferences-dialog": {
                    position: { left: 10, top: 20 },
                    size: { width: 400, height: 300 },
                    open: true
                }
            }
        });

        expect(errors).toEqual([]);
        expect(stateOwners(service).layout.isDialogOpen('advanced-preferences-dialog')).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('restores style dialog state from snapshot data', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.importSnapshot({
            styleEditorTarget: 'generic',
            dialogLayouts: {
                "styles-dialog": {
                    position: { left: 10, top: 20 },
                    size: { width: 500, height: 400 },
                    open: true
                },
                "style-editor-dialog": {
                    position: { left: 30, top: 40 },
                    size: { width: 600, height: 500 },
                    open: true
                }
            }
        });

        expect(errors).toEqual([]);
        expect(stateOwners(service).layout.isDialogOpen('styles-dialog')).toBe(true);
        expect(stateOwners(service).layout.isDialogOpen('style-editor-dialog')).toBe(true);
        expect(stateOwners(service).styleService.styleEditorTargetId).toBe('generic');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects snapshot imports with unknown top-level keys and applies nothing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).coordinates.markerState.next(false);
        const errors = service.importSnapshot({
            marker: true,
            unknownState: 1
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('imports valid partial snapshots and keeps missing states unchanged', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        stateOwners(service).coordinates.markerState.next(false);

        const errors = service.importSnapshot({
            marker: true
        });

        expect(errors).toEqual([]);
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);
        expect(stateOwners(service).layout.isDialogOpen('preferences-dialog')).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('resets omitted query-scene state and replaces camera and style options', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        stateOwners(service).layout.mapsOpenState.next(true);
        stateOwners(service).layerState.stylesState.replacePositional(new Map([['old/Lane/style/topology', [true]]]));
        await service.replaceUrlState({ v2: '1', n: '1', lon: '11.66', lat: '48.25', alt: '128000', map: 'Very-Large-Map', l: 'Road:0', v: '1' }, true);
        expect(stateOwners(service).layout.mapsOpenState.getValue()).toBe(false);
        expect(stateOwners(service).layerState.stylesState.positionalValues().has('old/Lane/style/topology')).toBe(false);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual(['Very-Large-Map/Road']);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(0).destination.lon).toBeCloseTo(11.66);
        expect(stateOwners(service).viewSettings.cameraViewDataState.getValue(0).destination.lat).toBeCloseTo(48.25);
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects presentation snapshot replacement before persistence is ready', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        expect(() => service.replaceSnapshotState({ marker: true }))
            .toThrow('before AppStateService is ready');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('validates presentation snapshot replacement before mutating any state', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        const stateApplied = vi.fn();
        service.stateApplied.subscribe(stateApplied);

        stateOwners(service).coordinates.markerState.next(false);
        const errors = service.replaceSnapshotState({
            marker: true,
            unknownPresentationState: 1
        });

        expect(errors).not.toEqual([]);
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);
        expect(stateApplied).not.toHaveBeenCalled();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('replaces presentation state, resets omissions, and clears stale style options without persistence', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        stateOwners(service).coordinates.markerState.next(true);
        stateOwners(service).layout.mapsOpenState.next(true);
        stateOwners(service).layerState.layerNamesState.next(['m1/layerA']);
        stateOwners(service).layerState.stylesState.replacePositional(new Map([
            ['m1/layerA/overlay/stale', [true]]
        ]));
        await flushMicrotasks();
        localStorage.clear();
        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();
        const appliedSnapshots: Array<Record<string, unknown>> = [];
        service.stateApplied.subscribe(() => appliedSnapshots.push(service.exportSnapshot()));

        const errors = service.replaceSnapshotState({
            numberOfViews: 1,
            marker: false,
            layerNames: ['m2/layerB'],
            'overlay~0~opacity': '0.75'
        });
        await flushMicrotasks();

        expect(errors).toEqual([]);
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);
        expect(stateOwners(service).layout.mapsOpenState.getValue()).toBe(false);
        expect(stateOwners(service).layerState.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(stateOwners(service).layerState.stylesState.positionalValues().has('m1/layerA/overlay/stale')).toBe(false);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('m2/layerB/overlay/opacity')).toEqual(['0.75']);
        expect(appliedSnapshots).toHaveLength(1);
        expect(routerStub.navigate).not.toHaveBeenCalled();
        expect(localStorage.length).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('imports compact style option entries after applying layer state', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.importSnapshot({
            layerNames: ['m1/layerA'],
            'overlay~0~opacity~debug': '0.5~1'
        });

        expect(errors).toEqual([]);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('m1/layerA/overlay/opacity')).toEqual(['0.5']);
        expect(stateOwners(service).layerState.stylesState.positionalValues().get('m1/layerA/overlay/debug')).toEqual(['1']);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects non-string compact style option snapshot values before mutation', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.importSnapshot({
            marker: true,
            'overlay~0~opacity': [0.5]
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);
        expect(stateOwners(service).layerState.stylesState.positionalValues().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects prototype-pollution keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const payload = JSON.parse('{"marker": true, "__proto__": {"polluted": true}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects nested __proto__ keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const payload = JSON.parse('{"styleOptions": {"valid/key": [true], "__proto__": {"polluted": true}}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(stateOwners(service).layerState.stylesState.positionalValues().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects constructor.prototype payloads in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const payload = JSON.parse('{"styleOptions": {"constructor": {"prototype": {"polluted": true}}}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(stateOwners(service).layerState.stylesState.positionalValues().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects oversized snapshot strings before state mutation', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const limits = service.getSnapshotImportLimits();

        const errors = service.importSnapshot({
            erdblickVersion: 'x'.repeat(limits.maxStringLength + 1)
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(stateOwners(service).configService.erdblickVersion.getValue()).toBe('');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects snapshots that exceed the max nesting depth', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);
        const limits = service.getSnapshotImportLimits();

        const deepValue: Record<string, unknown> = {};
        let cursor: Record<string, unknown> = deepValue;
        for (let index = 0; index < limits.maxNestingDepth + 1; index++) {
            cursor['next'] = {};
            cursor = cursor['next'] as Record<string, unknown>;
        }

        const errors = service.importSnapshot({
            styleOptions: deepValue
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(stateOwners(service).layerState.stylesState.positionalValues().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it.each([false, true])('merges changed config view count with stored identities and user ownership: user=%s', async userOwned => {
        async function launch(count: number) {
            const router = createRouterStub();
            const registry = new AppStateService(router as unknown as Router, infoServiceStub());
            const owners = stateOwners(registry);
            expect(registry.seedConfigDefaultState({ numberOfViews: count }, `config-${count}`)).toEqual([]);
            router.events.next(new NavigationEnd(1, '/', '/'));
            await flushMicrotasks();
            return { registry, owners, router };
        }
        const first = await launch(1);
        if (userOwned) {
            first.owners.viewSettings.numViews = 3;
            await flushMicrotasks();
        }
        const previous = [...first.owners.viewSettings.viewIds];
        first.registry.ngOnDestroy();
        first.router.events.complete();
        const second = await launch(2);
        expect(second.owners.viewSettings.numViews).toBe(userOwned ? 3 : 2);
        expect(second.owners.viewSettings.viewIds.slice(0, previous.length)).toEqual(previous);
        const meta = JSON.parse(localStorage.getItem('erdblickConfigDefaultStateMeta')!);
        expect(meta.entries.numberOfViews.owner).toBe(userOwned ? 'user' : 'config');
        expect(meta.entries.viewIds?.owner).not.toBe('config');
        second.registry.ngOnDestroy();
        second.router.events.complete();
    });

    it('does not claim view ownership when config supplies only an unrelated marker default', async () => {
        const router = createRouterStub();
        const registry = new AppStateService(router as unknown as Router, infoServiceStub());
        const owners = stateOwners(registry);
        const ids = owners.viewSettings.viewIds;
        expect(registry.seedConfigDefaultState({ marker: true }, 'marker-only')).toEqual([]);
        expect(owners.viewSettings.viewIds).toBe(ids);
        const meta = JSON.parse(localStorage.getItem('erdblickConfigDefaultStateMeta')!);
        for (const key of ['viewIds', 'numberOfViews', 'focus']) expect(meta.entries[key]).toBeUndefined();
        registry.ngOnDestroy();
        router.events.complete();
    });

    it.each(['same,same', 'constructor', '', ['a', 'b']])('rejects invalid replacement identities before reset or navigation: %s', async vid => {
        const router = createRouterStub();
        const registry = new AppStateService(router as unknown as Router, infoServiceStub());
        const owners = stateOwners(registry);
        router.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();
        owners.viewSettings.numViews = 2;
        owners.coordinates.marker = true;
        await flushMicrotasks();
        const before = registry.exportSnapshot();
        const url = window.location.href;
        vi.mocked(router.navigate).mockClear();
        await expect(registry.replaceUrlState({ v2: '1', n: '2', vid, m: '0' }, true)).rejects.toThrow();
        expect(registry.exportSnapshot()).toEqual(before);
        expect(window.location.href).toBe(url);
        expect(router.navigate).not.toHaveBeenCalled();
        registry.ngOnDestroy();
        router.events.complete();
    });

    it('applies config default state for a fresh profile before hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.seedConfigDefaultState({
            marker: true,
            featureZoomClearanceMeters: 35
        }, "cfg-hash-1");
        expect(errors).toEqual([]);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);
        expect(stateOwners(service).viewSettings.featureZoomClearanceMeters).toBe(35);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('applies the coordinate config default without making it snapshot state', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub());
        stateOwners(service);

        const errors = service.seedConfigDefaultState({ coordinatesEnabled: false }, "coordinates-cfg");
        expect(errors).toEqual([]);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinatePolicy.coordinatesEnabledState.getValue()).toBe(false);
        expect(service.exportSnapshot()).not.toHaveProperty('coordinatesEnabled');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps legacy localStorage values without metadata over seeded config defaults', async () => {
        localStorage.setItem('marker', '0');

        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        service.seedConfigDefaultState({ marker: true }, "cfg-hash-2");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        service.seedConfigDefaultState({ marker: true }, "cfg-hash-3");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);

        service.ngOnDestroy();
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
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        service.seedConfigDefaultState({ marker: true }, "cfg-hash-4");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
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

        const routerStub = createRouterStub({ m: '1' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        service.seedConfigDefaultState({ marker: false }, "cfg-hash-5");
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('returns validation errors for invalid config default snapshots and leaves defaults unchanged', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.seedConfigDefaultState({ marker: ["bad"] }, "cfg-hash-6");
        expect(errors.length).toBeGreaterThan(0);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('ignores empty config default snapshots', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        stateOwners(service);

        const errors = service.seedConfigDefaultState({}, "cfg-hash-empty");
        expect(errors).toEqual([]);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(stateOwners(service).coordinates.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });
});
