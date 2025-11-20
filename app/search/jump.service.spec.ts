import {beforeEach, describe, expect, it, vi} from 'vitest';
import {of, Subject} from 'rxjs';

vi.mock('../integrations/cesium', () => {
    class Cartographic {
        constructor(
            public longitude: number,
            public latitude: number,
            public height: number,
        ) {}

        static fromDegrees(lon: number, lat: number) {
            return new Cartographic(lon, lat, 0);
        }
    }

    class Rectangle {}

    return {Cartographic, Rectangle};
});

vi.mock('/config/jump_plugin.js', () => ({
    default: () => ([
        {
            icon: 'pi-mock',
            color: 'green',
            name: 'Mock Jump Target',
            label: 'Mock jump target',
            enabled: false,
            jump: () => [1, 2],
            validate: () => true,
        },
    ]),
}));

import {coreLib, installCoreLibTestStub} from '../integrations/wasm';
import {JumpTargetService} from './jump.service';

installCoreLibTestStub();
const validateSimfilQueryMock = vi.fn();
const sourceDataLayerKeyMock = vi.fn(
    (mapId: string, sourceLayerId: string, tileId: bigint) => `${mapId}/${sourceLayerId}/${tileId.toString()}`,
);
(coreLib as any).validateSimfilQuery = validateSimfilQueryMock;
(coreLib as any).getSourceDataLayerKey = sourceDataLayerKeyMock;

class HttpClientStub {
    get = vi.fn();
}

class MapDataServiceStub {
    maps = {maps: new Map<string, any>()};
    sourceDataLayerIdForLayerName = vi.fn();
    tileParser: any = undefined;
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
    setMarkerState = vi.fn();
    setMarkerPosition = vi.fn();
    setSelection = vi.fn();
    focusedView = 0;
}

class FeatureSearchServiceStub {
    run = vi.fn();
}

const createService = (config: any = {}) => {
    const httpClient = new HttpClientStub();
    const mapService = new MapDataServiceStub();
    const infoService = new InfoMessageServiceStub();
    const menuService = new RightClickMenuServiceStub();
    const stateService = new AppStateServiceStub();
    const searchService = new FeatureSearchServiceStub();

    httpClient.get.mockImplementation((url: string) => {
        if (url === 'config.json') {
            return of(config);
        }
        throw new Error(`Unexpected URL ${url}`);
    });

    const service = new JumpTargetService(
        httpClient as any,
        mapService as any,
        infoService as any,
        menuService as any,
        stateService as any,
        searchService as any,
    );

    return {service, httpClient, mapService, infoService, menuService, stateService, searchService};
};

