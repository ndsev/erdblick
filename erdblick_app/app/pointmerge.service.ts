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
    tileId: bigint = 0n;  // NW tile ID
    mapLayerStyleRuleId: MapLayerStyleRule = "";

    missingTiles: Array<bigint> = [];
    referencingTiles: Array<bigint> = [];

    pointPrimitives: PointPrimitiveCollection|null = null;
    labelPrimitives: LabelCollection|null = null;

    features: Map<PositionHash, MergedPointVisualization> = new Map<PositionHash, MergedPointVisualization>;

    add(point: MergedPointVisualization) {
        let existingPoint = this.features.get(point.positionHash);
        if (!existingPoint) {
            this.features.set(point.positionHash, point);
        }
        else {
            for (let fid in point.featureIds) {
                existingPoint.featureIds.push(fid);
            }
            existingPoint.pointParameters = point.pointParameters;
            existingPoint.labelParameters = point.labelParameters;
        }
    }

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
    mergedPointsTiles: Map<MapLayerStyleRule, Map<bigint, MergedPointsTile>> = new Map<MapLayerStyleRule, Map<bigint, MergedPointsTile>>();

    /**
     * Check if the corner tile at geoPos is interested in contributions from `tileId`.
     * Returns true if respective corner has sourceTileId in its in missingTiles.
     * __Note: This is called from WASM.__
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
    get(geoPos: Cartographic, level: number, mapLayerStyleRuleId: MapLayerStyleRule): MergedPointsTile {
        // Calculate the correct corner tile ID.
        let tileId = coreLib.getTileIdFromPosition(geoPos.x, geoPos.y, level);
        let tilePos = coreLib.getTilePosition(tileId);
        let offsetX = 0;
        let offsetY = 0;
        if (geoPos.x < tilePos.x)
            offsetX = -1;
        if (geoPos.y > tilePos.y)
            offsetY = -1;
        tileId = coreLib.getTileNeighbor(tileId, offsetX, offsetY);

        // Get or create the tile-map for the mapLayerStyleRuleId.
        let styleRuleMap = this.mergedPointsTiles.get(mapLayerStyleRuleId);
        if (!styleRuleMap) {
            styleRuleMap = new Map<bigint, MergedPointsTile>();
            this.mergedPointsTiles.set(mapLayerStyleRuleId, styleRuleMap);
        }

        // Get or create the entry for the tile in the map.
        let result = styleRuleMap.get(tileId);
        if (!result) {
            result = new MergedPointsTile();
            result.tileId = tileId;
            result.mapLayerStyleRuleId = mapLayerStyleRuleId;
            result.missingTiles = [
                tileId,
                coreLib.getTileNeighbor(tileId, 1, 0),
                coreLib.getTileNeighbor(tileId, 0, 1),
                coreLib.getTileNeighbor(tileId, 1, 1),
            ]
            styleRuleMap.set(tileId, result);
        }
        return result;
    }

    /**
     * Insert (or update) a bunch of point visualizations. They will be dispatched into the
     * MergedPointsTiles surrounding sourceTileId. Afterward, the sourceTileId is removed from
     * the missingTiles of each. MergedPointsTiles with empty referencingTiles (requiring render)
     * are yielded. The sourceTileId is also added to the MergedPointsTiles referencingTiles set.
     */
    *insert(points: Array<MergedPointVisualization>, sourceTileId: bigint, mapLayerStyleRuleId: MapLayerStyleRule): Iterator<MergedPointsTile> {
        // Insert the points into the relevant corner tiles.
        let level = coreLib.getTileLevel(sourceTileId);
        for (let point of points) {
            let mergedPointsTile = this.get(point.position, level, mapLayerStyleRuleId);
            mergedPointsTile.add(point);
        }

        // Remove the sourceTileId from the corner tile IDs.
        let cornerTileIds = [
            sourceTileId,
            coreLib.getTileNeighbor(sourceTileId, -1, 0),
            coreLib.getTileNeighbor(sourceTileId, 0, -1),
            coreLib.getTileNeighbor(sourceTileId, -1, -1),
        ];
        let styleRuleMap = this.mergedPointsTiles.get(mapLayerStyleRuleId)!;
        for (let cornerTileId of cornerTileIds) {
            let cornerTile = styleRuleMap.get(cornerTileId);
            if (cornerTile) {
                let newMissingTiles = cornerTile.missingTiles.filter(val => val != sourceTileId);

                // Add the source tile ID to the referencing tiles,
                // if it was removed from the missing tiles. This can only happen once.
                // This way, we are prepared for the idea that a style sheet might
                // re-insert some data.
                if (newMissingTiles.length != cornerTile.missingTiles.length) {
                    cornerTile.referencingTiles.push(sourceTileId);
                    cornerTile.missingTiles = newMissingTiles;
                }

                // Yield the corner tile as to-be-rendered, if it does not have any missing tiles.
                if (!cornerTile.missingTiles.length) {
                    yield cornerTile;
                }
            }
        }
    }

    /**
     * Remove a sourceTileId reference from each surrounding corner tile whose mapLayerStyleRuleId has a
     * prefix-match with the mapLayerStyleId. Yields MergedPointsTiles which now have empty referencingTiles,
     * and whose visualization (if existing) must therefore be removed from the scene.
     */
    *remove(sourceTileId: bigint, mapLayerStyleId: string): Iterator<MergedPointsTile> {
        for (let [mapLayerStyleRuleId, tiles] of this.mergedPointsTiles.entries()) {
            if (mapLayerStyleRuleId.startsWith(mapLayerStyleId)) {
                for (let [tileId, tile] of tiles) {
                    // Yield the corner tile as to-be-rendered, if it does not have any referencing tiles.
                    tile.referencingTiles = tile.referencingTiles.filter(val => val == sourceTileId);
                    if (!tile.referencingTiles.length) {
                        yield tile;
                        tiles.delete(tileId);
                    }
                }
            }
        }
    }
}
