import "@angular/compiler";
import {
    beforeAll,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { Subject } from 'rxjs';
import { AppActionRegistry } from '../../../app/action/action-registry.service';
import { testPersistence } from '../../support/state-owners';
import { coreLib, initializeLibrary } from '../../../app/integrations/wasm.adapter';
import { Rectangle } from '../../../app/integrations/geo.adapter';
import { JumpTargetService, normalizeSearchJumpResult } from '../../../app/navigation/jump.service';

beforeAll(async () => {
    await initializeLibrary();
});

class MapInfoServiceStub {
    maps = { maps: new Map<string, any>() };
    sourceDataLayerIdForLayerName = vi.fn();
    tileLayerParser: any = { filterFeatureJumpTargets: vi.fn().mockReturnValue([]) };
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

class AppStateServiceStub {
    state = { selectionState: new Subject() };
    setMarker = vi.fn();
    setSelection = vi.fn();
    focusedView = 0;
}

class FeatureSearchServiceStub {
    run = vi.fn();
}

class ConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

const createService = (config: any = {}, initialize = true) => {
    const mapService = new MapInfoServiceStub();
    const inspectionSelection = new InspectionSelectionServiceStub();
    const infoService = new InfoMessageServiceStub();
    const menuService = new RightClickMenuServiceStub();
    const stateService = new AppStateServiceStub();
    const searchService = new FeatureSearchServiceStub();
    const configService = new ConfigServiceStub();
    const tileStream = {locateFeatureReference: vi.fn()};
    configService.getExtensionModuleId.mockImplementation((key: string) =>
        key === 'jumpTargets' ? config?.extensionModules?.jumpTargets ?? null : null
    );

    const service = new JumpTargetService(
        mapService as any,
        inspectionSelection as any,
        infoService as any,
        menuService as any,
        configService as any, stateService as any as never, stateService as any as never, Object.assign(stateService as any, { viewIdAt: (index: number) => String(index) }) as never, stateService as any as never, tileStream as never
    );

    if (initialize) service.initialize();
    return { service, mapService, inspectionSelection, infoService, menuService, stateService, searchService, configService, tileStream };
};

describe('JumpTargetService', () => {
    it('publishes only located identities and discards a result after another inspection edit', async () => {
        const h = createService({}, false);
        const reference = {mapId: "Remote", typeId: "Road", id: {id: 9007199254740993n}};
        const targets = [{mapTileKey: "remote-partition", featureId: "Road.9007199254740993"}];
        h.tileStream.locateFeatureReference.mockResolvedValue(targets);
        await h.service.highlightFeatureReference(reference);
        expect(h.stateService.setSelection).toHaveBeenCalledWith(targets);
        h.stateService.setSelection.mockClear();
        let finish!: (value: typeof targets) => void;
        h.tileStream.locateFeatureReference.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const pending = h.service.highlightFeatureReference(reference);
        h.stateService.state.selectionState.next([]);
        finish(targets);
        await pending;
        expect(h.stateService.setSelection).not.toHaveBeenCalled();
        expect(h.stateService.state.selectionState.observed).toBe(false);
    });

    it('cancels a departed reference hover before it can publish', async () => {
        const h = createService({}, false);
        const controller = new AbortController();
        h.tileStream.locateFeatureReference.mockResolvedValue([{mapTileKey: "remote", featureId: "Road.7"}]);
        const pending = h.service.highlightFeatureReference(
            {mapId: "Remote", typeId: "Road", id: {id: 7}}, coreLib.HighlightMode.HOVER_HIGHLIGHT, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: "AbortError"});
        expect(h.inspectionSelection.setHoveredFeatures).not.toHaveBeenCalled();
    });

    it('does not construct the native parser before explicit startup', () => {
        const { service, mapService } = createService({}, false);
        expect(mapService.tileLayerParser.filterFeatureJumpTargets).not.toHaveBeenCalled();
        service.initialize();
        expect(mapService.tileLayerParser.filterFeatureJumpTargets).not.toHaveBeenCalled();
        service.initialize();
        expect(mapService.tileLayerParser.filterFeatureJumpTargets).not.toHaveBeenCalled();
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
            .mockResolvedValue({ default: () => pluginTargets });

        const config = {
            extensionModules: {
                jumpTargets: 'jump_plugin',
            },
        };
        const { service } = createService(config);

        try {
            for (let i = 0; i < 10 && service.extJumpTargets.length === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            expect(service.extJumpTargets.length).toBeGreaterThan(0);

            const actions = new AppActionRegistry(testPersistence());
            service.registerActions(actions);
            const combined = actions.getCandidates("test");
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
            .mockResolvedValue({ default: () => pluginTargets });

        try {
            const { service } = createService({ extensionModules: { jumpTargets: 'jump_plugin' } });
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
        const { service, mapService } = createService();
        mapService.tileLayerParser.filterFeatureJumpTargets = vi.fn(() => [
            {
                id: 'Lane.id:4',
                name: 'Lane',
                error: null,
                idParts: [{ key: 'id', value: '1' }],
                maps: ['m1'],
            },
            {
                id: 'Lane.primary_id:4.secondary_id:8',
                name: 'Lane',
                error: null,
                idParts: [{ key: 'primary_id', value: '1' }, { key: 'secondary_id', value: '2' }],
                maps: ['m1'],
            },
        ]);

        const featureJumpIds = service.featureTargetsForValue('Lane 1')
            .filter(target => target.name === 'Jump to Lane')
            .map(target => target.id);

        expect(featureJumpIds).toEqual([
            'fj:Lane.id:4',
            'fj:Lane.primary_id:4.secondary_id:8',
        ]);
    });

    it('validates packed tile IDs as signed NDS.Live tile ids without whitespace', () => {
        const { service } = createService();

        expect(service.validatePackedTileId('65536')).toBe(true);
        expect(service.validatePackedTileId(' 65536 ')).toBe(true);
        expect(service.validatePackedTileId('-2147483648')).toBe(true);
        expect(service.validatePackedTileId('123')).toBe(false);
        expect(service.validatePackedTileId('')).toBe(false);
        expect(service.validatePackedTileId('   ')).toBe(false);
        expect(service.validatePackedTileId('12x')).toBe(false);
        expect(service.validatePackedTileId('1 2')).toBe(false);
    });

    it('builds source-data bubbles and validates map and layer presence without error labels', () => {
        const { service, mapService } = createService();

        mapService.maps.maps.set('m1', {});
        mapService.sourceDataLayerIdForLayerName.mockImplementation((name: string) =>
            name === 'layerA' ? 'LAYER-ID' : '',
        );

        service.targetValueSubject.next('65536');
        let target = service.getInspectTileSourceDataTarget();
        expect(target.bubbles).toEqual([
            {name: 'packedTileId', value: 65536},
            {name: 'mapId', value: undefined, optional: true},
            {name: 'sourceLayerId', value: undefined, optional: true}
        ]);
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('65536 m1');
        target = service.getInspectTileSourceDataTarget();
        expect(target.bubbles?.[1]).toEqual({name: 'mapId', value: 'm1', optional: true});
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('65536 m1 layerA');
        target = service.getInspectTileSourceDataTarget();
        expect(target.bubbles?.[2]).toEqual({name: 'sourceLayerId', value: 'layerA', optional: true});
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('abc');
        target = service.getInspectTileSourceDataTarget();
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('65536 unknownMap');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('');
        expect(target.bubbles?.[1].value).toBe('unknownMap');
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('65536 m1 unknownLayer');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('');
        expect(target.bubbles?.[2].value).toBe('unknownLayer');
        expect(target.validate('any')).toBe(false);
    });

    it('preserves coordinate ordering and zeroes in the displayed bubbles', () => {
        const {service} = createService();
        const candidates = service.coordinateTargetsForValue('0,11');
        expect(candidates.find(candidate => candidate.id === 'j:wgs84-lon-lat')?.bubbles).toEqual([
            {name: 'lon', value: 0}, {name: 'lat', value: 11}, {name: 'level', value: undefined, optional: true}
        ]);
        expect(candidates.find(candidate => candidate.id === 'j:wgs84-lat-lon')?.bubbles).toEqual([
            {name: 'lat', value: 0}, {name: 'lon', value: 11}, {name: 'level', value: undefined, optional: true}
        ]);
    });

    it('executes inspect-tile source-data target and sets selection when map and layer exist', () => {
        const { service, mapService, stateService, menuService } = createService();

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
        expect(stateService.setSelection).toHaveBeenCalledWith({
            mapTileKey: 'SourceData:m1:LAYER-ID:65536',
        } as any);
        expect(menuNextSpy).not.toHaveBeenCalled();
    });

    it('creates SourceData metadata keys using the tile-zero sentinel', () => {
        const key = coreLib.getSourceDataLayerKey('m1', 'Metadata-RegistryMetadata', 0);

        expect(key).toBe('SourceData:m1:Metadata-RegistryMetadata:0');
        expect(coreLib.parseMapTileKey(key)).toEqual(['m1', 'Metadata-RegistryMetadata', 0]);
    });

    it('forwards one atomic marker edit to the coordinate owner in longitude/latitude order', () => {
        const { service, stateService } = createService();

        service.markedPosition.next([48.25, 11.75, 125]);

        expect(stateService.setMarker).toHaveBeenCalledExactlyOnceWith({
            enabled: true,
            position: { lon: 11.75, lat: 48.25, alt: 125 }
        });
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
        const { service, mapService } = createService();

        const actions = [
            {
                id: 'A1.id:4',
                name: 'A1',
                error: 'oops',
                idParts: [{ key: 'id', value: '1' }],
                maps: ['m1'],
            },
            {
                id: 'A2.id:4',
                name: 'A2',
                error: null,
                idParts: [{ key: 'id', value: '2' }],
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
