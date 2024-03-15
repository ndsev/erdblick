import {Cartesian3, Color, Viewer, LabelCollection} from "cesium";
import {FeatureTile} from "./features.component";
import {TileFeatureLayer, MainModule as ErdblickCore, FeatureLayerStyle} from "../../build/libs/core/erdblick-core";

interface LocateResolution {
    tileId: string,
}

interface LocateResponse {
    responses: Array<Array<LocateResolution>>
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;

    private readonly coreLib: ErdblickCore;
    private readonly style: any;
    private entity: any;
    private primitiveCollection: any;
    private hasHighDetailVisualization: boolean;
    private hasLowDetailVisualization: boolean;
    private readonly numFeatures: number;
    private readonly tileId: bigint;
    private renderingInProgress: boolean;
    private readonly highlight?: number;
    private deleted: boolean;
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
        this.coreLib = tile.coreLib;
        this.numFeatures = tile.numFeatures;
        this.tileId = tile.tileId;
        this.style = style;
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlight = highlight === undefined ? 0xffffffff : highlight;
        this.deleted = false;
        this.auxTileFun = auxTileFun;

        this.entity = null;  // Low-detail or empty -> Cesium point entity.
        this.primitiveCollection = null; // High-detail -> PrimitiveCollection.

        this.hasHighDetailVisualization = false; // Currently holding hd?
        this.hasLowDetailVisualization = false; // Currently holding ld?
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
                let visualization = new this.coreLib.FeatureLayerVisualization(
                    this.style,
                    this.highlight!);
                visualization.addTileFeatureLayer(tileFeatureLayer);
                visualization.run();

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
                        visualization.processResolvedExternalReferences(extRefsResolved.responses);
                    });
                }
                this.primitiveCollection = visualization.primitiveCollection();
                visualization.delete();
                return true;
            });
            if (this.primitiveCollection)
                viewer.scene.primitives.add(this.primitiveCollection);
            this.hasHighDetailVisualization = true;
        } else {
            // Else: Low-detail dot representation
            let position = this.coreLib.getTilePosition(BigInt(this.tileId));
            let color = (this.numFeatures <= 0) ? Color.ALICEBLUE.withAlpha(.5) : Color.LAWNGREEN.withAlpha(.5);
            this.entity = viewer.entities.add({
                position: Cartesian3.fromDegrees(position.x, position.y),
                point: {
                    pixelSize: 5,
                    color: color
                }
            });
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
        if (this.entity) {
            viewer.entities.remove(this.entity);
            this.entity = null;
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
        return this.isHighDetail && (this.numFeatures > 0 || this.tile.preventCulling);
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
