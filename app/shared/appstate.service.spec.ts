import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

vi.mock('@angular/router', () => {
    class NavigationEnd {
        constructor(
            public id: number,
            public url: string,
            public urlAfterRedirects: string,
        ) {}
    }

    return {
        NavigationEnd,
        Router: class {},
        Params: {} as any,
    };
});

vi.mock('../integrations/cesium', () => {
    class Cartographic {
        constructor(
            public longitude: number,
            public latitude: number,
            public height: number,
        ) {}
    }

    const CesiumMath = {
        toDegrees(value: number) {
            return value * (180 / Math.PI);
        },
    };

    return { Cartographic, CesiumMath };
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
import { Cartographic } from '../integrations/cesium';
import { AppStateService } from './appstate.service';

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
        const service = new AppStateService(routerStub as unknown as Router);

        expect(service.markerState.getValue()).toBe(true);

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
        const service = new AppStateService(routerStub as unknown as Router);

        const destination = new Cartographic(Math.PI / 2, Math.PI / 4, 500);
        const orientation = { heading: 1, pitch: 2, roll: 3 };

        service.setView(1, destination, orientation);

        const view = service.cameraViewData.getValue(1);
        expect(view.destination).toEqual({ lon: 90, lat: 45, alt: 500 });
        expect(view.orientation).toEqual(orientation);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('stores style parameters as URL state-friendly payloads', async () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router);

        routerStub.navigate.mockClear();

        service.setStyleConfig('overlay', {
            visible: true,
            options: { opacity: 0.5, debug: false },
        });
        await flushMicrotasks();

        expect(service.stylesState.getValue()).toEqual({
            overlay: {
                v: true,
                o: {
                    opacity: 0.5,
                    debug: false,
                },
            },
        });

        const stored = localStorage.getItem('styles');
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!)).toEqual({
            overlay: {
                v: 1,
                o: {
                    opacity: 0.5,
                    debug: 0,
                },
            },
        });

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('initializes layer config with fallback values when first requested', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router);

        const config = service.mapLayerConfig('m1', 'layerA', false, 9);

        expect(config).toEqual([
            { visible: false, level: 9, tileBorders: false },
        ]);
        expect(service.layerNames.getValue()).toEqual(['m1/layerA']);
        expect(service.layerVisibility.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevel.getValue(0)).toEqual([9]);
        expect(service.layerTileBorders.getValue(0)).toEqual([false]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('persists layer config updates across mapLayerConfig calls', () => {
        const routerStub = createRouterStub();
        const service = new AppStateService(routerStub as unknown as Router);

        // Prime internal state so indices exist before updating.
        service.mapLayerConfig('m2', 'layerB');

        service.setMapLayerConfig('m2', 'layerB', [{ visible: false, level: 7, tileBorders: true }]);

        const config = service.mapLayerConfig('m2', 'layerB');

        expect(config).toEqual([
            { visible: false, level: 7, tileBorders: true },
        ]);
        expect(service.layerNames.getValue()).toEqual(['m2/layerB']);
        expect(service.layerVisibility.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevel.getValue(0)).toEqual([7]);
        expect(service.layerTileBorders.getValue(0)).toEqual([true]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });
});
