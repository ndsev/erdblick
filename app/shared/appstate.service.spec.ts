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
            { visible: false, level: 9, tileBorders: true },
        ]);
        expect(service.layerNamesState.getValue()).toEqual(['m1/layerA']);
        expect(service.layerVisibilityState.getValue(0)).toEqual([false]);
        expect(service.layerZoomLevelState.getValue(0)).toEqual([9]);
        expect(service.layerTileBordersState.getValue(0)).toEqual([true]);

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

    it('replaces an unlocked docked inspection panel before dialogs', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
            { id: 1, features: [feature('old-docked')], locked: false, size: [30, 20], color: '#111111', undocked: false },
            { id: 2, features: [feature('old-dialog')], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        const selected = [feature('new-feature', 'map/layer/new-tile')];
        const targetPanelId = service.setSelection(selected);
        const panels = service.selection;

        expect(targetPanelId).toBe(1);
        expect(panels).toHaveLength(2);
        expect(panels.find(panel => panel.id === 1)?.features).toEqual(selected);
        expect(panels.find(panel => panel.id === 2)?.features).toEqual([feature('old-dialog')]);

        service.ngOnDestroy();
        routerStub.events.complete();
    });

    it('replaces an unlocked inspection dialog when no unlocked docked panel exists', () => {
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

    it('stores inspection dialog layout directly on selection panels', () => {
        const routerStub = createRouterStub();
        const infoServiceStub = { showError: vi.fn(), showSuccess: vi.fn(), registerDefaultContainer: vi.fn(), showAlertDialogDefault: vi.fn() } as any;
        const service = new AppStateService(routerStub as unknown as Router, infoServiceStub);

        service.selection = [
            { id: 11, features: [], locked: false, size: [30, 40], color: '#111111', undocked: true },
            { id: 22, features: [], locked: false, size: [30, 40], color: '#222222', undocked: true },
        ];

        service.setInspectionDialogPosition(11, { left: 10, top: 20 }, 0);
        service.setInspectionDialogPosition(22, { left: 30, top: 40 }, 0);

        const first = service.getInspectionDialogLayoutEntry(11);
        const second = service.getInspectionDialogLayoutEntry(22);
        expect(first?.slot).toBe(0);
        expect(second?.slot).toBe(0);

        service.setInspectionDialogPosition(11, { left: 12, top: 24 }, 9);
        expect(service.getInspectionDialogLayoutEntry(11)?.slot).toBe(0);

        service.pruneInspectionDialogLayout([22]);
        expect(service.getInspectionDialogLayoutEntry(11)?.position).toEqual({ left: 12, top: 24 });
        expect(service.getInspectionDialogLayoutEntry(22)?.position).toEqual({ left: 30, top: 40 });

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

        expect(localStorage.getItem('selected')).toContain('3:100:200');
        expect(localStorage.getItem('inspectionDialogLayoutState')).toBeNull();
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
});
