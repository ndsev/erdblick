import {Injectable} from "@angular/core";
import {
    PointPrimitiveCollection,
    LabelCollection,
    Viewer,
    Color,
    Cartesian2,
    Cartesian3,
    Rectangle,
    Entity,
    HeightReference
} from "./cesium";
import {coreLib} from "./wasm";
import {TileFeatureId} from "./parameters.service";

type MapLayerStyleRule = string;
type PositionHash = string;
type Cartographic = {x: number, y: number, z: number};

/**
 * Class which represents a set of merged point features for one location.
 * Each merged point feature may be visualized as a label or a point.
 * To this end, the visualization retains visualization parameters for
 * calls to either/both Cesium PointPrimitiveCollection.add() and/or LabelCollection.add().
 */
export interface MergedPointVisualization {
    position: Cartographic,
    positionHash: PositionHash,
    pointParameters?: Record<string, any>|null,  // Point Visualization Parameters for call to PointPrimitiveCollection.add().
    labelParameters?: Record<string, any>|null,  // Label Visualization Parameters for call to LabelCollection.add().
    featureIds: Array<TileFeatureId>
}

/**
 * Container of MergedPointVisualizations, sitting at the corner point of
 * four surrounding tiles. It covers a quarter of the area of each surrounding
 * tile. Note: A MergedPointsTile is always unique for its NW corner tile ID
 *  and its Map-Layer-Style-Rule ID.
 */
export class MergedPointsTile {
    tileId: bigint = 0n;  // NW tile ID
    mapLayerStyleRuleId: MapLayerStyleRule = "";

    referencingTiles: Array<bigint> = [];

    pointPrimitives: PointPrimitiveCollection|null = null;
    labelPrimitives: LabelCollection|null = null;
    debugEntity: Entity|null = null;

    features: Map<PositionHash, MergedPointVisualization> = new Map<PositionHash, MergedPointVisualization>;

    add(point: MergedPointVisualization) {
        let existingPoint = this.features.get(point.positionHash);
        if (!existingPoint) {
            this.features.set(point.positionHash, point);
        }
        else {
            for (let fid of point.featureIds) {
                if (existingPoint.featureIds.findIndex(v => v.featureId == fid.featureId) == -1) {
                    existingPoint.featureIds.push(fid);
                }
            }
            if (point.pointParameters !== undefined) {
                existingPoint.pointParameters = point.pointParameters;
            }
            if (point.labelParameters !== undefined) {
                existingPoint.labelParameters = point.labelParameters;
            }
        }
    }

    count(positionHash: PositionHash) {
        return this.features.has(positionHash) ? this.features.get(positionHash)!.featureIds.length : 0;
    }

    render(viewer: Viewer) {
        if (this.pointPrimitives || this.labelPrimitives) {
            this.remove(viewer);
        }

        this.pointPrimitives = new PointPrimitiveCollection();
        this.labelPrimitives = new LabelCollection();

        for (let [_, feature] of this.features) {
            if (feature.pointParameters) {
                feature.pointParameters["id"] = feature.featureIds;
                this.pointPrimitives.add(feature.pointParameters);
            }
            if (feature.labelParameters) {
                feature.labelParameters["id"] = feature.featureIds;
                this.labelPrimitives.add(feature.labelParameters);
            }
        }

        if (this.pointPrimitives.length) {
            viewer.scene.primitives.add(this.pointPrimitives)
        }
        if (this.labelPrimitives.length) {
            viewer.scene.primitives.add(this.labelPrimitives)
        }

        // On-demand debug visualization:
        // Adding debug bounding box and label for tile ID and feature count
        // const tileBounds = coreLib.getCornerTileBox(this.tileId);
        // this.debugEntity = viewer.entities.add({
        //     rectangle: {
        //         coordinates: Rectangle.fromDegrees(...tileBounds),
        //         material: Color.BLUE.withAlpha(0.2),
        //         outline: true,
        //         outlineColor: Color.BLUE,
        //         outlineWidth: 3,
        //         height: HeightReference.CLAMP_TO_GROUND,
        //     },
        //     position: Cartesian3.fromDegrees(
        //         (tileBounds[0]+tileBounds[2])*.5,
        //         (tileBounds[1]+tileBounds[3])*.5
        //     ),
        //     label: {
        //         text: `Tile ID: ${this.tileId.toString()}\nPoints: ${this.features.size}\nreferencingTiles: ${this.referencingTiles}`,
        //         showBackground: true,
        //         font: '14pt monospace',
        //         eyeOffset: new Cartesian3(0, 0, -10), // Ensures label visibility at a higher altitude
        //         fillColor: Color.YELLOW,
        //         outlineColor: Color.BLACK,
        //         outlineWidth: 2,
        //     }
        // });
    }

