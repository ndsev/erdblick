import "@angular/compiler";
import {runInInjectionContext} from "@angular/core";
import {Subject} from 'rxjs';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppActionService} from "../actions/app-action.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {Rectangle} from '../integrations/geo';
import {coreLib, initializeLibrary} from '../integrations/wasm';
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {AppStateService} from "../shared/appstate.service";
import {CoordinateJumpService} from "./coordinate-jump.service";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService, normalizeSearchJumpResult} from './jump.service';

beforeAll(async () => {
    await initializeLibrary();
});

class MapInfoServiceStub {
    maps = {maps: new Map<string, any>()};
    sourceDataLayerIdForLayerName = vi.fn();
    tileLayerParser: any = {filterFeatureJumpTargets: vi.fn().mockReturnValue([])};
}

class InspectionSelectionServiceStub {
    setHoveredFeatures = vi.fn();
    focusOnFeature = vi.fn();
}

class InfoMessageServiceStub {
    showError = vi.fn();
    showSuccess = vi.fn();
}

class RightClickMenuServiceStub {
    customTileAndMapId = new Subject<[string, string]>();
}

class FeatureSearchServiceStub {
    run = vi.fn();
    runFromActionPayload = vi.fn();
}

class AppConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

const createService = (config: any = {}) => {
    const mapService = new MapInfoServiceStub();
    const inspectionSelection = new InspectionSelectionServiceStub();
    const infoService = new InfoMessageServiceStub();
    const menuService = new RightClickMenuServiceStub();
    const inspectionState = {setSelection: vi.fn()};
    const renderer = {moveToWgs84PositionTopic: new Subject(), moveToRectangleTopic: new Subject()};
    const injector = ownerTestInjector([MapViewStateService, CoordinateJumpService,
        {provide: MapViewService, useValue: renderer},
        {provide: InspectionStateService, useValue: inspectionState}]);
    const viewState = injector.get(MapViewStateService);
    vi.spyOn(viewState, "setMarkerState");
    vi.spyOn(viewState, "setMarkerPosition");
    const searchService = new FeatureSearchServiceStub();
    injector.get(AppActionService).registerAction(FeatureSearchService.omnibarActions.run,
        ({query, payload}) => { searchService.runFromActionPayload(query, payload); });
    const configService = new AppConfigServiceStub();
    configService.getExtensionModuleId.mockImplementation((key: string) =>
        key === 'jumpTargets' ? config?.extensionModules?.jumpTargets ?? null : null
    );

    const service = runInInjectionContext(injector, () => new JumpTargetService(
        mapService as any,
        inspectionSelection as any,
        infoService as any,
        menuService as any,
        injector.get(AppStateService),
        searchService as any,
        configService as any,
    ));
    service.initialize();

    return {service, mapService, inspectionSelection, infoService, menuService, renderer, viewState, inspectionState, searchService, configService};
};

