import {Injectable} from "@angular/core";
import {PointPrimitiveCollection, LabelCollection, Viewer} from "./cesium";
import {coreLib} from "./wasm";

type MapLayerStyleRule = string;
type PositionHash = string;
type Cartographic = {x: number, y: number, z: number};

/**
 * Class which represents a set of merged point features for one location.
 * Each merged point feature may be visualized as a label or a point.
 * To this end, the visualization retains visualization parameters for
 * calls to either/both Cesium PointPrimitiveCollection.add() and/or LabelCollection.add().
 */
interface MergedPointVisualization {
    position: Cartographic,
    positionHash: PositionHash,
    pointParameters?: Record<string, any>|null,  // Point Visualization Parameters for call to PointPrimitiveCollection.add().
    labelParameters?: Record<string, any>|null,  // Label Visualization Parameters for call to LabelCollection.add().
    featureIds: Array<string>
}

/**
 * Container of MergedPointVisualizations, sitting at the corner point of
 * four surrounding tiles. It covers a quarter of the area of each surrounding
 * tile. The actual visualization is performed, once all contributions have been gathered.
 * Note: A MergedPointsTile is always unique for its NW corner tile ID and its Map-Layer-Style-Rule ID.
 */
export class MergedPointsTile {
    quadId: string = ""  // NE-NW-SE-SW tile IDs
    mapLayerStyleRuleId: MapLayerStyleRule = "";

    missingTiles: Array<bigint> = [];
    referencingTiles: Array<bigint> = [];

    pointPrimitives: PointPrimitiveCollection|null = null;
    labelPrimitives: LabelCollection|null = null;

    features: Map<PositionHash, MergedPointVisualization> = new Map<PositionHash, MergedPointVisualization>;

    count(positionHash: PositionHash) {
        return this.features.has(positionHash) ? this.features.get(positionHash)!.featureIds.length : 0;
    }

    render(viewer: Viewer) {
        if (this.pointPrimitives) {
            console.error("MergedPointsTile.render() was called twice.");
        }

        this.pointPrimitives = new PointPrimitiveCollection();
        this.labelPrimitives = new LabelCollection();

        for (let [_, feature] of this.features) {
            if (feature.pointParameters) {
                this.pointPrimitives.add(feature.pointParameters);
                feature.pointParameters = null;
            }
            if (feature.labelParameters) {
                this.labelPrimitives.add(feature.labelParameters);
                feature.labelParameters = null;
            }
        }

        if (this.pointPrimitives.length) {
            viewer.scene.primitives.add(this.pointPrimitives)
        }
        if (this.labelPrimitives.length) {
            viewer.scene.primitives.add(this.labelPrimitives)
        }
    }

    remove(viewer: Viewer) {
        if (this.pointPrimitives && this.pointPrimitives.length) {
            viewer.scene.primitives.add(this.pointPrimitives)
        }
        if (this.labelPrimitives && this.labelPrimitives.length) {
            viewer.scene.primitives.add(this.labelPrimitives)
        }
    }
}

/**
 * Service which manages the CRUD cycle of MergedPointsTiles.
 */
@Injectable({providedIn: 'root'})
export class PointMergeService
{
    mergedPointsTiles: Map<MapLayerStyleRule, Map<number, MergedPointsTile>> = new Map<MapLayerStyleRule, Map<number, MergedPointsTile>>();

    /**
     * Check if the corner tile at geoPos is interested in contributions from `tileId`.
     * Returns true if respective corner has sourceTileId in is in missingTiles.
     */
    wants(geoPos: Cartographic, sourceTileId: bigint, mapLayerStyleRuleId: MapLayerStyleRule): boolean {
        return this.get(geoPos, coreLib.getTileLevel(sourceTileId), mapLayerStyleRuleId).missingTiles.findIndex(v => v == sourceTileId) != -1;
    }

    /**
     * Count how many points have been merged for the given position and style rule so far.
     */
    count(geoPos: Cartographic, hashPos: PositionHash, level: number, mapLayerStyleRuleId: MapLayerStyleRule): number {
        return this.get(geoPos, level, mapLayerStyleRuleId).count(hashPos);
    }

    /**
     * Get or create a MergedPointsTile for a particular cartographic location.
     * Calculates the tile ID of the given location. If the position
     * is north if the tile center, the tile IDs y component is decremented (unless it is already 0).
     * If the position is west of the tile center, the tile IDs x component is decremented (unless it is already 0).
     */
    get(geoPos: Cartographic, level: number, mapLayerStyleRuleId: string): MergedPointsTile {
        // TODO
    }

    /**
     * Insert (or update) a bunch of point visualizations. They will be dispatched into the
     * MergedPointsTiles surrounding sourceTileId. Afterward, the sourceTileId is removed from
     * the missingTiles of each. MergedPointsTiles with empty referencingTiles (requiring render)
     * are yielded. The sourceTileId is also added to the MergedPointsTiles referencingTiles set.
     */
    *insert(points: Array<MergedPointVisualization>, sourceTileId: number, mapLayerStyleRuleId: MapLayerStyleRule): Iterator<MergedPointsTile> {
        // TODO
    }

    /**
     * Remove a sourceTileId reference from each surrounding corner tile whose mapLayerStyleRuleId has a
     * prefix-match with the mapLayerStyleId. Yields MergedPointsTiles which now have empty referencingTiles,
     * and whose visualization (if existing) must therefore be removed from the scene.
     */
    *remove(sourceTileId: number, mapLayerStyleId: string): Iterator<MergedPointsTile> {
        // TODO
    }
}