describe('JumpTargetService', () => {
    beforeEach(() => {
        validateSimfilQueryMock.mockReset();
        sourceDataLayerKeyMock.mockReset();
    });

    it('loads jump-target plugin and merges its targets into jumpTargets', async () => {
        const config = {
            extensionModules: {
                jumpTargets: 'jump_plugin',
            },
        };
        const {service} = createService(config);

        for (let i = 0; i < 10 && service.extJumpTargets.length === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        // TODO: Fix
        // expect(service.extJumpTargets.length).toBeGreaterThan(0);

        const combined = service.jumpTargets.getValue();
        expect(combined.length).toBeGreaterThanOrEqual(service.extJumpTargets.length + 2);

        const pluginNames = new Set(service.extJumpTargets.map(t => t.name));
        const combinedNames = combined.map(t => t.name);
        const hasPluginTarget = [...pluginNames].some(name => combinedNames.includes(name));
        expect(hasPluginTarget).toBe(true);
    });

    it('validates mapget tile IDs as numeric without whitespace', () => {
        const {service} = createService();

        expect(service.validateMapgetTileId('123')).toBe(true);
        expect(service.validateMapgetTileId(' 123 ')).toBe(true);
        expect(service.validateMapgetTileId('')).toBe(false);
        expect(service.validateMapgetTileId('   ')).toBe(false);
        expect(service.validateMapgetTileId('12x')).toBe(false);
        expect(service.validateMapgetTileId('1 2')).toBe(false);
    });

    it('builds inspect-tile source-data target label and validity based on map and layer presence', () => {
        const {service, mapService} = createService();

        mapService.maps.maps.set('m1', {});
        mapService.sourceDataLayerIdForLayerName.mockImplementation((name: string) =>
            name === 'layerA' ? 'LAYER-ID' : '',
        );

        service.targetValueSubject.next('12345');
        let target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('tileId = 12345 | (mapId = ?) | (sourceLayerId = ?)');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('12345 m1');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('tileId = 12345 | mapId = m1 | (sourceLayerId = ?)');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('12345 m1 layerA');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toBe('tileId = 12345 | mapId = m1 | sourceLayerId = layerA');
        expect(target.validate('any')).toBe(true);

        service.targetValueSubject.next('abc');
        target = service.getInspectTileSourceDataTarget();
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('12345 unknownMap');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toContain('Map ID not found');
        expect(target.validate('any')).toBe(false);

        service.targetValueSubject.next('12345 m1 unknownLayer');
        target = service.getInspectTileSourceDataTarget();
        expect(target.label).toContain('SourceData layer ID not found');
        expect(target.validate('any')).toBe(false);
    });

    it('executes inspect-tile source-data target and sets selection when map and layer exist', () => {
        const {service, mapService, stateService, menuService} = createService();

        mapService.maps.maps.set('m1', {});
        mapService.sourceDataLayerIdForLayerName.mockImplementation((name: string) =>
            name === 'layerA' ? 'LAYER-ID' : '',
        );
        const menuNextSpy = vi.spyOn(menuService.customTileAndMapId, 'next');

        service.targetValueSubject.next('12345 m1 layerA');
        const target = service.getInspectTileSourceDataTarget();

        if (target.execute) {
            target.execute('12345 m1 layerA');
        }

        expect(coreLib.getSourceDataLayerKey).toHaveBeenCalledWith('m1', 'LAYER-ID', 12345n);
        expect(stateService.setSelection).toHaveBeenCalledWith({
            mapTileKey: 'm1/LAYER-ID/12345',
        } as any);
        expect(menuNextSpy).not.toHaveBeenCalled();
    });

    it('forwards markedPosition to AppStateService using Cartographic.fromDegrees', () => {
        const {service, stateService} = createService();

        service.markedPosition.next([90, 90]);

        expect(stateService.setMarkerState).toHaveBeenCalledWith(true);
        expect(stateService.setMarkerPosition).toHaveBeenCalledTimes(1);
        const arg = (stateService.setMarkerPosition as any).mock.calls[0][0];
        expect(arg.longitude.toFixed(2)).toBe("1.57");
        expect(arg.latitude.toFixed(2)).toBe("1.57");
    });

    it('highlightByJumpTargetFilter chooses the first non-error feature jump action', async () => {
        const {service, mapService} = createService();

        const actions = [
            {
                name: 'A1',
                error: 'oops',
                idParts: [{key: 'id', value: '1'}],
                maps: ['m1'],
            },
            {
                name: 'A2',
                error: null,
                idParts: [{key: 'id', value: '2'}],
                maps: ['m1'],
            },
        ];

        mapService.tileParser = {
            filterFeatureJumpTargets: vi.fn(() => actions),
        };

        const highlightSpy = vi.spyOn(service, 'highlightByJumpTarget').mockResolvedValue(undefined as any);

        await service.highlightByJumpTargetFilter('m1', 'feature-2', (coreLib as any).HighlightMode.SELECTION_HIGHLIGHT);

        expect(highlightSpy).toHaveBeenCalledWith(
            actions[1],
            'm1',
            (coreLib as any).HighlightMode.SELECTION_HIGHLIGHT,
            undefined,
        );
    });
});
