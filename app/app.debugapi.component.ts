import {coreLib, uint8ArrayFromWasm, ErdblickCore_} from "./integrations/wasm";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {SceneMode, CesiumMath, Viewer} from "./integrations/cesium";
import {MapView} from "./mapview/view";
import {TileVisualization} from "./mapview/tile.visualization.model";
import type {ErdblickStyle} from "./styledata/style.service";

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
    private views: Map<number, MapView> = new Map();
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
     * Register a MapView so it can be accessed from the debug API.
     */
    registerView(viewIndex: number, view: MapView) {
        this.views.set(viewIndex, view);
    }

    /**
     * Access the MapView instance for a given view index.
     */
    getView(viewIndex: number = 0): MapView | undefined {
        return this.views.get(viewIndex);
    }

    /**
     * Access the Cesium Viewer instance for a given view index.
     */
    getViewer(viewIndex: number = 0): Viewer | undefined {
        return this.views.get(viewIndex)?.viewer;
    }

    /**
     * Enumerate tile visualizations currently active for a view.
     */
    getTileVisualizations(viewIndex: number = 0, styleId?: string, tileKey?: string): TileVisualization[] {
        const state = (this.mapService as any).viewVisualizationState?.[viewIndex];
        if (!state || typeof state.getVisualizations !== "function") {
            return [];
        }
        return Array.from(state.getVisualizations(styleId, tileKey));
    }

    private resolveStyle(styleId: string): ErdblickStyle | undefined {
        if (!styleId) {
            return undefined;
        }
        const styles = this.mapService.styleService?.styles;
        if (!styles) {
            return undefined;
        }
        const direct = styles.get(styleId);
        if (direct) {
            return direct;
        }
        for (const style of styles.values()) {
            if (style.shortId === styleId) {
                return style;
            }
        }
        return undefined;
    }

    /**
     * Fetch a specific tile and render it immediately.
     */
    async renderTile(tileId: number | bigint | string,
                     mapId: string,
                     layerId: string,
                     styleId: string,
                     viewIndex: number = 0): Promise<TileVisualization | null> {
        if (viewIndex >= this.stateService.numViews) {
            console.error(`Expected viewIndex < ${this.stateService.numViews}, got ${viewIndex}!`);
            return null;
        }
        const view = this.getView(viewIndex);
        if (!view || !view.viewer) {
            console.error("No viewer available yet. Wait for the view to initialize.");
            return null;
        }
        const style = this.resolveStyle(styleId);
        if (!style) {
            console.error(`Unknown style '${styleId}'.`);
            return null;
        }
        if (!mapId || !layerId) {
            console.error("Expected mapId and layerId.");
            return null;
        }

        let tileIdBig: bigint;
        try {
            tileIdBig = typeof tileId === "bigint" ? tileId : BigInt(tileId);
        } catch (err) {
            console.error(`Invalid tileId '${tileId}': ${err}`);
            return null;
        }

        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileIdBig);
        const tiles = await this.mapService.loadTiles(new Set([tileKey]));
        const tile = tiles.get(tileKey);
        if (!tile) {
            console.error(`Failed to load tile ${tileKey}.`);
            return null;
        }

        const viewState = (this.mapService as any).viewVisualizationState?.[viewIndex];
        if (!viewState) {
            console.error(`Missing view visualization state for view ${viewIndex}.`);
            return null;
        }

        let visu: TileVisualization | undefined = viewState.getVisualization(style.id, tileKey);
        if (!visu) {
            const use3dTiles = this.stateService.visualizationBackend === "3dtiles";
            visu = new TileVisualization(
                viewIndex,
                tile,
                (this.mapService as any).pointMergeService,
                (key: string) => this.mapService.getFeatureTile(key),
                style.featureLayerStyle,
                tile.preventCulling || viewState.highDetailTileIds?.has(tile.tileId),
                coreLib.HighlightMode.NO_HIGHLIGHT,
                [],
                this.mapService.maps.getViewTileBorderState(viewIndex),
                this.mapService.maps.getLayerStyleOptions(viewIndex, mapId, layerId, style.id),
                use3dTiles
            );
            viewState.putVisualization(style.id, tileKey, visu);
        } else {
            visu.isHighDetail = tile.preventCulling || viewState.highDetailTileIds?.has(tile.tileId);
            visu.showTileBorder = this.mapService.maps.getViewTileBorderState(viewIndex);
        }

        const rendered = await visu.render(view.viewer);
        if (rendered && view.viewer?.scene) {
            view.viewer.scene.requestRender();
        }
        return visu;
    }

    /**
     * Access recent 3D tiles debug objects captured by the renderer.
     */
    get3DTilesDebug() {
        const g = globalThis as any;
        return {
            tileset: g.__ERDBLICK_DEBUG_3DTILES_TILESET__,
            debugModel: g.__ERDBLICK_DEBUG_3DTILES_DEBUG_MODEL__,
            attributeStats: g.__ERDBLICK_DEBUG_3DTILES_ATTRS__,
            viewer: g.__ERDBLICK_DEBUG_VIEWER__
        };
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
}
