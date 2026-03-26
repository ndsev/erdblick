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
if (typeof window !== 'undefined') {
    (window as any).WebSocket = WebSocketStub as any;
}

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
    pinLowFiToMaxLodState = new BehaviorSubject<boolean>(false);

    tilesLoadLimitState = new BehaviorSubject<number>(8);
    deckThreadedRenderingEnabledState = new BehaviorSubject<boolean>(true);
    deckStyleWorkersOverrideState = new BehaviorSubject<boolean>(false);
    deckStyleWorkersCountState = new BehaviorSubject<number>(2);
    tilePullCompressionEnabledState = new BehaviorSubject<boolean>(false);
    cameraViewDataState = {
        getValue: vi.fn().mockReturnValue({
            destination: {
                alt: 1000
            }
        })
    };
    focusedView = 0;

    get numViews() {
        return this.numViewsState.getValue();
    }

    get tilesLoadLimit() {
        return this.tilesLoadLimitState.getValue();
    }

    get deckStyleWorkersOverride() {
        return this.deckStyleWorkersOverrideState.getValue();
    }

    get deckThreadedRenderingEnabled() {
        return this.deckThreadedRenderingEnabledState.getValue();
    }

    get deckStyleWorkersCount() {
        return this.deckStyleWorkersCountState.getValue();
    }

    get tilePullCompressionEnabled() {
        return this.tilePullCompressionEnabledState.getValue();
    }

    get pinLowFiToMaxLod() {
        return this.pinLowFiToMaxLodState.getValue();
    }

    get viewSync() {
        return this.viewSyncState.getValue();
    }

    getLayerSyncOption = vi.fn().mockReturnValue(false);
    getOsmState = vi.fn().mockReturnValue({enabled: false, opacity: 0});
    setOsmState = vi.fn();
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
        readTileFeatureLayer: vi.fn().mockReturnValue({
            find: vi.fn().mockReturnValue({
                isNull: () => false,
                delete: () => {}
            }),
            featureIdByAddress: vi.fn().mockReturnValue('feature-id'),
            delete: () => {}
        }),
        readTileLayerMetadata: vi.fn().mockImplementation(() => {
            const mapTileKey = coreLib.getTileFeatureLayerKey('m1', 'layerA', 1n);
            return {
                id: mapTileKey,
                mapTileKey,
                mapName: 'm1',
                layerName: 'layerA',
                tileId: 1n,
                legalInfo: '',
                numFeatures: 0,
                nodeId: 'n1',
                error: '',
                scalarFields: {}
            };
        }),
    };

    const tileStream = new MapTileStreamClient('/tiles');
    (tileStream as any).parser = tileParser;
    (service as any).tileStream = tileStream;

    return {service, styleService, stateService, httpClient, infoService, pointMergeService, keyboardService, tileParser};
};

