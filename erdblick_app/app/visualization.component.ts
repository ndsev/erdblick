import {Cartesian3, Color, Viewer} from "cesium";
import {FeatureTile} from "./features.component";
import {TileFeatureLayer} from "../../build/libs/core/erdblick-core";

/** Bundle of a FeatureTile and a rendered */
export class TileVisualization {
    tile: FeatureTile;
    private style: any;
    private isHighDetail: boolean;
    private entity: any;
    private primitiveCollection: any;
    private hasHighDetailVisualization: boolean;
    private hasLowDetailVisualization: boolean;

    /**
     * Create a tile visualization.
     * @param tile {FeatureTile} The tile to visualize.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     */
    constructor(tile: FeatureTile, style: any, highDetail: any) {
        this.tile = tile;
        this.style = style;
        this.isHighDetail = highDetail;

        this.entity = null;  // Low-detail or empty -> Cesium point entity.
        this.primitiveCollection = null; // High-detail -> PrimitiveCollection.

        this.hasHighDetailVisualization = false; // Currently holding hd?
        this.hasLowDetailVisualization = false; // Currently holding ld?
    }

    /**
     * Actually create the visualization.
     * @param viewer {Cesium.Viewer} The viewer to add the rendered entity to.
     */
    render(viewer: Viewer) {
        // Remove any previous render-result, as a new one is generated.
        this.destroy(viewer);

        // Do not try to render if the underlying data is disposed.
        if (this.tile.disposed || this.style.isDeleted()) {
            return false;
        }

        // Create potential high-detail visualization
        if (this.isHighDetailAndNotEmpty()) {
            this.tile.peek((tileFeatureLayer: TileFeatureLayer) => {
                let visualization = new this.tile.coreLib.FeatureLayerVisualization(this.style, tileFeatureLayer);
                this.primitiveCollection = visualization.primitiveCollection();
            });
            if (this.primitiveCollection)
                viewer.scene.primitives.add(this.primitiveCollection);
            this.hasHighDetailVisualization = true;
        } else {
            // Else: Low-detail dot representation
            let position = this.tile.coreLib.getTilePosition(this.tile.tileId);
            let color = (this.tile.numFeatures <= 0) ? Color.ALICEBLUE.withAlpha(.5) : Color.LAWNGREEN.withAlpha(.5);
            this.entity = viewer.entities.add({
                position: Cartesian3.fromDegrees(position.x, position.y),
                point: {
                    pixelSize: 5,
                    color: color
                }
            });
            this.hasLowDetailVisualization = true;
        }
        return true;
    }

    /**
     * Destroy any current visualization.
     * @param viewer {Cesium.Viewer} The viewer to remove the rendered entity from.
     */
    destroy(viewer: Viewer) {
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
        return this.isHighDetail && (this.tile.numFeatures > 0 || this.tile.preventCulling);
    }

    /**
     * Check if this visualization needs re-rendering, based on
     * whether the isHighDetail flag changed.
     */
    private isDirty() {
        return (
            (this.isHighDetailAndNotEmpty() && !this.hasHighDetailVisualization) ||
            (!this.isHighDetailAndNotEmpty() && !this.hasLowDetailVisualization)
        );
    }
}