    remove(viewer: Viewer) {
        if (this.pointPrimitives && this.pointPrimitives.length) {
            viewer.scene.primitives.remove(this.pointPrimitives)
        }
        if (this.labelPrimitives && this.labelPrimitives.length) {
            viewer.scene.primitives.remove(this.labelPrimitives)
        }
        if (this.debugEntity) {
            viewer.entities.remove(this.debugEntity);
        }
    }

    /**
     * Add a neighboring tile which keeps this corner tile alive
     */
    addReference(sourceTileId: bigint) {
        if (this.referencingTiles.findIndex(v => v == sourceTileId) == -1) {
            this.referencingTiles.push(sourceTileId);
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
     * Count how many points have been merged for the given position and style rule so far.
     */
    count(geoPos: Cartographic, hashPos: PositionHash, level: number, mapLayerStyleRuleId: MapLayerStyleRule): number {
        return this.getCornerTileByPosition(geoPos, level, mapLayerStyleRuleId).count(hashPos);
    }

    /**
     * Get or create a MergedPointsTile for a particular cartographic location.
     * Calculates the tile ID of the given location. If the position
     * is north if the tile center, the tile IDs y component is decremented (unless it is already 0).
     * If the position is west of the tile center, the tile IDs x component is decremented (unless it is already 0).
     */
    getCornerTileByPosition(geoPos: Cartographic, level: number, mapLayerStyleRuleId: MapLayerStyleRule): MergedPointsTile {
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
        return this.getCornerTileById(tileId, mapLayerStyleRuleId);
    }

    /**
     * Get (or create) a corner tile by its style-rule-id + tile-id combo.
     */
    getCornerTileById(tileId: bigint, mapLayerStyleRuleId: MapLayerStyleRule): MergedPointsTile {
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
    *insert(points: Array<MergedPointVisualization>, sourceTileId: bigint, mapLayerStyleRuleId: MapLayerStyleRule): Generator<MergedPointsTile> {
        // Insert the points into the relevant corner tiles.
        let level = coreLib.getTileLevel(sourceTileId);
        for (let point of points) {
            let mergedPointsTile = this.getCornerTileByPosition(point.position, level, mapLayerStyleRuleId);
            mergedPointsTile.add(point);
        }

        // Remove the sourceTileId from the corner tile IDs.
        let cornerTileIds = [
            sourceTileId,
            coreLib.getTileNeighbor(sourceTileId, -1, 0),
            coreLib.getTileNeighbor(sourceTileId, 0, -1),
            coreLib.getTileNeighbor(sourceTileId, -1, -1),
        ];
        for (let cornerTileId of cornerTileIds) {
            let cornerTile = this.getCornerTileById(cornerTileId, mapLayerStyleRuleId);
            cornerTile.addReference(sourceTileId);
            yield cornerTile;
        }
    }

    /**
     * Remove a sourceTileId reference from each surrounding corner tile whose mapLayerStyleRuleId has a
     * prefix-match with the mapLayerStyleId. Yields MergedPointsTiles which now have empty referencingTiles,
     * and whose visualization (if existing) must therefore be removed from the scene.
     */
    *remove(sourceTileId: bigint, mapLayerStyleId: string): Generator<MergedPointsTile> {
        for (let [mapLayerStyleRuleId, tiles] of this.mergedPointsTiles.entries()) {
            if (mapLayerStyleRuleId.startsWith(mapLayerStyleId)) {
                for (let [tileId, tile] of tiles) {
                    // Yield the corner tile as to-be-deleted, if it does not have any referencing tiles.
                    tile.referencingTiles = tile.referencingTiles.filter(val => val != sourceTileId);
                    if (!tile.referencingTiles.length) {
                        yield tile;
                        tiles.delete(tileId);
                    }
                }
            }
        }
    }
}
