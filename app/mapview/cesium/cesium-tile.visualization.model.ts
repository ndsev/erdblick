import {FeatureTile} from "../../mapdata/features.model";
import {coreLib} from "../../integrations/wasm";
import {PrimitiveCollection, Viewer} from "../../integrations/cesium";
import {FeatureLayerStyle, HighlightMode, TileFeatureLayer} from "../../../build/libs/core/erdblick-core";
import {MapViewLayerStyleRule, MergedPointVisualization, PointMergeService} from "../pointmerge.service";
import {CesiumTileBoxVisualization} from "./cesium-tilebox.visualization.model";
import {IRenderSceneHandle, ITileVisualization} from "../render-view.model";

export interface LocateResolution {
    tileId: string,
    typeId: string,
    featureId: Array<string|number>
}

export interface LocateResponse {
    responses: Array<Array<LocateResolution>>
}

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
}

function asCesiumViewer(sceneHandle: IRenderSceneHandle): Viewer | undefined {
    if (sceneHandle.renderer !== "cesium") {
        console.warn(`CesiumTileVisualization expects a Cesium scene handle, got "${sceneHandle.renderer}".`);
        return undefined;
    }
    const viewer = sceneHandle.scene as Viewer;
    if (!viewer || !(viewer as any).scene) {
        console.warn("CesiumTileVisualization received an invalid Cesium scene handle.");
        return undefined;
    }
    return viewer;
}

