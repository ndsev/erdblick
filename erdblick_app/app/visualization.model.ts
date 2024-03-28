import {FeatureTile} from "./features.model";
import {coreLib} from "./wasm";
import {Cartesian3, Color, Viewer, PrimitiveCollection, Entity} from "./cesium";
import {TileFeatureLayer, FeatureLayerStyle} from "../../build/libs/core/erdblick-core";

interface LocateResolution {
    tileId: string,
}

interface LocateResponse {
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
class LowDetailTileVisualization {
    static visualizations: Map<string, LowDetailTileVisualization> = new Map<string, LowDetailTileVisualization>();

    static get(tile: FeatureTile, viewer: Viewer): LowDetailTileVisualization {
        if (LowDetailTileVisualization.visualizations.has(tile.id)) {
            let result = this.visualizations.get(tile.id)!;
            ++result.refCount;
            return result;
        }

        return new LowDetailTileVisualization(viewer, tile);
    }

    // Keep track of how many TileVisualizations are using this low-detail one.
    // We can delete this instance, as soon as refCount is 0.
    refCount: number = 1;
    private readonly entity: Entity;
    private readonly id: string;

    constructor(viewer: Viewer, tile: FeatureTile) {
        let position = coreLib.getTilePosition(BigInt(tile.tileId));
        let color = tile.numFeatures <= 0 ? Color.ALICEBLUE.withAlpha(.5) : Color.LAWNGREEN.withAlpha(.5);
        this.entity = viewer.entities.add({
            position: Cartesian3.fromDegrees(position.x, position.y),
            point: {
                pixelSize: 5,
                color: color
            }
        });
        this.id = tile.id;
        LowDetailTileVisualization.visualizations.set(tile.id, this);
    }

    delete(viewer: Viewer) {
        --this.refCount;
        if (this.refCount <= 0) {
            viewer.entities.remove(this.entity);
            LowDetailTileVisualization.visualizations.delete(this.id);
        }
    }
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;

    private readonly style: StyleWithIsDeleted;
    private lowDetailVisu: LowDetailTileVisualization|null = null;
    private primitiveCollection: PrimitiveCollection|null = null;
    private hasHighDetailVisualization: boolean = false;
    private hasLowDetailVisualization: boolean = false;
    private renderingInProgress: boolean = false;
    private readonly highlight: number;
    private deleted: boolean = false;
    private readonly auxTileFun: (key: string)=>FeatureTile|null;

    /**
     * Create a tile visualization.
     * @param tile {FeatureTile} The tile to visualize.
     * @param auxTileFun Callback which may be called to resolve external references
     *  for relation visualization.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     * @param highlight Controls whether the visualization will run rules that
     *  have `mode: highlight` set, otherwise, only rules with the default
     *  `mode: normal` are executed.
     */
    constructor(tile: FeatureTile, auxTileFun: (key: string)=>FeatureTile|null, style: FeatureLayerStyle, highDetail: boolean, highlight?: number) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlight = highlight === undefined ? 0xffffffff : highlight;
        this.deleted = false;
        this.auxTileFun = auxTileFun;
    }

    /**
     * Actually create the visualization.
     * @param viewer {Cesium.Viewer} The viewer to add the rendered entity to.
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
                    this.style,
                    this.highlight!);
                visualization.addTileFeatureLayer(tileFeatureLayer);
                try {
                    visualization.run();
                }
                catch (e) {
                    console.log(`Exception while rendering: ${e}`);
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
                            console.log(`Exception while rendering: ${e}`);
                        }
                    });
                }
                this.primitiveCollection = visualization.primitiveCollection();
                visualization.delete();
                return true;
            });
            if (this.primitiveCollection) {
                viewer.scene.primitives.add(this.primitiveCollection);
            }
            this.hasHighDetailVisualization = true;
        } else {
            // Else: Low-detail dot representation
            this.lowDetailVisu = LowDetailTileVisualization.get(this.tile, viewer);
            this.hasLowDetailVisualization = true;
        }

        this.renderingInProgress = false;
        if (this.deleted)
            this.destroy(viewer);
        return returnValue;
    }

    /**
     * Destroy any current visualization.
     * @param viewer {Cesium.Viewer} The viewer to remove the rendered entity from.
     */
    destroy(viewer: Viewer) {
        this.deleted = true;
        if (this.renderingInProgress)
            return;

        if (this.primitiveCollection) {
            viewer.scene.primitives.remove(this.primitiveCollection);
            if (!this.primitiveCollection.isDestroyed())
                this.primitiveCollection.destroy();
            this.primitiveCollection = null;
        }
        if (this.lowDetailVisu) {
            this.lowDetailVisu.delete(viewer);
            this.lowDetailVisu = null;
        }
        this.hasHighDetailVisualization = false;
        this.hasLowDetailVisualization = false;
    }

    /**
     * Iterate over all Cesium primitives of this visualization.
     */
    forEachPrimitive(callback: any) {
        if (this.primitiveCollection)
            for (let i = 0; i < this.primitiveCollection.length; ++i)
                callback(this.primitiveCollection.get(i));
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
            (!this.isHighDetailAndNotEmpty() && !this.hasLowDetailVisualization)
        );
    }
}
