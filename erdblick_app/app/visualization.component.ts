import {Cartesian3, Color, Viewer} from "cesium";
import {FeatureTile} from "./features.component";
import {TileFeatureLayer, MainModule as ErdblickCore, FeatureLayerStyle} from "../../build/libs/core/erdblick-core";

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    tiles: Array<FeatureTile>;
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

    /**
     * Create a tile visualization.
     * @param tiles {FeatureTile} The tile to visualize (first in the list), and additional ones
     *  which might be used to visualize external references.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     * @param highlight Controls whether the visualization will run rules that
     *  have `mode: highlight` set, otherwise, only rules with the default
     *  `mode: normal` are executed.
     */
    constructor(tiles: Array<FeatureTile>, style: FeatureLayerStyle, highDetail: boolean, highlight?: number) {
        console.assert(tiles.length > 0);

        this.tile = tiles[0];
        this.tiles = tiles;
        this.coreLib = tiles.at(0)!.coreLib;
        this.numFeatures = tiles.at(0)!.numFeatures;
        this.tileId = tiles.at(0)!.tileId;
        this.style = style;
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlight = highlight === undefined ? 0xffffffff : highlight;
        this.deleted = false;

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
        if (this.tiles.some(t => t.disposed) || this.style.isDeleted()) {
            return false;
        }

        // Create potential high-detail visualization
        this.renderingInProgress = true;
        let returnValue = true;
        if (this.isHighDetailAndNotEmpty()) {
            returnValue = await FeatureTile.peekMany(this.tiles, async (tileFeatureLayers: Array<TileFeatureLayer>) => {
                let visualization = new this.coreLib.FeatureLayerVisualization(
                    this.style,
                    this.highlight!);

                for (let tile of tileFeatureLayers)
                    visualization.addTileFeatureLayer(tile);

                visualization.run()

                let extRefs = visualization.externalReferences();
                if (extRefs && extRefs.length > 0) {
                    let extRefsResolved = await fetch("/locate", {body: extRefs});
                    if (this.tiles.some(tile => tile.disposed) || this.style.isDeleted()) {
                        // Do not continue if any of the tiles or the style
                        // were deleted while we were waiting.
                        return false;
                    }
                    visualization.processResolvedExternalReferences(extRefsResolved);
                }
                this.primitiveCollection = visualization.primitiveCollection();
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
        return this.isHighDetail && (this.numFeatures > 0 || this.tiles[0].preventCulling);
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
