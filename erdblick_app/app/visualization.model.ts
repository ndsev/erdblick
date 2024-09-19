import {FeatureTile} from "./features.model";
import {coreLib} from "./wasm";
import {
    Color,
    Entity,
    PrimitiveCollection,
    Rectangle,
    Viewer,
    CallbackProperty,
    HeightReference
} from "./cesium";
import {FeatureLayerStyle, TileFeatureLayer, HighlightMode} from "../../build/libs/core/erdblick-core";
import {MergedPointVisualization, PointMergeService} from "./pointmerge.service";

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

/**
 * Ensure that low-detail representations are only rendered once
 * per map tile layer. Otherwise, they are rendered once per
 * (style sheet, tile layer) combination.
 */
class TileBoxVisualization {
    static visualizations: Map<bigint, TileBoxVisualization> = new Map<bigint, TileBoxVisualization>();

    static get(tile: FeatureTile, featureCount: number, viewer: Viewer): TileBoxVisualization {
        if (!TileBoxVisualization.visualizations.has(tile.tileId)) {
            TileBoxVisualization.visualizations.set(
                tile.tileId, new TileBoxVisualization(viewer, tile));
        }
        let result = this.visualizations.get(tile.tileId)!;
        ++result.refCount;
        result.featureCount += featureCount;
        return result;
    }

    // Keep track of how many TileVisualizations are using this low-detail one.
    // We can delete this instance, as soon as refCount is 0.
    refCount: number = 0;
    featureCount: number = 0;
    private readonly entity: Entity;
    private readonly id: bigint;

    constructor(viewer: Viewer, tile: FeatureTile) {
        let tileBox = coreLib.getTileBox(BigInt(tile.tileId));
        this.entity = viewer.entities.add({
            rectangle: {
                coordinates: Rectangle.fromDegrees(...tileBox),
                height: HeightReference.CLAMP_TO_GROUND,
                material: Color.TRANSPARENT,
                outlineWidth: 2,
                outline: true,
                outlineColor: new CallbackProperty((time, result) => {
                    if (this.featureCount > 0) {
                        return Color.YELLOW.withAlpha(0.7);
                    } else {
                        return Color.AQUA.withAlpha(0.3);
                    }
                }, false)
            }
        });
        this.id = tile.tileId;
    }

    delete(viewer: Viewer, featureCount: number) {
        --this.refCount;
        this.featureCount -= featureCount;
        if (this.refCount <= 0) {
            viewer.entities.remove(this.entity);
            TileBoxVisualization.visualizations.delete(this.id);
        }
    }
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;
    showTileBorder: boolean = false;

    private readonly style: StyleWithIsDeleted;
    private lowDetailVisu: TileBoxVisualization|null = null;
    private primitiveCollection: PrimitiveCollection|null = null;
    private hasHighDetailVisualization: boolean = false;
    private hasTileBorder: boolean = false;
    private renderingInProgress: boolean = false;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private deleted: boolean = false;
    private readonly auxTileFun: (key: string)=>FeatureTile|null;
    private readonly options: Record<string, boolean>;
    private readonly pointMergeService: PointMergeService;

