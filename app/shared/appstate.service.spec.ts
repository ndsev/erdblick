import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

vi.mock('@angular/router', () => {
    class NavigationStart {
        constructor(
            public id: number,
            public url: string,
        ) {}
    }

    class NavigationEnd {
        constructor(
            public id: number,
            public url: string,
            public urlAfterRedirects: string,
        ) {}
    }

    return {
        NavigationStart,
        NavigationEnd,
        Router: class {},
        Params: {} as any,
    };
});

vi.mock('../inspection/inspection.service', () => ({
    SelectedSourceData: class {},
}));

vi.mock('../mapdata/features.model', () => ({
    FeatureWrapper: class {},
    FeatureTile: class {},
}));

vi.mock('../mapdata/map.model', () => ({
    MapTreeNode: class {},
}));

import type { Event, Router } from '@angular/router';
import { NavigationEnd } from '@angular/router';
import { Cartographic } from '../integrations/cesium';
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
    };
};

describe('AppStateService', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
            fontSize: '16px',
        }) as any);
    });

    afterEach(() => {
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
            { visible: false, level: 9, tileBorders: false },
        ]);
        expect(service.layerNamesState.getValue()).toEqual(['m1/layerA']);
        expect(service.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevelState.getValue(0)).toEqual([9]);
        expect(service.layerTileBordersState.getValue(0)).toEqual([false]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        // Prime internal state so indices exist before updating.
        service.mapLayerConfig('m2', 'layerB');

        service.setMapLayerConfig('m2', 'layerB', [{ visible: false, level: 7, tileBorders: true }]);

        const config = service.mapLayerConfig('m2', 'layerB');

        expect(config).toEqual([
            { visible: false, level: 7, tileBorders: true },
        ]);
        expect(service.layerNamesState.getValue()).toEqual(['m2/layerB']);
        expect(service.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevelState.getValue(0)).toEqual([7]);
        expect(service.layerTileBordersState.getValue(0)).toEqual([true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });
});
