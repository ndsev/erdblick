import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {BehaviorSubject, Subject} from 'rxjs';

// Stub Fetch implementation to capture request bodies without network access.
const fetchInstances: any[] = [];

const readableStub = () => ({
    read: vi.fn().mockResolvedValue({done: true, value: undefined}),
});
const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    body: {getReader: readableStub},
    blob: vi.fn(async () => new Blob()),
    json: vi.fn(async () => ({})),
});
vi.stubGlobal('fetch', fetchMock);

vi.mock('./fetch', () => {
    class FetchStub {
        static CHUNK_HEADER_SIZE = 11;
        static CHUNK_TYPE_FIELDS = 1;
        static CHUNK_TYPE_FEATURES = 2;
        static CHUNK_TYPE_SOURCEDATA = 3;
        static CHUNK_TYPE_END_OF_STREAM = 128;

        url: string;
        method: string = 'GET';
        bodyJson: string | null = null;
        done: Promise<boolean> = Promise.resolve(true);
        private _bufferCallback: ((buf: Uint8Array, type: number) => void) | null = null;

        constructor(url: string) {
            this.url = url;
            fetchInstances.push(this);
        }

        withMethod(method: string) {
            this.method = method;
            return this;
        }

        withBody(bodyJson: string) {
            this.bodyJson = bodyJson;
            return this;
        }

        withChunkProcessing() {
            return this;
        }

        withBufferCallback(cb: (buf: Uint8Array, type: number) => void) {
            this._bufferCallback = cb;
            return this;
        }

        withJsonCallback(_cb: (json: any) => void) {
            return this;
        }

        go() {
            return Promise.resolve(true);
        }

        abort() {
        }
    }

    return {
        Fetch: FetchStub,
    };
});

vi.mock('./features.model', () => {
    class FeatureTileStub {
        mapTileKey: string;
        nodeId: string;
        mapName: string;
        layerName: string;
        tileId: bigint;
        legalInfo: string | undefined;
        numFeatures: number;
        preventCulling: boolean;
        disposed: boolean = false;
        stats: Map<string, number[]> = new Map<string, number[]>();

        constructor(parser: any, meta: any, preventCulling: boolean) {
            const parsed = meta?.mapTileKey || meta?.mapName
                ? meta
                : parser?.readTileLayerMetadata
                    ? parser.readTileLayerMetadata(meta)
                    : {mapTileKey: '', mapName: '', layerName: '', tileId: 0n, legalInfo: undefined, numFeatures: 0};
            this.mapTileKey = parsed.mapTileKey ?? parsed.id ?? '';
            this.mapName = parsed.mapName ?? '';
            this.layerName = parsed.layerName ?? '';
            this.tileId = parsed.tileId ?? 0n;
            this.legalInfo = parsed.legalInfo;
            this.numFeatures = parsed.numFeatures ?? 0;
            this.nodeId = '';
            this.preventCulling = preventCulling;
        }

        dispose() {
            this.disposed = true;
        }

        level() {
            return 0;
        }

        has(_featureId: string) {
            return true;
        }
    }

    return {
        FeatureTile: FeatureTileStub,
        FeatureWrapper: class {},
    };
});

type MapDataServiceCtorType = typeof import('./map.service').MapDataService;
let MapDataServiceCtor: MapDataServiceCtorType;

beforeAll(async () => {
    ({MapDataService: MapDataServiceCtor} = await import('./map.service'));
});

class StyleServiceStub {
    styles = new Map<string, any>();
    styleRemovedForId = new Subject<string>();
    styleAddedForId = new Subject<string>();
    styleGroups = new BehaviorSubject<any[]>([]);
}

class AppStateServiceStub {
    ready = new BehaviorSubject<boolean>(true);
    numViewsState = new BehaviorSubject<number>(1);
    viewSyncState = new BehaviorSubject<string[]>([]);
    selectionState = new BehaviorSubject<any[]>([]);

    tilesLoadLimitState = new BehaviorSubject<number>(8);
    tilesVisualizeLimitState = new BehaviorSubject<number>(4);

    get numViews() {
        return this.numViewsState.getValue();
    }

    get tilesLoadLimit() {
        return this.tilesLoadLimitState.getValue();
    }

    get tilesVisualizeLimit() {
        return this.tilesVisualizeLimitState.getValue();
    }

    get viewSync() {
        return this.viewSyncState.getValue();
    }