describe('JumpTargetService', () => {
    it('returns core jump failures through the registered omnibar action', async () => {
        const {service, mapService} = createService();
        mapService.tileLayerParser.filterFeatureJumpTargets.mockReturnValue([
            {id: "Road.id", name: "Road", error: null, idParts: [{key: "id", value: 1}], maps: ["Map"]}
        ]);
        const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("locate unavailable"));
        const target = service.getJumpTargetsForValue("Road.1").find(item => item.id === "fj:Road.id")!;
        await expect(target.execute!("Road.1")).rejects.toThrow("locate unavailable");
        fetch.mockRestore();
    });

    it('retires a core jump while its map selection awaits, even if the logical ID is restored', async () => {
        const {service, mapService, viewState, inspectionState} = createService();
        const original = viewState.viewIds();
        mapService.tileLayerParser.filterFeatureJumpTargets.mockReturnValue([
            {id: "Road.id", name: "Road", error: null, idParts: [{key: "id", value: 1}], maps: ["Map", "Other"]}
        ]);
        const fetch = vi.spyOn(globalThis, "fetch");
        const candidate = service.getJumpTargetsForValue("Road.1").find(item => item.id === "fj:Road.id")!;
        const pending = candidate.execute!("Road.1");
        expect(service.setSelectedMap).not.toBeNull();
        viewState.viewIdsState.next(["temporary"]);
        viewState.viewIdsState.next(original);
        service.setSelectedMap!("Map");
        await pending;
        expect(fetch).not.toHaveBeenCalled();
        expect(inspectionState.setSelection).not.toHaveBeenCalled();
        fetch.mockRestore();
    });

    it('keeps delayed plugin navigation on its captured view and rejects removed lifetimes', async () => {
        const {service, renderer, viewState} = createService();
        viewState.viewIdsState.next(["left", "right"]);
        let resolve!: (position: number[]) => void;
        const jump = vi.fn(() => new Promise<number[]>(done => { resolve = done; }));
        service.extJumpTargets = [{id: "plugin:place", name: "Place", label: "Provider", icon: "pi-map",
            color: "green", enabled: true, validate: () => true, jump}];
        const move = vi.fn();
        renderer.moveToWgs84PositionTopic.subscribe(move);
        const candidate = service.getJumpTargetsForValue("place").find(item => item.id === "plugin:place")!;
        const pending = candidate.execute!("place");
        viewState.focusedView = 1;
        viewState.reorderViews(["right", "left"]);
        resolve([48, 11]);
        await pending;
        expect(move).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({targetView: 1, x: 11, y: 48}));

        viewState.focusedView = 1;
        const retired = service.getJumpTargetsForValue("place").find(item => item.id === "plugin:place")!.execute!("place");
        viewState.viewIdsState.next(["right"]);
        viewState.viewIdsState.next(["right", "left"]);
        resolve([49, 12]);
        await expect(retired).rejects.toThrow();
        expect(move).toHaveBeenCalledOnce();
    });

    it('awaits plugin failures and retires candidates when their provider is replaced', async () => {
        const {service} = createService();
        const execute = vi.fn().mockRejectedValue(new Error("plugin unavailable"));
        const provider = {id: "plugin:live", name: "Live provider", label: "A plugin", icon: "pi-map",
            color: "green", enabled: true, validate: () => true, execute};
        service.extJumpTargets = [provider];
        const candidate = service.getJumpTargetsForValue("query").find(item => item.id === provider.id)!;
        await expect(candidate.execute!("query")).rejects.toThrow("plugin unavailable");
        const replacement = {...provider, execute: vi.fn()};
        service.extJumpTargets = [replacement];
        expect(candidate.validate("query")).toBe(false);
        await expect(candidate.execute!("query")).rejects.toThrow("no longer available");
        expect(replacement.execute).not.toHaveBeenCalled();
    });

    it('loads jump-target plugin and merges its targets into jumpTargets', async () => {
        const pluginTargets = [
            {
                id: 'plugin:mock',
                icon: 'pi-mock',
                color: 'green',
                name: 'Mock Jump Target',
                label: 'Mock jump target',
                enabled: false,
                jump: () => [1, 2],
                validate: () => true,
            },
        ];
        const loaderSpy = vi.spyOn(JumpTargetService.prototype as any, 'loadJumpTargetsModule')
            .mockResolvedValue({default: () => pluginTargets});

        const config = {
            extensionModules: {
                jumpTargets: 'jump_plugin',
            },
        };
        const {service} = createService(config);

        try {
            for (let i = 0; i < 10 && service.extJumpTargets.length === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            expect(service.extJumpTargets.length).toBeGreaterThan(0);

            const combined = service.jumpTargets.getValue();
            expect(combined.length).toBeGreaterThanOrEqual(service.extJumpTargets.length + 2);

            const pluginNames = new Set(service.extJumpTargets.map(t => t.name));
            const combinedNames = combined.map(t => t.name);
            const hasPluginTarget = [...pluginNames].some(name => combinedNames.includes(name));
            expect(hasPluginTarget).toBe(true);
            expect(service.extJumpTargets[0].id).toBe('plugin:mock');
        } finally {
            loaderSpy.mockRestore();
        }
    });

    it('rejects jump-target plugin targets without stable ids', async () => {
        const pluginTargets = [
            {
                icon: 'pi-mock',
                color: 'green',
                name: 'Mock Jump Target',
                label: 'Mock jump target',
                enabled: false,
                jump: () => [1, 2],
                validate: () => true,
            },
        ];
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const loaderSpy = vi.spyOn(JumpTargetService.prototype as any, 'loadJumpTargetsModule')
            .mockResolvedValue({default: () => pluginTargets});

        try {
            const {service} = createService({extensionModules: {jumpTargets: 'jump_plugin'}});
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            expect(service.extJumpTargets).toEqual([]);
            expect(consoleSpy).toHaveBeenCalled();
        } finally {
            loaderSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it('builds feature jump target ids from core composition ids', () => {
        const {service, mapService} = createService();
        mapService.tileLayerParser.filterFeatureJumpTargets = vi.fn(() => [
            {
                id: 'Lane.id:4',
                name: 'Lane',
                error: null,
                idParts: [{key: 'id', value: '1'}],
                maps: ['m1'],
            },
            {
                id: 'Lane.primary_id:4.secondary_id:8',
                name: 'Lane',
                error: null,
                idParts: [{key: 'primary_id', value: '1'}, {key: 'secondary_id', value: '2'}],
                maps: ['m1'],
            },
        ]);

        const featureJumpIds = service.getJumpTargetsForValue('Lane 1')
            .filter(target => target.name === 'Jump to Lane')
            .map(target => target.id);

        expect(featureJumpIds).toEqual([
            'fj:Lane.id:4',
            'fj:Lane.primary_id:4.secondary_id:8',
        ]);
    });

    it('validates packed tile IDs as signed NDS.Live tile ids without whitespace', () => {
        const {service} = createService();

        expect(service.validatePackedTileId('65536')).toBe(true);
        expect(service.validatePackedTileId(' 65536 ')).toBe(true);
        expect(service.validatePackedTileId('-2147483648')).toBe(true);
        expect(service.validatePackedTileId('123')).toBe(false);
        expect(service.validatePackedTileId('')).toBe(false);
        expect(service.validatePackedTileId('   ')).toBe(false);
        expect(service.validatePackedTileId('12x')).toBe(false);
        expect(service.validatePackedTileId('1 2')).toBe(false);
    });

    it('builds inspect-tile source-data target label and validity based on map and layer presence', () => {
        const {service, mapService} = createService();

        mapService.maps.maps.set('m1', {});
        mapService.sourceDataLayerIdForLayerName.mockImplementation((name: string) =>
            name === 'layerA' ? 'LAYER-ID' : '',
        );

        service.targetValueSubject.next('65536');
        let target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('packedTileId = 65536 | (mapId = ?) | (sourceLayerId = ?)');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('65536 m1');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('packedTileId = 65536 | mapId = m1 | (sourceLayerId = ?)');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('65536 m1 layerA');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('packedTileId = 65536 | mapId = m1 | sourceLayerId = layerA');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('abc');
        target = service.getInspectTileSourceDataTarget();
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('65536 unknownMap');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toContain('Map ID not found');
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('65536 m1 unknownLayer');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toContain('SourceData layer ID not found');
        expect(target.validate('any')).toBe(false);
    });

    it('executes inspect-tile source-data target and sets selection when map and layer exist', () => {
        const {service, mapService, inspectionState, menuService} = createService();

        mapService.maps.maps.set('m1', {});
        mapService.sourceDataLayerIdForLayerName.mockImplementation((name: string) =>
            name === 'layerA' ? 'LAYER-ID' : '',
        );
        const menuNextSpy = vi.spyOn(menuService.customTileAndMapId, 'next');

        service.targetValueSubject.next('65536 m1 layerA');
        const target = service.getInspectTileSourceDataTarget();

        if (target.execute) {
            target.execute('65536 m1 layerA');
        }

        expect(coreLib.getSourceDataLayerKey('m1', 'LAYER-ID', 65536)).toBe("SourceData:m1:LAYER-ID:65536");
        expect(inspectionState.setSelection).toHaveBeenCalledWith({
            mapTileKey: 'SourceData:m1:LAYER-ID:65536',
        } as any);
        expect(menuNextSpy).not.toHaveBeenCalled();
    });

    it('creates SourceData metadata keys using the tile-zero sentinel', () => {
        const key = coreLib.getSourceDataLayerKey('m1', 'Metadata-RegistryMetadata', 0);

        expect(key).toBe('SourceData:m1:Metadata-RegistryMetadata:0');
        expect(coreLib.parseMapTileKey(key)).toEqual(['m1', 'Metadata-RegistryMetadata', 0]);
    });

    it('publishes latitude, longitude and marker enabled state coherently through the view owner', () => {
        const {service, viewState, inspectionState} = createService();

        const observed: unknown[] = [];
        const subscription = viewState.markerState.subscribe(() => observed.push(viewState.markerControl()));
        service.markedPosition.next([48.25, 11.75, 125]);
        expect(observed).toEqual([
            {enabled: false, position: null},
            {enabled: true, position: {lat: 48.25, lon: 11.75, alt: 125}}
        ]);
        subscription.unsubscribe();
        expect(viewState.setMarkerState).toHaveBeenCalledWith(true);
        expect(viewState.setMarkerPosition).toHaveBeenCalledTimes(1);
        const arg = (viewState.setMarkerPosition as any).mock.calls[0][0];
        expect(arg.longitude).toBeCloseTo(11.75 * Math.PI / 180);
        expect(arg.latitude).toBeCloseTo(48.25 * Math.PI / 180);
        expect(arg.height).toBe(125);
    });

    it('keeps exact marker coordinates when a coordinate jump targets a tile rectangle', () => {
        const rectangle = Rectangle.fromDegrees(11, 48, 12, 49);

        expect(normalizeSearchJumpResult({
            target: rectangle,
            markerPosition: [48.25, 11.75]
        })).toEqual({
            target: rectangle,
            markerPosition: [48.25, 11.75]
        });
        expect(normalizeSearchJumpResult([48.25, 11.75, 125])).toEqual({
            target: [48.25, 11.75, 125],
            markerPosition: [48.25, 11.75, 125]
        });
    });

    it('highlightByJumpTargetFilter chooses the first non-error feature jump action', async () => {
        const {service, mapService} = createService();

        const actions = [
            {
                id: 'A1.id:4',
                name: 'A1',
                error: 'oops',
                idParts: [{key: 'id', value: '1'}],
                maps: ['m1'],
            },
            {
                id: 'A2.id:4',
                name: 'A2',
                error: null,
                idParts: [{key: 'id', value: '2'}],
                maps: ['m1'],
            },
        ];

        mapService.tileLayerParser = {
            filterFeatureJumpTargets: vi.fn(() => actions),
        };

        const highlightSpy = vi.spyOn(service, 'highlightByJumpTarget').mockResolvedValue(undefined as any);

        await service.highlightByJumpTargetFilter('m1', 'feature-2', coreLib.HighlightMode.SELECTION_HIGHLIGHT);

        expect(highlightSpy).toHaveBeenCalledWith(
            actions[1],
            'm1',
            coreLib.HighlightMode.SELECTION_HIGHLIGHT,
            undefined,
        );
    });
});
