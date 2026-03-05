import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {BehaviorSubject, of, Subject} from 'rxjs';
import "@angular/compiler";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {MapTileStreamClient} from './tilestream';
import {LOW_FI_LOD0_TILE_COUNT_THRESHOLD} from "../mapview/view.visualization.model";

beforeAll(async () => {
    await initializeLibrary();
    ({MapDataService: MapDataServiceCtor} = await import('./map.service'));
});

// Stub WebSocket implementation to capture request bodies without network access.
const wsInstances: any[] = [];

class WebSocketStub {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    CONNECTING = WebSocketStub.CONNECTING;
    OPEN = WebSocketStub.OPEN;
    CLOSING = WebSocketStub.CLOSING;
    CLOSED = WebSocketStub.CLOSED;

    url: string;
    readyState: number = WebSocketStub.CONNECTING;
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    binaryType = 'arraybuffer';

    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    lastSent: any = null;

    constructor(url: string) {
        this.url = url;
        wsInstances.push(this);
        setTimeout(() => {
            this.readyState = WebSocketStub.OPEN;
            this.onopen?.(new Event('open'));
        }, 0);
    }

    send(data: any) {
        this.lastSent = data;
    }

    close() {
        this.readyState = WebSocketStub.CLOSED;
        this.onclose?.(new CloseEvent('close'));
    }
}

vi.stubGlobal('WebSocket', WebSocketStub as any);