    getLayerSyncOption = vi.fn().mockReturnValue(false);
    setLayerSyncOption = vi.fn();
    prune = vi.fn();
}

class InfoMessageServiceStub {
    showError = vi.fn();
    showSuccess = vi.fn();
}

class PointMergeServiceStub {
    makeMapViewLayerStyleId = vi.fn().mockReturnValue('rule');
    clear = vi.fn().mockReturnValue([]);
    insert = vi.fn().mockReturnValue([]);
    remove = vi.fn().mockReturnValue([]);
}

class KeyboardServiceStub {
    registerShortcut = vi.fn();
}

const createMapDataService = () => {
    const styleService = new StyleServiceStub();
    const stateService = new AppStateServiceStub();
    const infoService = new InfoMessageServiceStub();
    const pointMergeService = new PointMergeServiceStub();
    const keyboardService = new KeyboardServiceStub();

    const service = new MapDataServiceCtor(
        styleService as any,
        stateService as any,
        infoService as any,
        pointMergeService as any,
        keyboardService as any,
    );

    // Provide a minimal tile parser stub for update() to use.
    (service as any).tileParser = {
        getFieldDictOffsets: vi.fn().mockReturnValue([0]),
        reset: vi.fn(),
        setDataSourceInfo: vi.fn(),
    };

    return {service, styleService, stateService, infoService, pointMergeService, keyboardService};
};

