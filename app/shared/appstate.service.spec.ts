import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

import type { Event, Router } from '@angular/router';
import { NavigationEnd, NavigationStart } from '@angular/router';
import { Cartographic } from '../integrations/geo';
import { AppStateService } from './appstate.service';

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

describe('AppStateService', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
            fontSize: '16px',
        }) as any);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('hydrates URL state on startup and persists subsequent changes', async () => {
        const routerStub = createRouterStub({ m: '1' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.markerState.getValue()).toBe(true);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.markerState.next(false);
        await flushMicrotasks();

        expect(localStorage.getItem('marker')).toBe('0');
        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '0' }),
            queryParamsHandling: 'merge',
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

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.markerState.getValue()).toBe(true);
        expect(routerStub.navigate).not.toHaveBeenCalled();

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
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        (service as any).lastMergedUrlSyncAt = Date.now();
        service.markerState.next(true);
        await flushMicrotasks();
        expect((service as any).urlSyncHandle).not.toBeNull();
        expect((service as any).pendingUrlSyncStates.size).toBeGreaterThan(0);

        routerStub.routerState.snapshot.root!.queryParams = { m: '0' };
        // @ts-expect-error this is a call to mock router
        routerStub.getCurrentNavigation.mockReturnValue({ trigger: 'popstate' });
        routerStub.events.next(new NavigationStart(2, '/?m=0'));
        routerStub.events.next(new NavigationEnd(2, '/?m=0', '/?m=0'));
        await flushMicrotasks();

        expect(service.markerState.getValue()).toBe(false);

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

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.markedPositionState.getValue()).toEqual([11.14198571, 48.00237573]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('serializes marked position to a CSV query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.markedPositionState.next([11.141985707869166, 48.002375728153766]);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                mp: '11.14198571,48.00237573',
            }),
            queryParamsHandling: 'merge',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates OSM settings from combined query params', async () => {
        const routerStub = createRouterStub({ n: '2', osm: '1~50,0~30' });
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.getOsmState(0)).toEqual({ enabled: true, opacity: 50 });
        expect(service.getOsmState(1)).toEqual({ enabled: false, opacity: 30 });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('serializes OSM settings into a single osm query param', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.setOsmState(0, true, 50);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                osm: '1~50',
            }),
            queryParamsHandling: 'merge',
            replaceUrl: true,
        }));
        const lastCall = (routerStub.navigate as any).mock.calls.at(-1)?.[1];
        expect(lastCall?.queryParams?.osmOp).toBeUndefined();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('seeds the second view from the primary view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const destination = Cartographic.fromDegrees(11.25, 48.5, 987654);
        const orientation = { heading: 1.25, pitch: -0.75, roll: 0.125 };

        service.setView(0, destination, orientation);
        service.setProjectionMode(0, true);
        service.setLayerSyncOption(0, true);
        service.setOsmState(0, false, 42);
        service.viewTileBordersState.next(0, false);
        service.viewTileGridModeState.next(0, 'xyz');
        service.mapLayerConfig('m1', 'layerA', false, 9);
        service.setMapLayerConfig('m1', 'layerA', [{ autoLevel: false, visible: true, level: 7 }]);

        service.numViews = 2;

        expect(service.numViews).toBe(2);
        expect(service.cameraViewDataState.getValue(1)).toEqual(service.cameraViewDataState.getValue(0));
        expect(service.cameraViewDataState.getValue(1)).not.toBe(service.cameraViewDataState.getValue(0));
        expect(service.mode2dState.getValue(1)).toBe(true);
        expect(service.getLayerSyncOption(1)).toBe(true);
        expect(service.getOsmState(1)).toEqual({ enabled: false, opacity: 42 });
        expect(service.viewTileBordersState.getValue(1)).toBe(false);
        expect(service.viewTileGridModeState.getValue(1)).toBe('xyz');
        expect(service.layerVisibilityState.getValue(1)).toEqual([true]);
        expect(service.layerVisibilityState.getValue(1)).not.toBe(service.layerVisibilityState.getValue(0));
        expect(service.layerZoomLevelState.getValue(1)).toEqual([7]);
        expect(service.layerAutoZoomLevelState.getValue(1)).toEqual([false]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('copies style option values into the second view when split view is opened', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.layerNamesState.next(['m1/layerA']);
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [true]);

        service.numViews = 2;

        const stylesMap = service.stylesState.getValue();
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([true, true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('seeds each newly added view from the previous view when the view count keeps increasing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.layerNamesState.next(['m1/layerA']);
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);

        service.numViews = 2;

        const destination = Cartographic.fromDegrees(7.75, 50.2, 123456);
        const orientation = { heading: 0.5, pitch: -0.4, roll: 0.3 };

        service.setView(1, destination, orientation);
        service.setProjectionMode(1, true);
        service.setLayerSyncOption(1, true);
        service.setOsmState(1, false, 17);
        service.viewTileBordersState.next(1, false);
        service.viewTileGridModeState.next(1, 'xyz');
        service.setMapLayerConfig('m1', 'layerA', [
            { autoLevel: true, visible: true, level: 13 },
            { autoLevel: false, visible: false, level: 5 }
        ]);
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5, 0.25]);

        service.numViews = 3;

        expect(service.numViews).toBe(3);
        expect(service.cameraViewDataState.getValue(2)).toEqual(service.cameraViewDataState.getValue(1));
        expect(service.cameraViewDataState.getValue(2)).not.toBe(service.cameraViewDataState.getValue(1));
        expect(service.mode2dState.getValue(2)).toBe(true);
        expect(service.getLayerSyncOption(2)).toBe(true);
        expect(service.getOsmState(2)).toEqual({ enabled: false, opacity: 17 });
        expect(service.viewTileBordersState.getValue(2)).toBe(false);
        expect(service.viewTileGridModeState.getValue(2)).toBe('xyz');
        expect(service.layerVisibilityState.getValue(2)).toEqual([false]);
        expect(service.layerVisibilityState.getValue(2)).not.toBe(service.layerVisibilityState.getValue(1));
        expect(service.layerZoomLevelState.getValue(2)).toEqual([5]);
        expect(service.layerAutoZoomLevelState.getValue(2)).toEqual([false]);
        expect(service.stylesState.getValue().get('m1/layerA/overlay/opacity')).toEqual([0.5, 0.25, 0.25]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('hydrates selection colors from storage with a leading hash', async () => {
        localStorage.setItem('selected', JSON.stringify(['1~1~Features:map:layer:tile~feature-1~30:20~abc123~0']));
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        expect(service.selection).toHaveLength(1);
        expect(service.selection[0].color).toBe('#abc123');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('converts views to degrees when setting a camera view', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const destination = new Cartographic(Math.PI / 2, Math.PI / 4, 500);
        const orientation = { heading: 1, pitch: 2, roll: 3 };

        service.setView(1, destination, orientation);

        const view = service.cameraViewDataState.getValue(1);
        expect(view.destination).toEqual({ lon: 90, lat: 45, alt: 500 });
        expect(view.orientation).toEqual(orientation);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rounds camera state values to 8 decimal places', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const destination = Cartographic.fromDegrees(11.141985707869166, 48.002375728153766, 123.123456789123);
        const orientation = { heading: 1.123456789, pitch: -2.987654321, roll: 3.000000009 };

        service.setView(0, destination, orientation);

        const view = service.cameraViewDataState.getValue(0);
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

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('throttles rapid URL sync updates to avoid flooding router history operations', async () => {
        vi.useFakeTimers();
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        service.markerState.next(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1' }),
            queryParamsHandling: 'merge',
            replaceUrl: true,
        }));

        service.markerState.next(false);
        await flushMicrotasks();
        service.markerState.next(true);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(400);
        await flushMicrotasks();

        expect(routerStub.navigate).toHaveBeenCalledTimes(2);
        expect(routerStub.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({ m: '1' }),
            queryParamsHandling: 'merge',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('stores style parameters as URL state-friendly payloads', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        // Trigger initial hydration (service wires up after first NavigationEnd)
        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        // Prepare one layer so style options can be encoded
        service.layerNamesState.next(['m1/layerA']);

        // @ts-expect-error this is a call to mock router
        routerStub.navigate.mockClear();

        // Set two options for style 'overlay'
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'opacity', [0.5]);
        service.setStyleOptionValues('m1', 'layerA', 'overlay', 'debug', [false]);
        await flushMicrotasks();

        // Expect StyleState internal map to contain entries for both options
        const stylesMap = service.stylesState.getValue();
        expect(stylesMap.get('m1/layerA/overlay/opacity')).toEqual([0.5]);
        expect(stylesMap.get('m1/layerA/overlay/debug')).toEqual([false]);

        // Expect URL sync to use compact style option encoding
        expect(routerStub.navigate).toHaveBeenCalledWith([], expect.objectContaining({
            queryParams: expect.objectContaining({
                'overlay~0~opacity~debug': '0.5~0',
            }),
            queryParamsHandling: 'merge',
            replaceUrl: true,
        }));

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('initializes layer config with fallback values when first requested', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const config = service.mapLayerConfig('m1', 'layerA', false, 9);

        expect(config).toEqual([
            { autoLevel: true, visible: false, level: 9 },
        ]);
        expect(service.layerNamesState.getValue()).toEqual(['m1/layerA']);
        expect(service.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevelState.getValue(0)).toEqual([9]);
        expect(service.layerAutoZoomLevelState.getValue(0)).toEqual([true]);
        expect(service.viewTileBordersState.getValue(0)).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        // Prime internal state so indices exist before updating.
        service.mapLayerConfig('m2', 'layerB');

        service.setMapLayerConfig('m2', 'layerB', [{ autoLevel: false, visible: false, level: 7 }]);

        const config = service.mapLayerConfig('m2', 'layerB');

        expect(config).toEqual([
            { autoLevel: false, visible: false, level: 7 },
        ]);
        expect(service.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(service.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevelState.getValue(0)).toEqual([7]);
        expect(service.layerAutoZoomLevelState.getValue(0)).toEqual([false]);
        expect(service.viewTileBordersState.getValue(0)).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reuses the last unlocked feature inspection and closes other unlocked feature inspections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
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
        const targetPanelId = service.setSelection(selected);
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('old-first')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-second')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.setSelection(selected, 1);
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.setSelection(selected);
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('locked-docked')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('locked-dialog')], locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.setSelection(selected);
        const panels = service.selection;
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(panels).toHaveLength(3);
        expect(newPanel?.features).toEqual(selected);
        expect(newPanel?.undocked).toBe(false);
        expect(newPanel?.locked).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('reopens the dock for default feature selections', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.isDockOpen = false;
        service.selection = [
            { id: 1, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#111111', undocked: false }
        ];

        service.setSelection([feature('old-feature')]);
        expect(service.isDockOpen).toBe(true);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('does not replace unlocked SourceData with a feature inspection', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:1'), locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 2, features: [feature('old-feature')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.setSelection(selected);
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const nextSourceData = sourceData('SourceData:m1:SourceData-LAYER:3');
        const targetPanelId = service.setSelection(nextSourceData);
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('feature-panel')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = service.setSelection(sourceData('SourceData:m1:SourceData-LAYER:9'));
        const panels = service.selection;
        const newPanel = panels.find(panel => panel.id === targetPanelId);

        expect(targetPanelId).toBe(3);
        expect(newPanel?.sourceData).toEqual(sourceData('SourceData:m1:SourceData-LAYER:9'));
        expect(newPanel?.undocked).toBe(true);
        expect(newPanel?.locked).toBe(false);
        expect(newPanel?.features).toEqual([]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('keeps SourceData selection in the same panel when requested by SourceData panel id even if locked', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
            { id: 1, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:3'), locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const targetPanelId = service.setSelection(sourceData('SourceData:m1:SourceData-LAYER:7'), 1);
        const panels = service.selection;

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

        const duplicated = feature('same-feature');
        service.selection = [
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

        const targetPanelId = service.setSelection([duplicated]);
        const panels = service.selection;
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

        service.selection = [
            { id: 1, features: [feature('remove-me')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:2'), locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('stay-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];

        service.unsetUnlockedSelections();
        const panels = service.selection;

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

        service.selection = [
            { id: 1, features: [feature('remove-a')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('remove-b')], locked: false, size: [30, 40], color: '#222222', undocked: true },
            { id: 3, features: [feature('keep-locked')], locked: true, size: [30, 20], color: '#333333', undocked: false },
            { id: 4, features: [], sourceData: sourceData('SourceData:m1:SourceData-LAYER:8'), locked: false, size: [30, 40], color: '#444444', undocked: true },
        ];

        service.unsetUnlockedSelections();

        const mergedFeatures = [feature('merged-1'), feature('merged-2'), feature('merged-3')];
        const createdIds = mergedFeatures.map(selected => service.setSelection([selected], undefined, true));
        const definedIds = createdIds.filter((panelId): panelId is number => panelId !== undefined);
        const panels = service.selection;

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

        service.selection = [
            { id: 11, features: [], locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 22, features: [], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        service.setInspectionDialogPosition(11, { left: 10, top: 20 }, 0);
        service.setInspectionDialogPosition(22, { left: 30, top: 40 }, 0);

        const first = service.getInspectionDialogLayout(11);
        const second = service.getInspectionDialogLayout(22);
        expect(first?.slot).toBe(0);
        expect(second?.slot).toBe(0);

        service.setInspectionDialogPosition(11, { left: 12, top: 24 }, 9);
        expect(service.getInspectionDialogLayout(11)?.slot).toBe(0);

        service.pruneInspectionDialogLayout([22]);
        expect(service.getInspectionDialogLayout(11)).toBeUndefined();
        expect(service.getInspectionDialogLayout(22)?.position).toEqual({ left: 30, top: 40 });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists comparison and layout states after hydration', async () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        routerStub.events.next(new NavigationEnd(1, '/', '/'));
        await flushMicrotasks();

        service.selection = [
            { id: 5, features: [], locked: false, size: [30, 40], color: '#555555', undocked: true },
        ];
        service.setInspectionDialogPosition(5, { left: 100, top: 200 }, 3);
        service.openInspectionComparison({
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

        service.closeInspectionComparison();
        await flushMicrotasks();
        expect(service.inspectionComparison).toBeNull();

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('removes a compared other panel when unsetPanel is called', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
        ];
        service.openInspectionComparison({
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

        service.unsetPanel(2);

        expect(service.inspectionComparison).toEqual({
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

        service.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: true, size: [30, 20], color: '#222222', undocked: false },
            { id: 3, features: [feature('f3')], locked: true, size: [30, 20], color: '#333333', undocked: false },
        ];
        service.openInspectionComparison({
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

        service.unsetPanel(1);

        expect(service.inspectionComparison).toEqual({
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

        service.selection = [
            { id: 1, features: [feature('f1')], locked: true, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('f2')], locked: false, size: [30, 20], color: '#222222', undocked: false },
        ];
        service.openInspectionComparison({
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

        service.unsetUnlockedSelections();

        expect(service.inspectionComparison).toEqual({
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

    it('exports app state entries as a single snapshot object', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.markerState.next(true);
        const snapshot = service.exportSnapshot();

        expect(snapshot).toHaveProperty('marker');
        expect(snapshot).toHaveProperty('numberOfViews');
        expect(snapshot).toHaveProperty('styleOptions');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects snapshot imports with unknown top-level keys and applies nothing', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.markerState.next(false);
        const errors = service.importSnapshot({
            marker: true,
            unknownState: 1
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('imports valid partial snapshots and keeps missing states unchanged', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.markerState.next(false);
        service.preferencesDialogVisibleState.next(false);

        const errors = service.importSnapshot({
            marker: true
        });

        expect(errors).toEqual([]);
        expect(service.markerState.getValue()).toBe(true);
        expect(service.preferencesDialogVisibleState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects prototype-pollution keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"marker": true, "__proto__": {"polluted": true}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.markerState.getValue()).toBe(false);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects nested __proto__ keys in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"styleOptions": {"valid/key": [true], "__proto__": {"polluted": true}}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.stylesState.getValue().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects constructor.prototype payloads in snapshots', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        const payload = JSON.parse('{"styleOptions": {"constructor": {"prototype": {"polluted": true}}}}');
        const errors = service.importSnapshot(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(({} as any).polluted).toBeUndefined();
        expect(service.stylesState.getValue().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects oversized snapshot strings before state mutation', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
        const limits = service.getSnapshotImportLimits();

        const errors = service.importSnapshot({
            erdblickVersion: 'x'.repeat(limits.maxStringLength + 1)
        });

        expect(errors.length).toBeGreaterThan(0);
        expect(service.erdblickVersion.getValue()).toBe('');

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('rejects snapshots that exceed the max nesting depth', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);
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
        expect(service.stylesState.getValue().size).toBe(0);

        service.ngOnDestroy();
        routerStub.events.complete();
    });
});
