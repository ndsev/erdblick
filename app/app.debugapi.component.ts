import {coreLib, uint8ArrayFromWasm, ErdblickCore_} from "./integrations/wasm";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {SceneMode, CesiumMath} from "./integrations/cesium";

type DebugHighlightMode = "none" | "hover" | "selection";
type DebugRenderer = "deck" | "cesium";

/**
 * Extend Window interface to allow custom ErdblickDebugApi property
 */
export interface DebugWindow extends Window {
    ebDebug: ErdblickDebugApi;
}

/**
 * Debugging utility class designed for usage with the browser's debug console.
 *
 * Extends the actual application with debugging/dev functionality without
 * contaminating the application's primary codebase or an addition of a dedicated
 * GUI.
 */
export class ErdblickDebugApi {
    /**
     * Initialize a new ErdblickDebugApi instance.
     */
    constructor(private mapService: MapDataService,
                private stateService: AppStateService) {
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    setCamera(viewIndex: number, cameraInfoStr: string) {
        if (viewIndex >= this.stateService.numViews) {
            console.error(`Expected viewIndex < ${this.stateService.numViews}, got ${viewIndex}!`);
            return;
        }
        if (!cameraInfoStr) {
            console.error(`Expected cameraInfoStr, got empty or undefined!`);
            return;
        }
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.stateService.setView(viewIndex,
            cameraInfo.position,
            {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        );
    }

    /**
     * Retrieve the current camera position and orientation.
     *
     * @return A JSON-formatted string containing the current camera's position and orientation.
     */
    getCamera(viewIndex: number) {
        if (viewIndex >= this.stateService.numViews) {
            console.error(`Expected viewIndex < ${this.stateService.numViews}, got ${viewIndex}!`);
            return;
        }
        const destination = this.stateService.getCameraPosition(viewIndex);
        const position = [
            destination.longitude,
            destination.latitude,
            destination.height,
        ];
        const orientation = this.stateService.getCameraOrientation(viewIndex);
        return JSON.stringify({position, orientation});
    }

    /**
     * Generate a test TileFeatureLayer, and show it.
     */
    showTestTile() {
        let tile = uint8ArrayFromWasm((sharedArr: any) => {
            coreLib.generateTestTile(sharedArr, this.mapService.tileLayerParser);
        });
        let style = coreLib.generateTestStyle();
        this.mapService.addTileFeatureLayer(tile, {
            id: "_builtin",
            shortId: "TEST",
            modified: false,
            imported: false,
            source: "",
            featureLayerStyle: style,
            options: [],
            visible: true,
            url: ""
        }, true);
    }

    /**
     * Check for memory leaks.
     */
    coreLib(): ErdblickCore_ {
        return coreLib;
    }

    /** Run some simfil query to reproduce problems with search. */
    runSimfilQuery(query: string = "**.transition") {
        for (const [_, tile] of this.mapService.loadedTileLayers) {
            tile.peek(parsedTile => {
                let search = new coreLib.FeatureLayerSearch(parsedTile);
                const matchingFeatures = search.filter(query);
                search.delete();
            })
        }
    }

    mapTileKey(mapId: string, layerId: string, tileId: string | number | bigint): string {
        const numericTileId = typeof tileId === "bigint" ? tileId : BigInt(tileId);
        return coreLib.getTileFeatureLayerKey(mapId, layerId, numericTileId) as string;
    }

    async ensureTileLoaded(mapTileKey: string) {
        const existing = this.mapService.loadedTileLayers.get(mapTileKey);
        if (existing?.hasData()) {
            return existing;
        }
        const loaded = await this.mapService.loadTiles(new Set([mapTileKey]));
        return loaded.get(mapTileKey) ?? null;
    }

    featureInspectionHoverSummary(
        mapTileKey: string,
        featureId: string,
        keyFilter: string = "") {
        const tile = this.mapService.loadedTileLayers.get(mapTileKey);
        if (!tile?.hasData()) {
            return {error: `Tile ${mapTileKey} is not loaded.`};
        }
        return tile.peek((parsedTile) => {
            const feature = parsedTile.find(featureId);
            if (!feature || feature.isNull()) {
                feature?.delete();
                return {error: `Feature ${featureId} was not found in ${mapTileKey}.`};
            }

            const root = feature.inspectionModel();
            const hits: any[] = [];
            const walk = (node: any, path: string[]) => {
                if (!node || typeof node !== "object") {
                    return;
                }
                const nodeKey = String(node.key ?? "");
                const nextPath = [...path, nodeKey];
                const hasHoverId = typeof node.hoverId === "string";
                const keyMatches = !keyFilter.length || nodeKey.includes(keyFilter);
                if (hasHoverId && keyMatches) {
                    const validityNode = Array.isArray(node.children)
                        ? node.children.find((child: any) => child && child.key === "validity")
                        : null;
                    const validitySummary = Array.isArray(validityNode?.children)
                        ? validityNode.children.map((validity: any) => {
                            const simpleGeometry = Array.isArray(validity.children)
                                ? validity.children.find((child: any) => child && child.key === "simpleGeometry")
                                : null;
                            return {
                                simpleGeometryType: simpleGeometry?.value ?? null,
                                simpleGeometryPointCount: Array.isArray(simpleGeometry?.children)
                                    ? simpleGeometry.children.length
                                    : 0
                            };
                        })
                        : [];
                    hits.push({
                        key: node.key,
                        value: node.value,
                        hoverId: node.hoverId,
                        path: nextPath.join(" > "),
                        validitySummary
                    });
                }
                if (Array.isArray(node.children)) {
                    for (const child of node.children) {
                        walk(child, nextPath);
                    }
                }
            };

            if (Array.isArray(root)) {
                for (const node of root) {
                    walk(node, []);
                }
            }

            feature.delete();
            return {
                mapTileKey,
                featureId,
                hitCount: hits.length,
                hits
            };
        });
    }

    probeHighlightRendering(
        mapTileKey: string,
        styleId: string,
        featureIdSubset: string[],
        renderer: DebugRenderer = "deck",
        mode: DebugHighlightMode = "hover") {
        const tile = this.mapService.loadedTileLayers.get(mapTileKey);
        if (!tile?.hasData()) {
            return {error: `Tile ${mapTileKey} is not loaded.`};
        }
        const styleService = (this.mapService as any).styleService;
        const style = styleService?.styles?.get(styleId);
        if (!style) {
            return {error: `Style ${styleId} is not loaded.`};
        }

        const modeValue = mode === "selection"
            ? coreLib.HighlightMode.SELECTION_HIGHLIGHT
            : mode === "none"
                ? coreLib.HighlightMode.NO_HIGHLIGHT
                : coreLib.HighlightMode.HOVER_HIGHLIGHT;

        const styleOptions = (this.mapService as any).maps.getLayerStyleOptions(
            0,
            tile.mapName,
            tile.layerName,
            styleId
        ) ?? {};

        const readSharedBytes = (sharedArray: any) => {
            const ptr = sharedArray.getPointer();
            const size = sharedArray.getSize();
            const bytes = coreLib.HEAPU8.slice(ptr, ptr + size);
            sharedArray.delete();
            return bytes;
        };

        return tile.peek((parsedTile) => {
            if (renderer === "deck") {
                const deckVis = new coreLib.DeckFeatureLayerVisualization(
                    0,
                    mapTileKey,
                    style.featureLayerStyle,
                    styleOptions,
                    {count: () => 0},
                    modeValue,
                    featureIdSubset);
                deckVis.addTileFeatureLayer(parsedTile);
                deckVis.run();

                const startsShared = new coreLib.SharedUint8Array();
                deckVis.pathStartIndicesRaw(startsShared);
                const startsBytes = readSharedBytes(startsShared);
                const startIndices = new Uint32Array(
                    startsBytes.buffer,
                    startsBytes.byteOffset,
                    Math.floor(startsBytes.byteLength / 4));

                const featureIdsShared = new coreLib.SharedUint8Array();
                deckVis.pathFeatureIdsRaw(featureIdsShared);
                const featureIdsBytes = readSharedBytes(featureIdsShared);
                const featureIds = new Uint32Array(
                    featureIdsBytes.buffer,
                    featureIdsBytes.byteOffset,
                    Math.floor(featureIdsBytes.byteLength / 4));

                deckVis.delete();
                return {
                    renderer: "deck",
                    mode,
                    styleId,
                    subset: [...featureIdSubset],
                    pathCount: Math.max(0, startIndices.length - 1),
                    startIndices: Array.from(startIndices.slice(0, 20)),
                    featureIds: Array.from(featureIds.slice(0, 20))
                };
            }

            const cesiumVis = new coreLib.CesiumFeatureLayerVisualization(
                0,
                mapTileKey,
                style.featureLayerStyle,
                styleOptions,
                {count: () => 0},
                modeValue,
                featureIdSubset);
            cesiumVis.addTileFeatureLayer(parsedTile);
            cesiumVis.run();
            const primitiveCollection = cesiumVis.primitiveCollection();
            const primitiveKinds = Array.isArray(primitiveCollection?._primitives)
                ? primitiveCollection._primitives.map((primitive: any) => primitive?.constructor?.name ?? typeof primitive)
                : [];
            const primitivePropertyHints = Array.isArray(primitiveCollection?._primitives)
                ? primitiveCollection._primitives.map((primitive: any) => Object.keys(primitive ?? {}).slice(0, 12))
                : [];
            cesiumVis.delete();
            return {
                renderer: "cesium",
                mode,
                styleId,
                subset: [...featureIdSubset],
                primitiveCount: primitiveKinds.length,
                primitiveKinds,
                primitivePropertyHints
            };
        });
    }
}