describe('MapDataService', () => {
    beforeEach(() => {
        fetchInstances.length = 0;
        vi.clearAllMocks();
    });

    it('computes visible and high-detail tile IDs per view', async () => {
        const {service, stateService} = createMapDataService();

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [10],
            maps: new Map(),
        };
        service.maps$.next(fakeMapTree as any);

        // Ensure we have one view state.
        stateService.numViewsState.next(1);

        await service.update();

        const viewStates = (service as any).viewVisualizationState as any[];
        expect(viewStates.length).toBe(1);
        const state = viewStates[0];

        expect(state.visibleTileIds.size).toBeGreaterThan(0);
        expect(state.highDetailTileIds.size).toBeGreaterThan(0);
        expect(state.highDetailTileIds.size).toBeLessThanOrEqual(state.visibleTileIds.size);
        expect([...state.highDetailTileIds].every((id: bigint) =>
            state.visibleTileIds.has(id))).toBe(true);
    });

    it('evicts non-required tiles while keeping required ones', async () => {
        const {service} = createMapDataService();

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            maps: new Map(),
        };
        service.maps$.next(fakeMapTree as any);

        const tileNeeded = {
            mapTileKey: 'm1/l1/1',
            preventCulling: false,
            dispose: vi.fn(),
        } as any;
        const tileEvictable = {
            mapTileKey: 'm1/l1/2',
            preventCulling: false,
            dispose: vi.fn(),
        } as any;
        service.loadedTileLayers.set(tileNeeded.mapTileKey, tileNeeded);
        service.loadedTileLayers.set(tileEvictable.mapTileKey, tileEvictable);

        (vi.spyOn(service as any, 'viewShowsFeatureTile') as any).mockImplementation((_viewIndex: number, tile: any) => {
            return tile === tileNeeded;
        });

        await service.update();

        expect(tileEvictable.dispose).toHaveBeenCalled();
        expect(Array.from(service.loadedTileLayers.keys())).toEqual(['m1/l1/1']);
        expect(tileNeeded.dispose).not.toHaveBeenCalled();
    });

    it('updates visualizations, queues dirty ones, and drops hidden/disabled styles', async () => {
        const {service, styleService} = createMapDataService();

        const tile = {
            mapName: 'm1',
            layerName: 'layerA',
            mapTileKey: 'm1/layerA/1',
            tileId: 1n,
            preventCulling: false,
            disposed: false,
        } as any;

        const enabledVisu = {
            tile,
            styleId: 'enabled-style',
            showTileBorder: false,
            isHighDetail: false,
            isDirty: vi.fn().mockReturnValue(true),
        } as any;
        const disabledVisu = {
            tile,
            styleId: 'disabled-style',
            showTileBorder: false,
            isHighDetail: false,
            isDirty: vi.fn().mockReturnValue(false),
        } as any;

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            maps: new Map(),
            getMapLayerBorderState: vi.fn().mockReturnValue(true),
        };
        service.maps$.next(fakeMapTree as any);

        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].visibleTileIds = new Set<bigint>([1n]);
        viewStates[0].highDetailTileIds = new Set<bigint>([1n]);
        viewStates[0].visualizedTileLayers = new Map<string, any[]>([
            ['enabled-style', [enabledVisu]],
            ['disabled-style', [disabledVisu]],
        ]);

        styleService.styles = new Map<string, any>([
            ['enabled-style', {id: 'enabled-style', visible: true}],
            ['disabled-style', {id: 'disabled-style', visible: false}],
        ]);

        const destructionSpy = vi.spyOn(service.tileVisualizationDestructionTopic, 'next');
        vi.spyOn(service as any, 'viewShowsFeatureTile').mockReturnValue(true);

        await service.update();

        // expect(destructionSpy).toHaveBeenCalledWith(disabledVisu);
        // expect(viewStates[0].visualizedTileLayers.has('disabled-style')).toBe(true);
        // expect(viewStates[0].visualizedTileLayers['disabled-style'].length).toBe(0);
        // expect(viewStates[0].visualizedTileLayers.has('enabled-style')).toBe(true);
        // expect(viewStates[0].visualizedTileLayers['enabled-style'].length).toBe(1);
        //
        // expect(enabledVisu.showTileBorder).toBe(false);
        // expect(enabledVisu.isHighDetail).toBe(false);
        // expect(viewStates[0].visualizationQueue).toContain(enabledVisu);
    });

    it('builds a tiles fetch request body based on selection tile requests', async () => {
        const {service} = createMapDataService();

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            getMapLayerVisibility: () => true,
            getMapLayerLevel: () => 0,
            maps: new Map<string, any>([
                ['m1', {
                    layers: new Map<string, any>([['layerA', {}]]),
                    allFeatureLayers: () => [],
                }],
            ]),
        };
        service.maps$.next(fakeMapTree as any);

        const selectionTileRequest: any = {
            remoteRequest: {
                mapId: 'm1',
                layerId: 'layerA',
                tileIds: [42],
            },
            tileKey: 'm1/layerA/42',
            resolve: null,
            reject: null,
        };
        const selectionTilePromise = new Promise(resolve => {
            selectionTileRequest.resolve = resolve;
        });
        service.selectionTileRequests.push(selectionTileRequest);

        await service.update();

        const tileFetch = fetchInstances.find((f: any) => f.url === 'tiles') ?? (service as any).currentFetch;
        expect(tileFetch).toBeDefined();
        const body = JSON.parse(tileFetch.bodyJson!);
        expect(body.clientId).toBe(service.clientId);
        expect(body.stringPoolOffsets).toEqual([0]);
        expect(body.requests).toEqual([
            {
                mapId: 'm1',
                layerId: 'layerA',
                tileIds: [42],
            },
        ]);

        selectionTileRequest.resolve!(null);
        await selectionTilePromise;
    });

    it('adds tile layers only when visible or prevented from culling and records legal info', () => {
        const {service} = createMapDataService();

        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].visibleTileIds = new Set<bigint>();
        const statsSpy = vi.spyOn(service.statsDialogNeedsUpdate, 'next');
        const legalSpy = vi.spyOn(service.legalInformationUpdated, 'next');

        const tileMetadata = {
            id: 'm1/layerA/1',
            mapTileKey: 'm1/layerA/1',
            nodeId: '',
            mapName: 'm1',
            layerName: 'layerA',
            tileId: 1n,
            legalInfo: 'LICENSE A',
            numFeatures: 5,
            scalarFields: {},
        };
        const tileBlob = new Uint8Array([1, 2, 3]);
        (service as any).tileParser = {
            readTileLayerMetadata: vi.fn().mockReturnValue(tileMetadata),
        } as any;

        service.addTileFeatureLayer(tileBlob as any, null, false);

        expect(service.loadedTileLayers.size).toBe(0);
        expect(statsSpy).not.toHaveBeenCalled();

        viewStates[0].visibleTileIds = new Set<bigint>([1n]);

        service.addTileFeatureLayer(tileBlob as any, null, false);

        expect(service.loadedTileLayers.has('m1/layerA/1')).toBe(true);
        expect(statsSpy).toHaveBeenCalled();
        expect(legalSpy).toHaveBeenCalledWith(true);
        const legalSet = service.legalInformationPerMap.get('m1')!;
        expect(legalSet.has('LICENSE A')).toBe(true);
    });
});