function annotatePrimitiveTileKey(primitive: any, tileKey: string): void {
    if (!primitive || typeof primitive !== "object") {
        return;
    }
    try {
        primitive.tileKey = tileKey;
    } catch (_) {
        return;
    }
    if (typeof primitive.length !== "number" || typeof primitive.get !== "function") {
        return;
    }
    for (let i = 0; i < primitive.length; i++) {
        annotatePrimitiveTileKey(primitive.get(i), tileKey);
    }
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class CesiumTileVisualization implements ITileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;
    showTileBorder: boolean = false;
    readonly viewIndex: number;

    private lowDetailVisu: CesiumTileBoxVisualization|null = null;
    private primitiveCollection: PrimitiveCollection|null = null;
    private hasHighDetailVisualization: boolean = false;
    private hasTileBorder: boolean = false;
    private renderingInProgress: boolean = false;
    private deleted: boolean = false;
    private readonly style: StyleWithIsDeleted;
    public readonly styleId: string;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private readonly auxTileFun: (key: string)=>FeatureTile|null;
    private readonly options: Record<string, boolean|number|string>;
    private readonly pointMergeService: PointMergeService;
    private renderQueued: boolean = false;
    private styleOptionsVersion: number = 0;
    private renderedStyleOptionsVersion: number = 0;
    private renderedRelevantTileDataVersion: number = -1;

    /**
     * Create a tile visualization.
     * @param viewIndex Index of the MapView to which is CesiumTileVisualization is dedicated.
     * @param tile The tile to visualize.
     * @param pointMergeService Instance of the central PointMergeService, used to visualize merged point features.
     * @param auxTileFun Callback which may be called to resolve external references
     *  for relation visualization.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     * @param highlightMode Controls whether the visualization will run rules that
     *  have a specific highlight mode.
     * @param featureIdSubset Subset of feature IDs for visualization. If not set,
     *  all features in the tile will be visualized.
     * @param boxGrid Sets a flag to wrap this tile visualization into a bounding box
     * @param options Option values for option variables defined by the style sheet.
     */
    constructor(viewIndex: number,
                tile: FeatureTile,
                pointMergeService: PointMergeService,
                auxTileFun: (key: string) => FeatureTile | null,
                style: FeatureLayerStyle,
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                featureIdSubset?: string[],
                boxGrid?: boolean,
                options?: Record<string, boolean|number|string>) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.styleId = this.style.name();
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlightMode = highlightMode;
        this.featureIdSubset = featureIdSubset || [];
        this.deleted = false;
        this.auxTileFun = auxTileFun;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.pointMergeService = pointMergeService;
        this.viewIndex = viewIndex;
    }

    updateStatus(renderQueued?: boolean) {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
    }

    /**
     * Actually create the visualization.
     * @param sceneHandle Renderer scene handle.
     * @return True if anything was rendered, false otherwise.
     */
    async render(sceneHandle: IRenderSceneHandle) {
        const viewer = asCesiumViewer(sceneHandle);
        if (!viewer) {
            return false;
        }
        if (this.renderingInProgress || this.deleted)
            return false;

        const renderStyleOptionsVersion = this.styleOptionsVersion;

        // Remove any previous render-result, as a new one is generated.
        this.destroy(sceneHandle);
        this.deleted = false;

        // Do not continue if the style was deleted while we were waiting.
        if (this.style.isDeleted()) {
            this.updateStatus(false);
            return false;
        }

        // Create potential high-detail visualization.
        this.renderingInProgress = true;
        let returnValue = true;
        if (this.isHighDetailAndNotEmpty()) {
            returnValue = await this.tile.peekAsync(async (tileFeatureLayer: TileFeatureLayer) => {
                this.setTileVertexCount(Number(tileFeatureLayer.numVertices()));
                const VisualizationCtor = (coreLib as any).CesiumFeatureLayerVisualization;
                let wasmVisualization = new VisualizationCtor(
                    this.viewIndex,
                    this.tile.mapTileKey,
                    this.style,
                    this.options,
                    this.pointMergeService,
                    this.highlightMode,
                    this.featureIdSubset);

                let startTime = performance.now();
                wasmVisualization.addTileFeatureLayer(tileFeatureLayer);
                try {
                    wasmVisualization.run();
                }
                catch (e) {
                    console.error(`Exception while rendering: ${e}`);
                    return false;
                }

                // Try to resolve externally referenced auxiliary tiles.
                let extRefs = {requests: wasmVisualization.externalReferences()};
                if (extRefs.requests && extRefs.requests.length > 0) {
                    let response = await fetch("locate", {
                        body: JSON.stringify(extRefs, (_, value) =>
                            typeof value === 'bigint'
                                ? Number(value)
                                : value),
                        method: "POST"
                    }).catch((err)=>console.error(`Error during /locate call: ${err}`));
                    if (!response) {
                        return false;
                    }

                    let extRefsResolved = await response.json() as LocateResponse;
                    if (this.style.isDeleted()) {
                        // Do not continue if the style was deleted while we were waiting.
                        return false;
                    }

                    // Resolve located external tile IDs to actual tiles.
                    let seenTileIds = new Set<string>();
                    let auxTiles = new Array<FeatureTile>();
                    for (let resolutions of extRefsResolved.responses) {
                        for (let resolution of resolutions) {
                            if (!seenTileIds.has(resolution.tileId)) {
                                let tile = this.auxTileFun(resolution.tileId);
                                if (tile) {
                                    auxTiles.push(tile);
                                }
                                seenTileIds.add(resolution.tileId);
                            }
                        }
                    }

                    // Now we can actually parse the auxiliary layers,
                    // add them to the visualization, and let it process them.
                    await FeatureTile.peekMany(auxTiles, async (tileFeatureLayers: Array<TileFeatureLayer>) => {
                        for (let auxTile of tileFeatureLayers)
                            wasmVisualization.addTileFeatureLayer(auxTile);

                        try {
                            wasmVisualization.processResolvedExternalReferences(extRefsResolved.responses);
                        }
                        catch (e) {
                            console.error(`Exception while rendering: ${e}`);
                        }
                    });
                }

                if (!this.deleted) {
                    this.primitiveCollection = wasmVisualization.primitiveCollection();
                    annotatePrimitiveTileKey(this.primitiveCollection, this.tile.mapTileKey);
                    for (const [mapLayerStyleRuleId, mergedPointVisualizations] of Object.entries(wasmVisualization.mergedPointFeatures())) {
                        for (let finishedCornerTile of this.pointMergeService.insert(
                            mergedPointVisualizations as MergedPointVisualization[],
                            this.tile.tileId,
                            this.tile.mapTileKey,
                            mapLayerStyleRuleId)) {
                            finishedCornerTile.render(viewer);
                        }
                    }
                }
                wasmVisualization.delete();
                let endTime = performance.now();

                // Add the render time for this style sheet as a statistic to the tile.
                let timingListKey = `Rendering/${["Basic", "Hover", "Selection"][this.highlightMode.value]}/${this.styleId}#ms`;
                let timingList = this.tile.stats.get(timingListKey);
                if (!timingList) {
                    timingList = [];
                    this.tile.stats.set(timingListKey, timingList);
                }
                timingList.push(endTime - startTime);
                return true;
            });
            if (this.primitiveCollection) {
                viewer.scene.primitives.add(this.primitiveCollection);
            }
            this.hasHighDetailVisualization = true;
        }

        // Low-detail bounding box and load-state overlays.
        this.lowDetailVisu = CesiumTileBoxVisualization.get(
            this.viewIndex,
            this.tile,
            this.tile.numFeatures,
            viewer,
            this,
            this.showTileBorder);
        this.hasTileBorder = this.showTileBorder;

        this.renderedStyleOptionsVersion = renderStyleOptionsVersion;
        this.renderedRelevantTileDataVersion = this.relevantTileDataVersion();
        this.renderingInProgress = false;
        this.updateStatus(false);
        if (this.deleted)
            this.destroy(sceneHandle);
        return returnValue;
    }

    /**
     * Destroy any current visualization.
     * @param sceneHandle Renderer scene handle.
     */
    destroy(sceneHandle: IRenderSceneHandle) {
        this.deleted = true;
        if (this.renderingInProgress) {
            return;
        }
        const viewer = asCesiumViewer(sceneHandle);
        if (!viewer) {
            return;
        }

        // Remove point-merge contributions that were made by this map-layer+style visualization combo.
        let removedCornerTiles = this.pointMergeService.remove(
            this.tile.tileId,
            this.mapViewLayerStyleId());
        for (let removedCornerTile of removedCornerTiles) {
            removedCornerTile.remove(viewer);
        }

        if (this.primitiveCollection) {
            viewer.scene.primitives.remove(this.primitiveCollection);
            if (!this.primitiveCollection.isDestroyed())
                this.primitiveCollection.destroy();
            this.primitiveCollection = null;
        }
        if (this.lowDetailVisu) {
            this.lowDetailVisu.delete(this.viewIndex, viewer, this.tile.numFeatures, this);
            this.lowDetailVisu = null;
        }
        this.hasHighDetailVisualization = false;
        this.hasTileBorder = false;
    }

    /**
     * Check if the visualization is high-detail, and the
     * underlying data is not empty.
     */
    private isHighDetailAndNotEmpty() {
        return this.isHighDetail && this.tile.hasData() && this.tile.numFeatures > 0;
    }

    /**
     * Check if this visualization needs re-rendering, based on
     * whether the isHighDetail flag changed.
     */
    isDirty() {
        return (
            this.styleOptionsVersion !== this.renderedStyleOptionsVersion ||
            this.renderedRelevantTileDataVersion !== this.relevantTileDataVersion() ||
            this.isHighDetailAndNotEmpty() != this.hasHighDetailVisualization ||
            this.showTileBorder != this.hasTileBorder ||
            !this.lowDetailVisu
        );
    }

    /**
     * Combination of map name, layer name, style name and highlight mode which
     * (in combination with the tile id) uniquely identifies the rendered contents
     * of this CesiumTileVisualization as expected by the surrounding MergedPointsTiles.
     */
    private mapViewLayerStyleId(): MapViewLayerStyleRule {
        return this.pointMergeService.makeMapViewLayerStyleId(this.viewIndex, this.tile.mapName, this.tile.layerName, this.styleId, this.highlightMode);
    }

    public setStyleOption(optionId: string, value: string|number|boolean): boolean {
        if (this.options[optionId] === value) {
            return false;
        }
        this.options[optionId] = value;
        this.styleOptionsVersion++;
        return true;
    }

    private minimumStage(): number {
        const styleWithMinimumStage = this.style as FeatureLayerStyle & { minimumStage?: () => number };
        if (typeof styleWithMinimumStage.minimumStage !== "function") {
            return 0;
        }
        const rawValue = styleWithMinimumStage.minimumStage();
        if (!Number.isFinite(rawValue)) {
            return 0;
        }
        return Math.max(0, Math.floor(rawValue));
    }

    private relevantTileDataVersion(): number {
        const tileWithStageVersion = this.tile as FeatureTile & { dataVersionUpToStage?: (maxStage: number) => number };
        if (typeof tileWithStageVersion.dataVersionUpToStage !== "function") {
            return this.tile.dataVersion;
        }
        return tileWithStageVersion.dataVersionUpToStage(this.minimumStage());
    }

    private setTileVertexCount(count: number): void {
        this.tile.setVertexCount(Math.max(0, Math.floor(Number(count))));
    }
}
