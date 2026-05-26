import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {BehaviorSubject, of, Subject} from 'rxjs';
import "@angular/compiler";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {MapTileRequestStatus, MapTileStreamClient} from './tilestream';
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
(window as any).WebSocket = WebSocketStub as any;

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
    debugRenderFullGltfAttachmentState = new BehaviorSubject<boolean>(false);
    debugGltfLoggingEnabledState = new BehaviorSubject<boolean>(false);
    tilePullCompressionEnabledState = new BehaviorSubject<boolean>(false);
    cameraViewDataState = {
        getValue: vi.fn().mockReturnValue({
            destination: {
                alt: 1000
            }
        })
    };
    focusedView = 0;
    focusedInspectionPanelId: number | undefined = undefined;

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

    get debugRenderFullGltfAttachment() {
        return this.debugRenderFullGltfAttachmentState.getValue();
    }

    get debugGltfLoggingEnabled() {
        return this.debugGltfLoggingEnabledState.getValue();
    }

    get pinLowFiToMaxLod() {
        return this.pinLowFiToMaxLodState.getValue();
    }

    get viewSync() {
        return this.viewSyncState.getValue();
    }

    getLayerSyncOption = vi.fn().mockReturnValue(false);
    getBackgroundState = vi.fn().mockReturnValue({layerId: null, opacity: 0});
    setBackgroundState = vi.fn();
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

    it('registers Ctrl+j to zoom the focused inspection panel in the focused view', () => {
        const {service, stateService, keyboardService} = createMapDataService();
        const shortcut = keyboardService.registerShortcut.mock.calls
            .find(([keys]) => keys === 'Ctrl+j')?.[1];
        expect(typeof shortcut).toBe('function');

        vi.spyOn(service as any, 'viewShowsFeatureTile').mockReturnValue(false);
        const makeFeatureWrapper = (featureId: string) => ({
            featureId,
            featureTile: {
                mapTileKey: makeTileKey(1),
                dataVersion: 0,
                highestLoadedStage: () => 0,
                mapName: 'm1',
                layerName: 'layerA',
                tileId: 1n,
                level: () => 10
            }
        }) as any;
        const olderFeature = makeFeatureWrapper('older');
        const newestFeature = makeFeatureWrapper('newest');
        service.selectionTopic.next([
            {
                id: 1,
                features: [olderFeature],
                locked: true,
                size: [0, 0],
                color: '#ffffff',
                undocked: false
            },
            {
                id: 2,
                features: [newestFeature],
                locked: false,
                size: [0, 0],
                color: '#ffffff',
                undocked: false
            },
            {
                id: 3,
                features: [],
                sourceData: {mapTileKey: makeTileKey(1)},
                locked: false,
                size: [0, 0],
                color: '#ffffff',
                undocked: false
            }
        ]);
        stateService.focusedView = 0;
        stateService.focusedInspectionPanelId = 1;
        const zoomSpy = vi.spyOn(service, 'zoomToFeature').mockImplementation(() => {});

        shortcut!(new KeyboardEvent('keydown', {key: 'j', ctrlKey: true}));

        expect(zoomSpy).toHaveBeenCalledWith(0, olderFeature);
    });

    it('zooms a focused SourceData inspection to its tile bounds', () => {
        const {service, stateService} = createMapDataService();
        const rectangles: Array<{targetView: number; rectangle: any}> = [];
        const subscription = service.moveToRectangleTopic.subscribe(value => rectangles.push(value));
        const tileId = 12345n;
        const sourceDataTileKey = coreLib.getSourceDataLayerKey('m1', 'SourceData-LAYER', tileId);
        service.selectionTopic.next([{
            id: 4,
            features: [],
            sourceData: {mapTileKey: sourceDataTileKey},
            locked: false,
            size: [0, 0],
            color: '#ffffff',
            undocked: true
        } as any]);
        stateService.focusedView = 0;
        stateService.focusedInspectionPanelId = 4;

        service.zoomToFocusedInspectionPanel();

        const [west, south, east, north] = coreLib.getTileBox(tileId) as number[];
        expect(rectangles).toHaveLength(1);
        expect(rectangles[0].targetView).toBe(0);
        expect(rectangles[0].rectangle).toEqual({west, south, east, north});
        subscription.unsubscribe();
    });

    it('zooms features through the Deck WGS84 camera topic without using the old mesh normal path', () => {
        const {service} = createMapDataService();
        const moves: Array<{targetView: number; x: number; y: number; z?: number}> = [];
        const subscription = service.moveToWgs84PositionTopic.subscribe(value => moves.push(value));
        const feature = {
            center: vi.fn().mockReturnValue({x: 11, y: 48, z: 2}),
            boundingRadiusEndPoint: vi.fn().mockReturnValue({x: 11.001, y: 48, z: 2}),
            getGeometryType: vi.fn().mockReturnValue(coreLib.GeomType.Mesh),
            inspectionModel: vi.fn(() => {
                throw new Error('old mesh path should not be used');
            })
        };
        const featureWrapper = {
            featureTile: {
                mapName: 'm1',
                layerName: 'layerA',
                tileId: 1n,
                level: () => 10,
            },
            peek: (cb: (feature: any) => void) => cb(feature),
        } as any;

        service.zoomToFeature(0, featureWrapper);

        expect(feature.inspectionModel).not.toHaveBeenCalled();
        expect(moves).toHaveLength(1);
        expect(moves[0]).toMatchObject({targetView: 0, x: 11, y: 48});
        expect(moves[0].z).toBeGreaterThan(100);
        subscription.unsubscribe();
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
            setStyleOption: vi.fn(),
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
            setStyleOption: vi.fn(),
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
        expect(viewStates[0].visualizationQueue.items).toContain(enabledVisu);
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
        (service as any).queueVisualization(viewStates[0], visu);

        let dispatchedTask: any = null;
        const subscription = service.tileVisualizationTopic.subscribe(task => {
            dispatchedTask = task;
        });

        (service as any).processVisualizationTasks();

        expect(dispatchedTask).toBeTruthy();
        expect(dispatchedTask.visualization).toBe(visu);
        expect(viewStates[0].visualizationQueue.items).toHaveLength(0);

        dispatchedTask.onDone();

        expect(visu.updateStatus).toHaveBeenCalledWith(true);
        expect(viewStates[0].visualizationQueue.items).toContain(visu);

        subscription.unsubscribe();
        scheduleOutsideAngularSpy.mockRestore();
    });

    it('sorts visualization queues lazily before dequeueing work', () => {
        const {service} = createMapDataService();
        const viewStates = (service as any).viewVisualizationState as any[];
        const viewState = viewStates[0];
        const makeVisualization = (rank: number, tileKey: string) => ({
            tile: {
                tileId: BigInt(rank),
                mapTileKey: tileKey,
            },
            styleId: 'style',
            renderRank: vi.fn().mockReturnValue(rank),
        });
        const later = makeVisualization(2, 'tile-b');
        const earlier = makeVisualization(1, 'tile-a');
        (service as any).queueVisualization(viewState, later);
        (service as any).queueVisualization(viewState, earlier);

        expect(later.renderRank).not.toHaveBeenCalled();
        expect(earlier.renderRank).not.toHaveBeenCalled();

        expect((service as any).dequeueNextRenderableVisualization(0, viewState)).toBe(earlier);
        expect(later.renderRank).toHaveBeenCalledOnce();
        expect(earlier.renderRank).toHaveBeenCalledOnce();
        expect((service as any).dequeueNextRenderableVisualization(0, viewState)).toBe(later);
        expect(later.renderRank).toHaveBeenCalledOnce();
        expect(earlier.renderRank).toHaveBeenCalledOnce();
    });

    it('tracks visualization queue membership without scanning the full queue', () => {
        const {service} = createMapDataService();
        const viewState = ((service as any).viewVisualizationState as any[])[0];
        const visualization = {
            tile: {
                tileId: 1n,
                mapTileKey: 'tile-a',
            },
            styleId: 'style',
            renderRank: vi.fn().mockReturnValue(0),
        };

        (service as any).queueVisualization(viewState, visualization);
        (service as any).queueVisualization(viewState, visualization);

        expect(viewState.visualizationQueue.items).toHaveLength(1);
        expect(viewState.visualizationQueue.has(visualization)).toBe(true);

        expect((service as any).dequeueNextRenderableVisualization(0, viewState)).toBe(visualization);
        expect(viewState.visualizationQueue.items).toHaveLength(0);
        expect(viewState.visualizationQueue.has(visualization)).toBe(false);
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
                priorityTileIds: [42],
            },
        ]);

        selectionTileRequest.resolve!(null);
        await selectionTilePromise;
    });

    it('keeps search refresh stable while auto-update requests only incomplete visible tiles', () => {
        const {service} = createMapDataService();
        const searchRequest = {
            searchId: 'search-1',
            query: 'typeId == "Road"',
            scope: 'feature',
            autoUpdate: true,
            updateSerial: 0,
            generationSerial: 0,
            paused: false,
            showResultsOnMap: true,
            pinColor: '#ea4336',
            searchStyleRules: [],
            withFields: []
        };
        const visibleTiles = (tileIds: number[]) => new Map([
            [JSON.stringify(['m1', 'layerA']), {
                mapId: 'm1',
                layerId: 'layerA',
                tileIds: new Set(tileIds),
                priorityTileIds: new Set<number>()
            }]
        ]);

        service.setFeatureSearchRequests([searchRequest as any]);
        const first = (service as any).buildFeatureSearchTileRequests(visibleTiles([65537, 131073]));

        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            searchId: 'search-1',
            refresh: 1,
            tileIds: [65537, 131073]
        });

        (service as any).markFeatureSearchTileCompleted('search-1', 1, makeTileKey(65537));
        const second = (service as any).buildFeatureSearchTileRequests(visibleTiles([65537, 131073, 196609]));

        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({
            searchId: 'search-1',
            refresh: 1,
            tileIds: [131073, 196609]
        });
    });

    it('keeps non-auto search area frozen until the explicit update serial changes', () => {
        const {service} = createMapDataService();
        const evictedSourceTileKeys: string[] = [];
        const subscription = service.searchResultTileEvicted.subscribe(payload => {
            evictedSourceTileKeys.push(payload.sourceTileKey);
        });
        const baseSearchRequest = {
            searchId: 'search-1',
            query: 'typeId == "Road"',
            scope: 'feature',
            autoUpdate: false,
            updateSerial: 0,
            generationSerial: 0,
            paused: false,
            showResultsOnMap: true,
            pinColor: '#ea4336',
            searchStyleRules: [],
            withFields: []
        };
        const visibleTiles = (tileIds: number[]) => new Map([
            [JSON.stringify(['m1', 'layerA']), {
                mapId: 'm1',
                layerId: 'layerA',
                tileIds: new Set(tileIds),
                priorityTileIds: new Set<number>()
            }]
        ]);

        service.setFeatureSearchRequests([baseSearchRequest as any]);
        const first = (service as any).buildFeatureSearchTileRequests(visibleTiles([1]));
        expect(first[0].tileIds).toEqual([1]);

        (service as any).markFeatureSearchTileCompleted('search-1', 1, makeTileKey(1));
        const frozen = (service as any).buildFeatureSearchTileRequests(visibleTiles([2]));
        expect(frozen).toEqual([]);
        expect(evictedSourceTileKeys).toEqual([]);

        service.setFeatureSearchRequests([{
            ...baseSearchRequest,
            updateSerial: 1
        } as any]);
        const updated = (service as any).buildFeatureSearchTileRequests(visibleTiles([2]));

        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({
            refresh: 1,
            tileIds: [2]
        });
        expect(evictedSourceTileKeys).toEqual([makeTileKey(1)]);
        subscription.unsubscribe();
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

        const tileDataSpy = vi.spyOn(service.tileDataChanged, 'next');
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
        expect(tileDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            tileKey: tileMetadata.mapTileKey,
            reason: 'loaded'
        }));
        expect(legalSpy).toHaveBeenCalledWith(true);
        const legalSet = service.legalInformationPerMap.get('m1')!;
        expect(legalSet.has('LICENSE A')).toBe(true);
    });

    it('includes noDataSourceReason in tile request failure diagnostics when present', () => {
        const {service, infoService} = createMapDataService();

        (service as any).handleTilesRequestStatus({
            type: "mapget.tiles.status",
            allDone: true,
            requests: [
                {
                    index: 0,
                    mapId: "MapA",
                    layerId: "LayerA",
                    status: MapTileRequestStatus.NoDataSource,
                    statusText: "NoDataSource",
                    noDataSourceReason: "allSourcesDisabled"
                }
            ]
        });

        expect(infoService.showError).toHaveBeenCalledWith(
            "Tile request failed: MapA/LayerA: NoDataSource (allSourcesDisabled)"
        );
    });

    it('keeps tile request failure diagnostics compatible when noDataSourceReason is absent', () => {
        const {service, infoService} = createMapDataService();

        (service as any).handleTilesRequestStatus({
            type: "mapget.tiles.status",
            allDone: true,
            requests: [
                {
                    index: 0,
                    mapId: "MapA",
                    layerId: "LayerA",
                    status: MapTileRequestStatus.NoDataSource,
                    statusText: "NoDataSource"
                }
            ]
        });

        expect(infoService.showError).toHaveBeenCalledWith(
            "Tile request failed: MapA/LayerA: NoDataSource"
        );
    });
});