vi.mock('./features.model', () => {
    class FeatureTileStub {
        mapTileKey: string;
        nodeId: string;
        mapName: string;
        layerName: string;
        tileId: bigint;
        legalInfo: string | undefined;
        numFeatures: number;
        error?: string;
        preventCulling: boolean;
        disposed: boolean = false;
        status?: number;
        private hasDataFlag: boolean = false;
        stats: Map<string, number[]> = new Map<string, number[]>();

        constructor(parser: any, meta: any, preventCulling: boolean, placeholder?: any) {
            const parsed = placeholder ?? (meta?.mapTileKey || meta?.mapName
                ? meta
                : parser?.readTileLayerMetadata
                    ? parser.readTileLayerMetadata(meta)
                    : {mapTileKey: '', mapName: '', layerName: '', tileId: 0n, legalInfo: undefined, numFeatures: 0});
            this.mapTileKey = parsed.mapTileKey ?? parsed.id ?? '';
            this.mapName = parsed.mapName ?? '';
            this.layerName = parsed.layerName ?? '';
            this.tileId = parsed.tileId ?? 0n;
            this.legalInfo = parsed.legalInfo;
            this.numFeatures = parsed.numFeatures ?? 0;
            this.error = parsed.error;
            this.nodeId = '';
            this.preventCulling = preventCulling;
            this.hasDataFlag = !!meta;
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

        hasData() {
            return this.hasDataFlag;
        }

        hasStage(stage: number) {
            return this.hasDataFlag && stage === 0;
        }

        highestLoadedStage() {
            return this.hasDataFlag ? 0 : null;
        }

        nextMissingStage(stageCount: number) {
            if (!this.hasDataFlag) {
                return 0;
            }
            return stageCount > 1 ? 1 : undefined;
        }

        hydrateFromBlob(_blob: Uint8Array) {
            this.hasDataFlag = true;
        }
    }

    return {
        FeatureTile: FeatureTileStub,
        FeatureWrapper: class {},
    };
});

type MapDataServiceCtorType = typeof import('./map.service').MapDataService;
let MapDataServiceCtor: MapDataServiceCtorType;

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
    deckStyleWorkersOverrideState = new BehaviorSubject<boolean>(false);
    deckStyleWorkersCountState = new BehaviorSubject<number>(2);
    tilePullCompressionEnabledState = new BehaviorSubject<boolean>(false);

    get numViews() {
        return this.numViewsState.getValue();
    }

    get tilesLoadLimit() {
        return this.tilesLoadLimitState.getValue();
    }

    get deckStyleWorkersOverride() {
        return this.deckStyleWorkersOverrideState.getValue();
    }

    get deckStyleWorkersCount() {
        return this.deckStyleWorkersCountState.getValue();
    }

    get tilePullCompressionEnabled() {
        return this.tilePullCompressionEnabledState.getValue();
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

class HttpClientStub {
    get = vi.fn().mockReturnValue(of([]));
}

const createMapDataService = () => {
    const styleService = new StyleServiceStub();
    const stateService = new AppStateServiceStub();
    const httpClient = new HttpClientStub();
    const infoService = new InfoMessageServiceStub();
    const pointMergeService = new PointMergeServiceStub();
    const keyboardService = new KeyboardServiceStub();
    const ngZone = {
        runOutsideAngular: (fn: () => unknown) => fn(),
        run: (fn: () => unknown) => fn(),
    };

    const service = new MapDataServiceCtor(
        styleService as any,
        stateService as any,
        httpClient as any,
        infoService as any,
        pointMergeService as any,
        keyboardService as any,
        ngZone as any,
    );

    // Provide a minimal tile parser stub for update() to use.
    const tileParser = {
        getFieldDictOffsets: vi.fn().mockReturnValue([0]),
        reset: vi.fn(),
        setDataSourceInfo: vi.fn(),
        readTileLayerMetadata: vi.fn().mockReturnValue({
            id: 'm1/layerA/1',
            mapName: 'm1',
            layerName: 'layerA',
            tileId: 1n,
            legalInfo: '',
            numFeatures: 0,
            nodeId: 'n1',
            error: '',
            scalarFields: {}
        }),
    };

    const tileStream = new MapTileStreamClient('/tiles');
    (tileStream as any).parser = tileParser;
    (service as any).tileStream = tileStream;

    return {service, styleService, stateService, httpClient, infoService, pointMergeService, keyboardService, tileParser};
};

describe('MapDataService', () => {
    beforeEach(() => {
        wsInstances.length = 0;
        vi.clearAllMocks();
    });

    it('computes visible and high-fidelity tile IDs per view policy', async () => {
        const {service, stateService} = createMapDataService();

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [10],
            maps: new Map(),
        };
        service.maps$.next(fakeMapTree as any);

        // Ensure we have one view state.
        stateService.numViewsState.next(1);

        // Use a non-empty viewport so the WASM helper
        // coreLib.getTileIds(...) can actually return tile IDs.
        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].viewport = {
            south: -45,
            west: -90,
            width: 90,
            height: 90,
            camPosLon: 0,
            camPosLat: 0,
            orientation: 0,
        };

        await (service as any).runUpdate();

        expect(viewStates.length).toBe(1);
        const state = viewStates[0];

        expect(state.visibleTileIds.size).toBeGreaterThan(0);
        const hasLowFidelityOnlyLevel = Array.from(state.visibleTileIdsPerLevel.values())
            .some((tileIds: bigint[]) => tileIds.length > LOW_FI_LOD0_TILE_COUNT_THRESHOLD);
        if (hasLowFidelityOnlyLevel) {
            expect(state.highFidelityTileIds.size).toBe(0);
        } else {
            expect(state.highFidelityTileIds.size).toBeGreaterThan(0);
        }
        expect(state.highFidelityTileIds.size).toBeLessThanOrEqual(state.visibleTileIds.size);
        expect([...state.highFidelityTileIds].every((id: bigint) =>
            state.visibleTileIds.has(id))).toBe(true);
    });

    it('evicts non-required tiles while keeping required ones', async () => {
        const {service, tileParser} = createMapDataService();

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            maps: new Map(),
        };
        service.maps$.next(fakeMapTree as any);

        const tileNeeded = {
            mapTileKey: 'm1/l1/1',
            tileId: 1n,
            preventCulling: false,
            setRenderOrder: vi.fn(),
            dispose: vi.fn(),
        } as any;
        const tileEvictable = {
            mapTileKey: 'm1/l1/2',
            tileId: 2n,
            preventCulling: false,
            setRenderOrder: vi.fn(),
            dispose: vi.fn(),
        } as any;
        service.loadedTileLayers.set(tileNeeded.mapTileKey, tileNeeded);
        service.loadedTileLayers.set(tileEvictable.mapTileKey, tileEvictable);

        (vi.spyOn(service as any, 'viewShowsFeatureTile') as any).mockImplementation((_viewIndex: number, tile: any) => {
            return tile === tileNeeded;
        });

        await (service as any).runUpdate();

        expect(tileEvictable.dispose).toHaveBeenCalled();
        expect(Array.from(service.loadedTileLayers.keys())).toEqual(['m1/l1/1']);
        expect(tileNeeded.dispose).not.toHaveBeenCalled();
    });

    it('updates visualizations, queues dirty ones, and drops hidden/disabled styles', async () => {
        const {service, styleService} = createMapDataService();
        const tileKey = coreLib.getTileFeatureLayerKey('m1', 'layerA', 1n);

        const tile = {
            mapName: 'm1',
            layerName: 'layerA',
            mapTileKey: tileKey,
            tileId: 1n,
            preventCulling: false,
            hasData: () => true,
            highestLoadedStage: () => 0,
            setRenderOrder: vi.fn(),
            disposed: false,
            stats: new Map<string, number[]>(),
        } as any;

        const enabledVisu = {
            tile,
            styleId: 'enabled-style',
            showTileBorder: false,
            prefersHighFidelity: false,
            maxLowFiLod: null,
            isDirty: vi.fn().mockReturnValue(true),
            renderRank: vi.fn().mockReturnValue(0),
            updateStatus: vi.fn(),
        } as any;
        const disabledVisu = {
            tile,
            styleId: 'disabled-style',
            showTileBorder: false,
            prefersHighFidelity: false,
            maxLowFiLod: null,
            isDirty: vi.fn().mockReturnValue(false),
            renderRank: vi.fn().mockReturnValue(1),
            updateStatus: vi.fn(),
        } as any;

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            maps: new Map(),
            getViewTileBorderState: vi.fn().mockReturnValue(true),
        };
        service.maps$.next(fakeMapTree as any);

        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].visibleTileIds = new Set<bigint>([1n]);
        viewStates[0].highFidelityTileIds = new Set<bigint>([1n]);
        viewStates[0].tileRenderPolicy = new Map<bigint, any>([
            [1n, {targetFidelity: 'high', maxLowFiLod: null}]
        ]);
        viewStates[0].putVisualization('enabled-style', tile.mapTileKey, enabledVisu);
        viewStates[0].putVisualization('disabled-style', tile.mapTileKey, disabledVisu);

        styleService.styles = new Map<string, any>([
            ['enabled-style', {
                id: 'enabled-style',
                visible: true,
                featureLayerStyle: {
                    hasLayerAffinity: vi.fn().mockReturnValue(true),
                    supportsHighlightMode: vi.fn().mockReturnValue(true),
                }
            }],
            ['disabled-style', {
                id: 'disabled-style',
                visible: false,
                featureLayerStyle: {
                    hasLayerAffinity: vi.fn().mockReturnValue(true),
                    supportsHighlightMode: vi.fn().mockReturnValue(true),
                }
            }],
        ]);

        service.loadedTileLayers.set(tile.mapTileKey, tile);

        const destructionSpy = vi.spyOn(service.tileVisualizationDestructionTopic, 'next');
        vi.spyOn(service as any, 'viewShowsFeatureTile').mockReturnValue(true);

        (service as any).updateVisualizations();

        expect(destructionSpy).toHaveBeenCalledWith(disabledVisu);
        expect(viewStates[0].hasVisualizations('disabled-style')).toBe(false);
        expect(viewStates[0].getVisualization('enabled-style', tile.mapTileKey)).toBe(enabledVisu);
        expect(viewStates[0].hasVisualizations('enabled-style')).toBe(true);

        expect(enabledVisu.showTileBorder).toBe(true);
        expect(enabledVisu.prefersHighFidelity).toBe(true);
        expect(viewStates[0].visualizationQueue).toContain(enabledVisu);
    });

    it('builds a tiles WebSocket request body based on selection tile requests', async () => {
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

        await (service as any).runUpdate();

        const tileSocket = wsInstances.find((ws: any) => ws.url.endsWith('/tiles'));
        expect(tileSocket).toBeDefined();
        const body = JSON.parse(tileSocket.lastSent);
        expect(body).not.toHaveProperty('flowControl');
        expect(typeof body.requestId).toBe('number');
        expect(body.requestId).toBeGreaterThan(0);
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

    it('re-requests a visible tile from its first missing stage during low-fidelity interaction', async () => {
        const {service} = createMapDataService();
        const tileKey = coreLib.getTileFeatureLayerKey('m1', 'layerA', 1n);

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            getMapLayerVisibility: () => true,
            getMapLayerLevel: () => 0,
            maps: new Map<string, any>([
                ['m1', {
                    layers: new Map<string, any>([['layerA', {info: {stages: 3}}]]),
                    allFeatureLayers: () => [{id: 'layerA'}],
                }],
            ]),
        };
        service.maps$.next(fakeMapTree as any);

        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].visibleTileIdsPerLevel = new Map<number, bigint[]>([[0, [1n]]]);
        viewStates[0].getTileRenderPolicy = vi.fn().mockReturnValue({
            targetFidelity: 'low',
            maxLowFiLod: 0,
        });

        const stagedTile = {
            mapName: 'm1',
            layerName: 'layerA',
            mapTileKey: tileKey,
            tileId: 1n,
            preventCulling: false,
            hasData: () => true,
            hasStage: (stage: number) => stage === 0,
            nextMissingStage: (stageCount: number) => (stageCount > 1 ? 1 : undefined),
        } as any;
        service.loadedTileLayers.set(stagedTile.mapTileKey, stagedTile);

        await (service as any).updateMapDataRequest();

        const tileSocket = wsInstances.find((ws: any) => ws.url.endsWith('/tiles'));
        expect(tileSocket).toBeDefined();
        const body = JSON.parse(tileSocket.lastSent);
        expect(body.requests).toEqual([
            {
                mapId: 'm1',
                layerId: 'layerA',
                tileIdsByNextStage: [
                    [],
                    [1],
                ],
            },
        ]);
    });

    it('records tile layers and legal info on arrival', () => {
        const {service, tileParser} = createMapDataService();

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
        tileParser.readTileLayerMetadata = vi.fn().mockReturnValue(tileMetadata);

        service.addTileFeatureLayer(tileBlob as any, null, false);

        expect(service.loadedTileLayers.size).toBe(1);
        expect(statsSpy).toHaveBeenCalled();
        expect(legalSpy).toHaveBeenCalledWith(true);
        const legalSet = service.legalInformationPerMap.get('m1')!;
        expect(legalSet.has('LICENSE A')).toBe(true);
    });
});