describe('MapDataService', () => {
    const flushAsync = async (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    const makeTileKey = (tileId: number | bigint) => coreLib.getTileFeatureLayerKey('m1', 'layerA', BigInt(tileId));
    const makeTileMetadata = (tileId: number | bigint) => {
        const mapTileKey = makeTileKey(tileId);
        return {
            id: mapTileKey,
            mapTileKey,
            mapName: 'm1',
            layerName: 'layerA',
            tileId: BigInt(tileId),
            legalInfo: '',
            numFeatures: 0,
            nodeId: 'n1',
            error: '',
            scalarFields: {}
        };
    };
    const createFakeMapTree = (zoomLevels: number[] = [10]) => ({
        allLevels: (_viewIndex: number) => zoomLevels,
        maps: new Map<string, any>([
            ['m1', {
                id: 'm1',
                layers: new Map<string, any>([
                    ['layerA', {
                        id: 'layerA',
                        type: 'Features',
                        info: {zoomLevels}
                    }]
                ]),
                allFeatureLayers: () => []
            }]
        ]),
        getMapLayerVisibility: vi.fn().mockReturnValue(true),
        getMapLayerLevel: vi.fn().mockImplementation((_viewIndex: number, _mapId: string, _layerId: string) => zoomLevels[0] ?? 0),
        getMapLayerAutoLevel: vi.fn().mockReturnValue(false),
        setMapLayerLevel: vi.fn(),
        setMapLayerAutoLevel: vi.fn(),
        getViewTileBorderState: vi.fn().mockReturnValue(false)
    });

    beforeEach(() => {
        wsInstances.length = 0;
        vi.clearAllMocks();
        vi.spyOn(MapTileStreamClient.prototype, 'updateRequest').mockResolvedValue(true);
    });

    it('computes visible and high-fidelity tile IDs per view policy', async () => {
        const {service, stateService} = createMapDataService();
        const fakeMapTree = createFakeMapTree([10]);
        service.maps$.next(fakeMapTree as any);
        const getTileIdsSpy = vi.spyOn(coreLib as any, 'getTileIds').mockReturnValue([1000n, 1001n]);
        const getCanonicalTileCountSpy = vi
            .spyOn(coreLib as any, 'getNumTileIdsForCanonicalCamera')
            .mockReturnValue(2);

        try {
            stateService.numViewsState.next(1);

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
            const highFidelityTileIds = [...state.visibleTileIds].filter((tileId: bigint) =>
                state.getTileRenderPolicy(tileId).targetFidelity === 'high');

            expect(state.visibleTileIds.size).toBeGreaterThan(0);
            const visibleTileIdsPerLevel = Array.from(state.visibleTileIdsPerLevel.values()) as bigint[][];
            const hasLowFidelityOnlyLevel = visibleTileIdsPerLevel
                .some(tileIds => tileIds.length > LOW_FI_LOD0_TILE_COUNT_THRESHOLD);
            if (hasLowFidelityOnlyLevel) {
                expect(highFidelityTileIds).toHaveLength(0);
            } else {
                expect(highFidelityTileIds.length).toBeGreaterThan(0);
            }
            expect(highFidelityTileIds.length).toBeLessThanOrEqual(state.visibleTileIds.size);
            expect(highFidelityTileIds.every((id: bigint) =>
                state.visibleTileIds.has(id))).toBe(true);
        } finally {
            getTileIdsSpy.mockRestore();
            getCanonicalTileCountSpy.mockRestore();
        }
    });

    it('loads locate-resolved relation target tiles before returning them', async () => {
        const {service} = createMapDataService();
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                responses: [[{
                    tileId: 'm1/layerA/44',
                    typeId: 'LaneGroup',
                    featureId: ['tileId', 44, 'laneGroupId', 7]
                }]]
            })
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        const loadedTile = {
            mapTileKey: 'm1/layerA/44',
            hasData: () => true,
        } as any;
        const loadTilesSpy = vi.spyOn(service as any, 'loadTiles').mockResolvedValue(new Map([
            ['m1/layerA/44', loadedTile]
        ]));

        try {
            const result = await (service as any).resolveRelationExternalTiles([{
                mapId: 'm1',
                typeId: 'LaneGroup',
                featureId: ['tileId', 1, 'connPosX', 2, 'connPosY', 3, 'connPosZ', 0]
            }], coreLib.HighlightMode.SELECTION_HIGHLIGHT);

            expect(fetchMock).toHaveBeenCalledOnce();
            expect(loadTilesSpy).toHaveBeenCalledWith(new Set(['m1/layerA/44']));
            expect(result.responses).toEqual([[
                {
                    tileId: 'm1/layerA/44',
                    typeId: 'LaneGroup',
                    featureId: ['tileId', 44, 'laneGroupId', 7]
                }
            ]]);
            expect(result.tiles).toEqual([loadedTile]);
        } finally {
            vi.unstubAllGlobals();
        }
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
                    hasExplicitLowFidelityRules: vi.fn().mockReturnValue(false),
                    minimumStage: vi.fn().mockReturnValue(0),
                }
            }],
            ['disabled-style', {
                id: 'disabled-style',
                visible: false,
                featureLayerStyle: {
                    hasLayerAffinity: vi.fn().mockReturnValue(true),
                    supportsHighlightMode: vi.fn().mockReturnValue(true),
                    hasExplicitLowFidelityRules: vi.fn().mockReturnValue(false),
                    minimumStage: vi.fn().mockReturnValue(0),
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

    it('requeues a visualization immediately when it finishes stale after an in-flight policy change', () => {
        const {service, styleService} = createMapDataService();
        const tileKey = coreLib.getTileFeatureLayerKey('m1', 'layerA', 1n);

        const tile = {
            mapName: 'm1',
            layerName: 'layerA',
            mapTileKey: tileKey,
            tileId: 1n,
            preventCulling: false,
            disposed: false,
            hasData: () => true,
            level: () => 0,
            setRenderOrder: vi.fn(),
            renderOrder: () => 0,
            stats: new Map<string, number[]>(),
            numFeatures: 1,
        } as any;

        const visu = {
            tile,
            styleId: 'enabled-style',
            viewIndex: 0,
            showTileBorder: false,
            highFidelityStage: 0,
            prefersHighFidelity: false,
            maxLowFiLod: 0,
            isDirty: vi.fn().mockReturnValue(true),
            renderRank: vi.fn().mockReturnValue(0),
            updateStatus: vi.fn(),
        } as any;

        const fakeMapTree = {
            allLevels: (_viewIndex: number) => [],
            maps: new Map(),
            getViewTileBorderState: vi.fn().mockReturnValue(false),
            getMapLayerVisibility: vi.fn().mockReturnValue(true),
            getMapLayerLevel: vi.fn().mockReturnValue(0),
        };
        service.maps$.next(fakeMapTree as any);

        styleService.styles = new Map<string, any>([
            ['enabled-style', {
                id: 'enabled-style',
                visible: true,
                featureLayerStyle: {
                    hasExplicitLowFidelityRules: vi.fn().mockReturnValue(false),
                    minimumStage: vi.fn().mockReturnValue(0),
                    supportsHighlightMode: vi.fn().mockReturnValue(true),
                }
            }],
        ]);

        const scheduleOutsideAngularSpy = vi
            .spyOn(service as any, 'scheduleOutsideAngular')
            .mockImplementation(() => 0 as any);
        vi.spyOn(service as any, 'viewShowsFeatureTile').mockReturnValue(true);

        const viewStates = (service as any).viewVisualizationState as any[];
        viewStates[0].visibleTileIds = new Set<bigint>([1n]);
        viewStates[0].putVisualization('enabled-style', tile.mapTileKey, visu);
        viewStates[0].visualizationQueue = [visu];

        let dispatchedTask: any = null;
        const subscription = service.tileVisualizationTopic.subscribe(task => {
            dispatchedTask = task;
        });

        (service as any).processVisualizationTasks();

        expect(dispatchedTask).toBeTruthy();
        expect(dispatchedTask.visualization).toBe(visu);
        expect(viewStates[0].visualizationQueue).toHaveLength(0);

        dispatchedTask.onDone();

        expect(visu.updateStatus).toHaveBeenCalledWith(true);
        expect(viewStates[0].visualizationQueue).toContain(visu);

        subscription.unsubscribe();
        scheduleOutsideAngularSpy.mockRestore();
    });

    it('builds a tiles WebSocket request body based on selection tile requests', async () => {
        const {service} = createMapDataService();
        const fakeMapTree = createFakeMapTree([0]);
        service.maps$.next(fakeMapTree as any);
        const updateRequestSpy = vi.spyOn((service as any).tileStream, 'updateRequest');

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

        expect(updateRequestSpy).toHaveBeenCalledOnce();
        expect(updateRequestSpy).toHaveBeenCalledWith([
            {
                mapId: 'm1',
                layerId: 'layerA',
                tileIdsByNextStage: [[42]],
            },
        ]);

        selectionTileRequest.resolve!(null);
        await selectionTilePromise;
    });

    it('restores feature panels immediately from placeholder tiles while selection data is still loading', async () => {
        const {service, stateService} = createMapDataService();
        await service.initialize();

        stateService.selectionState.next([
            {
                id: 1,
                features: [{mapTileKey: makeTileKey(1), featureId: 'f1'}],
                locked: false,
                size: [30, 20],
                color: '#111111',
                undocked: false
            },
            {
                id: 2,
                features: [{mapTileKey: makeTileKey(2), featureId: 'f2'}],
                locked: true,
                size: [30, 20],
                color: '#222222',
                undocked: false
            }
        ]);

        await flushAsync();

        const panels = service.selectionTopic.getValue();
        expect(panels).toHaveLength(2);
        expect(panels.every(panel => panel.features.length === 1)).toBe(true);
        expect(Array.from(service.loadedTileLayers.values()).every(tile => tile.hasData() === false)).toBe(true);
        expect(service.selectionTileRequests.map(request => request.remoteRequest.tileIds[0]).sort((lhs, rhs) => lhs - rhs)).toEqual([
            1,
            2
        ]);
    });

    it('keeps SourceData panels when feature selection loading fails', async () => {
        const {service, stateService} = createMapDataService();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await service.initialize();

        try {
            vi.spyOn(service, 'loadFeatures').mockImplementation(async (tileFeatureIds: any[]) => {
                if (tileFeatureIds.length > 0) {
                    throw new Error('forced load failure');
                }
                return [];
            });

            stateService.selectionState.next([
                {
                    id: 1,
                    features: [{mapTileKey: makeTileKey(1), featureId: 'f1'}],
                    locked: false,
                    size: [30, 20],
                    color: '#111111',
                    undocked: false
                },
                {
                    id: 2,
                    features: [],
                    sourceData: {mapTileKey: 'SourceData:m1:SourceData-LAYER:1'},
                    locked: false,
                    size: [30, 40],
                    color: '#222222',
                    undocked: true
                }
            ]);

            await flushAsync();
            await flushAsync();

            const panels = service.selectionTopic.getValue();
            expect(panels.some(panel => panel.id === 2 && panel.sourceData?.mapTileKey === 'SourceData:m1:SourceData-LAYER:1')).toBe(true);
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    it('applies the latest selection emission when updates overlap', async () => {
        const {service, stateService} = createMapDataService();
        await service.initialize();

        let loadCall = 0;
        vi.spyOn(service, 'loadFeatures').mockImplementation(async (tileFeatureIds: any[]) => {
            loadCall += 1;
            if (loadCall === 1 && tileFeatureIds.length > 0) {
                await flushAsync(25);
            }
            return [];
        });

        stateService.selectionState.next([
            {
                id: 1,
                features: [{mapTileKey: makeTileKey(1), featureId: 'f1'}],
                locked: false,
                size: [30, 20],
                color: '#111111',
                undocked: false
            },
            {
                id: 2,
                features: [],
                sourceData: {mapTileKey: 'SourceData:m1:SourceData-LAYER:1'},
                locked: false,
                size: [30, 40],
                color: '#222222',
                undocked: true
            }
        ]);

        await flushAsync(1);

        stateService.selectionState.next([
            {
                id: 2,
                features: [],
                sourceData: {mapTileKey: 'SourceData:m1:SourceData-LAYER:9'},
                locked: false,
                size: [30, 40],
                color: '#222222',
                undocked: true
            }
        ]);

        await flushAsync(50);

        const panels = service.selectionTopic.getValue();
        expect(panels).toHaveLength(1);
        expect(panels[0].id).toBe(2);
        expect(panels[0].sourceData?.mapTileKey).toBe('SourceData:m1:SourceData-LAYER:9');
    });

    it('records tile layers and legal info on arrival', () => {
        const {service, tileParser} = createMapDataService();

        const statsSpy = vi.spyOn(service.statsDialogNeedsUpdate, 'next');
        const legalSpy = vi.spyOn(service.legalInformationUpdated, 'next');

        const tileMetadata = {
            ...makeTileMetadata(1),
            nodeId: '',
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