    /**
     * Create a tile visualization.
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
    constructor(
        tile: FeatureTile,
        pointMergeService: PointMergeService,
        auxTileFun: (key: string) => FeatureTile | null,
        style: FeatureLayerStyle,
        highDetail: boolean,
        highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
        featureIdSubset?: string[],
        boxGrid?: boolean,
        options?: Record<string, boolean>)
    {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlightMode = highlightMode;
        this.featureIdSubset = featureIdSubset || [];
        this.deleted = false;
        this.auxTileFun = auxTileFun;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.pointMergeService = pointMergeService;
    }

    /**
     * Actually create the visualization.
     * @param viewer {Viewer} The viewer to add the rendered entity to.
     * @return True if anything was rendered, false otherwise.
     */
    async render(viewer: Viewer) {
        if (this.renderingInProgress || this.deleted)
            return false;

        // Remove any previous render-result, as a new one is generated.
        this.destroy(viewer);
        this.deleted = false;

        // Do not try to render if the underlying data is disposed.
        if (this.tile.disposed || this.style.isDeleted()) {
            return false;
        }

        // Create potential high-detail visualization.
        this.renderingInProgress = true;
        let returnValue = true;
        if (this.isHighDetailAndNotEmpty()) {
            returnValue = await this.tile.peekAsync(async (tileFeatureLayer: TileFeatureLayer) => {
                let visualization = new coreLib.FeatureLayerVisualization(
                    this.tile.mapTileKey,
                    this.style,
                    this.options,
                    this.pointMergeService,
                    this.highlightMode,
                    this.featureIdSubset);
                visualization.addTileFeatureLayer(tileFeatureLayer);
                try {
                    visualization.run();
                }
                catch (e) {
                    console.error(`Exception while rendering: ${e}`);
                    return false;
                }

                // Try to resolve externally referenced auxiliary tiles.
                let extRefs = {requests: visualization.externalReferences()};
                if (extRefs.requests && extRefs.requests.length > 0) {
                    let response = await fetch("/locate", {
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
                    if (this.tile.disposed || this.style.isDeleted()) {
                        // Do not continue if any of the tiles or the style
                        // were deleted while we were waiting.
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
                            visualization.addTileFeatureLayer(auxTile);

                        try {
                            visualization.processResolvedExternalReferences(extRefsResolved.responses);
                        }
                        catch (e) {
                            console.error(`Exception while rendering: ${e}`);
                        }
                    });
                }

                this.primitiveCollection = visualization.primitiveCollection();
                for (const [mapLayerStyleRuleId, mergedPointVisualizations] of Object.entries(visualization.mergedPointFeatures())) {
                    for (let finishedCornerTile of this.pointMergeService.insert(mergedPointVisualizations as MergedPointVisualization[], this.tile.tileId, mapLayerStyleRuleId)) {
                        finishedCornerTile.render(viewer);
                    }
                }
                visualization.delete();
                return true;
            });
            if (this.primitiveCollection) {
                viewer.scene.primitives.add(this.primitiveCollection);
            }
            this.hasHighDetailVisualization = true;
        }

        if (this.showTileBorder) {
            // Else: Low-detail bounding box representation
            this.lowDetailVisu = TileBoxVisualization.get(this.tile, this.tile.numFeatures, viewer);
            this.hasTileBorder = true;
        }

        this.renderingInProgress = false;
        if (this.deleted)
            this.destroy(viewer);
        return returnValue;
    }

    /**
     * Destroy any current visualization.
     * @param viewer {Viewer} The viewer to remove the rendered entity from.
     */
    destroy(viewer: Viewer) {
        this.deleted = true;
        if (this.renderingInProgress) {
            return;
        }

        // Remove point-merge contributions that were made by this map-layer+style visualization combo.
        let removedCornerTiles = this.pointMergeService.remove(
            this.tile.tileId,
            this.mapLayerStyleId());
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
            this.lowDetailVisu.delete(viewer, this.tile.numFeatures);
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
        return this.isHighDetail && (this.tile.numFeatures > 0 || this.tile.preventCulling);
    }

    /**
     * Check if this visualization needs re-rendering, based on
     * whether the isHighDetail flag changed.
     */
    isDirty() {
        return (
            (this.isHighDetailAndNotEmpty() && !this.hasHighDetailVisualization) ||
            (!this.isHighDetailAndNotEmpty() && !this.hasTileBorder) ||
            (this.showTileBorder != this.hasTileBorder)
        );
    }

    /**
     * Combination of map name, layer name, style name and highlight mode which
     * (in combination with the tile id) uniquely identifies that rendered contents
     * if this TileVisualization as expected by the surrounding MergedPointsTiles.
     */
    private mapLayerStyleId() {
        return `${this.tile.mapName}:${this.tile.layerName}:${this.style.name()}:${this.highlightMode.value}`;
    }
}
