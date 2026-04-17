import {Injectable} from "@angular/core";
import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {IconLayer, ScatterplotLayer, TextLayer} from "@deck.gl/layers";
import {coreLib} from "../integrations/wasm";
import {HighlightMode} from "../../build/libs/core/erdblick-core";
import {SceneMode} from "../integrations/geo";
import {IRenderSceneHandle} from "./render-view.model";
import {DeckLayerRegistry} from "./deck/deck-layer-registry";
import {Matrix4} from "@math.gl/core";

export type MapViewLayerStyleRule = string;
type PositionHash = string;
type Cartographic = {x: number, y: number, z: number};

type DeckColor = [number, number, number, number];
type DeckPosition = [number, number, number];
type DeckScene = {layerRegistry?: DeckLayerRegistry, sceneMode?: SceneMode};
const DECK_NO_DEPTH_TEST_PARAMETERS = {
    depthTest: false
} as any;
const DECK_FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);

interface DeckMergedPoint {
    featureAddresses: number[];
    featureTileKeys: string[];
    position: DeckPosition;
    color: DeckColor;
    outlineColor: DeckColor;
    outlineWidth: number;
    pixelSize: number;
    billboard: boolean;
    depthTest: boolean;
}

interface DeckMergedIcon {
    featureAddresses: number[];
    featureTileKeys: string[];
    position: DeckPosition;
    image: string;
    width: number;
    height: number;
    color: DeckColor;
    billboard: boolean;
    depthTest: boolean;
}

interface DeckMergedLabel {
    featureAddresses: number[];
    featureTileKeys: string[];
    position: DeckPosition;
    text: string;
    color: DeckColor;
    outlineColor: DeckColor;
    outlineWidth: number;
    scale: number;
    pixelOffset: [number, number];
    billboard: boolean;
    depthTest: boolean;
}

/**
 * Class which represents a set of merged point features for one location.
 * Each merged point feature may be visualized as a label or a point.
 * To this end, the visualization retains style parameters consumed by deck layers.
 */
export interface MergedPointVisualization {
    position: Cartographic,
    positionHash: PositionHash,
    pointParameters: any,
    labelParameters: any,
    featureAddresses: Array<number>,
    featureTileKeys?: Array<string>
}

/**
 * Container of MergedPointVisualizations, sitting at the corner point of
 * four surrounding tiles. It covers a quarter of the area of each surrounding
 * tile. Note: A MergedPointsTile is always unique for its NW corner tile ID
 *  and its View-Map-Layer-Style-Rule ID combination.
 */
export class MergedPointsTile {
    referencingTiles: Array<bigint> = [];

    features: Map<PositionHash, MergedPointVisualization> = new Map<PositionHash, MergedPointVisualization>;
    readonly viewIndex: number
    private readonly deckPointLayerKeys = new Set<string>();
    private readonly deckIconLayerKeys = new Set<string>();
    private readonly deckLabelLayerKeys = new Set<string>();

    constructor(
        public readonly tileId: bigint,  // NW tile ID
        public readonly mapViewLayerStyleRuleId: MapViewLayerStyleRule)
    {
        this.viewIndex = Number(mapViewLayerStyleRuleId.split(":")[0]);
    }

    add(point: MergedPointVisualization, sourceTileKey: string) {
        const normalizedFeatureAddresses = point.featureAddresses
            .filter((featureAddress): featureAddress is number =>
                Number.isInteger(featureAddress) && featureAddress >= 0);
        const normalizedFeatureTileKeys = normalizedFeatureAddresses.map((_, i) => {
            const featureTileKey = point.featureTileKeys?.[i];
            return typeof featureTileKey === "string" ? featureTileKey : sourceTileKey;
        });

        let existingPoint = this.features.get(point.positionHash);
        if (!existingPoint) {
            this.features.set(point.positionHash, {
                ...point,
                featureAddresses: normalizedFeatureAddresses,
                featureTileKeys: normalizedFeatureTileKeys,
            });
        }
        else {
            let anyNewFeatureAddressAdded = false;
            if (!Array.isArray(existingPoint.featureTileKeys)) {
                existingPoint.featureTileKeys = existingPoint.featureAddresses.map(() => sourceTileKey);
            }
            for (let i = 0; i < normalizedFeatureAddresses.length; i++) {
                const featureAddress = normalizedFeatureAddresses[i];
                const featureTileKey = normalizedFeatureTileKeys[i];
                if (existingPoint.featureAddresses.findIndex((v, idx) =>
                    v === featureAddress && existingPoint.featureTileKeys?.[idx] === featureTileKey) == -1) {
                    existingPoint.featureAddresses.push(featureAddress);
                    existingPoint.featureTileKeys!.push(featureTileKey);
                    anyNewFeatureAddressAdded = true;
                }
            }
            if (anyNewFeatureAddressAdded) {
                if (point.pointParameters) {
                    existingPoint.pointParameters = point.pointParameters;
                }
                if (point.labelParameters) {
                    existingPoint.labelParameters = point.labelParameters;
                }
            }
        }
    }

    count(positionHash: PositionHash, excludedSourceTileKey?: string) {
        const feature = this.features.get(positionHash);
        if (!feature) {
            return 0;
        }
        if (!excludedSourceTileKey) {
            return feature.featureAddresses.length;
        }
        const featureTileKeys = feature.featureTileKeys ?? [];
        if (!featureTileKeys.length) {
            return feature.featureAddresses.length;
        }
        let count = 0;
        for (let index = 0; index < feature.featureAddresses.length; index++) {
            if (featureTileKeys[index] !== excludedSourceTileKey) {
                count += 1;
            }
        }
        return count;
    }

    renderScene(sceneHandle: IRenderSceneHandle) {
        this.renderDeck(sceneHandle.scene as DeckScene);
    }

    removeScene(sceneHandle: IRenderSceneHandle) {
        this.removeDeck(sceneHandle.scene as DeckScene);
    }

    /**
     * Add a neighboring tile which keeps this corner tile alive
     */
    addReference(sourceTileId: bigint) {
        if (this.referencingTiles.findIndex(v => v == sourceTileId) == -1) {
            this.referencingTiles.push(sourceTileId);
        }
    }

    removeSource(sourceTileKey: string) {
        for (const [positionHash, feature] of this.features.entries()) {
            const featureTileKeys = feature.featureTileKeys ?? [];
            if (!featureTileKeys.length) {
                continue;
            }

            const remainingFeatureAddresses: number[] = [];
            const remainingFeatureTileKeys: string[] = [];
            for (let index = 0; index < feature.featureAddresses.length; index++) {
                if (featureTileKeys[index] === sourceTileKey) {
                    continue;
                }
                remainingFeatureAddresses.push(feature.featureAddresses[index]);
                remainingFeatureTileKeys.push(featureTileKeys[index]);
            }

            if (!remainingFeatureAddresses.length) {
                this.features.delete(positionHash);
                continue;
            }

            feature.featureAddresses = remainingFeatureAddresses;
            feature.featureTileKeys = remainingFeatureTileKeys;
        }
    }

    private renderDeck(scene: DeckScene) {
        const registry = scene.layerRegistry;
        if (!registry) {
            return;
        }
        const modelMatrix = scene.sceneMode === SceneMode.SCENE2D ? DECK_FLAT_2D_MODEL_MATRIX : undefined;

        this.removeDeck(scene);

        const pointsByBucket = new Map<string, {billboard: boolean, depthTest: boolean, data: DeckMergedPoint[]}>();
        const iconsByBucket = new Map<string, {billboard: boolean, depthTest: boolean, data: DeckMergedIcon[]}>();
        const labelsByBucket = new Map<string, {billboard: boolean, depthTest: boolean, data: DeckMergedLabel[]}>();
        const bucketKey = (billboard: boolean, depthTest: boolean) => `${billboard ? 1 : 0}:${depthTest ? 1 : 0}`;

        for (const feature of this.features.values()) {
            const featureAddresses = feature.featureAddresses;
            const featureTileKeys = feature.featureTileKeys ?? [];
            const defaultPosition: DeckPosition = [
                feature.position.x,
                feature.position.y,
                feature.position.z
            ];

            if (feature.pointParameters) {
                const params = feature.pointParameters;
                const position = defaultPosition;
                const color = this.toDeckColor(params.color, [255, 255, 255, 255]);

                if (typeof params.image === "string" && params.image.length > 0) {
                    const width = Number(params.width ?? params.pixelSize ?? 12);
                    const height = Number(params.height ?? params.pixelSize ?? 12);
                    const billboard = params.billboard !== false;
                    const depthTest = params.depthTest !== false;
                    const key = bucketKey(billboard, depthTest);
                    const bucket = iconsByBucket.get(key) ?? {billboard, depthTest, data: []};
                    bucket.data.push({
                        featureAddresses,
                        featureTileKeys,
                        position,
                        image: params.image,
                        width: Number.isFinite(width) && width > 0 ? width : 12,
                        height: Number.isFinite(height) && height > 0 ? height : 12,
                        color,
                        billboard,
                        depthTest
                    });
                    iconsByBucket.set(key, bucket);
                } else {
                    const pixelSize = Number(params.pixelSize ?? 6);
                    const outlineWidth = Number(params.outlineWidth ?? 0);
                    const billboard = params.billboard === true;
                    const depthTest = params.depthTest !== false;
                    const key = bucketKey(billboard, depthTest);
                    const bucket = pointsByBucket.get(key) ?? {billboard, depthTest, data: []};
                    bucket.data.push({
                        featureAddresses,
                        featureTileKeys,
                        position,
                        color,
                        outlineColor: this.toDeckColor(params.outlineColor, [0, 0, 0, 0]),
                        outlineWidth: Number.isFinite(outlineWidth) && outlineWidth > 0 ? outlineWidth : 0,
                        pixelSize: Number.isFinite(pixelSize) && pixelSize > 0 ? pixelSize : 6,
                        billboard,
                        depthTest
                    });
                    pointsByBucket.set(key, bucket);
                }
            }

            if (feature.labelParameters) {
                const params = feature.labelParameters;
                const text = typeof params.text === "string" ? params.text : "";
                if (!text.length) {
                    continue;
                }
                const position = defaultPosition;
                const offset = Array.isArray(params.pixelOffset) ? params.pixelOffset : [0, 0];
                const scale = Number(params.scale ?? 1);
                const outlineWidth = Number(params.outlineWidth ?? 0);
                const billboard = params.billboard !== false;
                const depthTest = params.depthTest !== false;
                const key = bucketKey(billboard, depthTest);
                const bucket = labelsByBucket.get(key) ?? {billboard, depthTest, data: []};
                bucket.data.push({
                    featureAddresses,
                    featureTileKeys,
                    position,
                    text,
                    color: this.toDeckColor(params.fillColor, [255, 255, 255, 255]),
                    outlineColor: this.toDeckColor(params.outlineColor, [0, 0, 0, 255]),
                    outlineWidth: Number.isFinite(outlineWidth) && outlineWidth > 0 ? outlineWidth : 0,
                    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
                    pixelOffset: [
                        Number(offset[0] ?? 0),
                        Number(offset[1] ?? 0)
                    ],
                    billboard,
                    depthTest
                });
                labelsByBucket.set(key, bucket);
            }
        }

        for (const {billboard, depthTest, data: points} of pointsByBucket.values()) {
            if (!points.length) {
                continue;
            }
            const layerKey = this.makeDeckLayerKey(
                `merged-point-${billboard ? "billboard" : "world"}-${depthTest ? "depth" : "overlay"}`
            );
            this.deckPointLayerKeys.add(layerKey);
            registry.upsert(layerKey, new ScatterplotLayer({
                id: layerKey,
                data: points,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (d: DeckMergedPoint) => d.position,
                getRadius: (d: DeckMergedPoint) => d.pixelSize,
                radiusUnits: "pixels",
                getFillColor: (d: DeckMergedPoint) => d.color,
                getLineColor: (d: DeckMergedPoint) => d.outlineColor,
                getLineWidth: (d: DeckMergedPoint) => d.outlineWidth,
                lineWidthUnits: "pixels",
                billboard,
                modelMatrix,
                parameters: depthTest ? undefined : DECK_NO_DEPTH_TEST_PARAMETERS,
                stroked: true,
                filled: true,
                pickable: true,
                getId: (d: DeckMergedPoint) => d.featureAddresses
            } as any) as any, 500);
        }

        for (const {billboard, depthTest, data: icons} of iconsByBucket.values()) {
            if (!icons.length) {
                continue;
            }
            const layerKey = this.makeDeckLayerKey(
                `merged-icon-${billboard ? "billboard" : "world"}-${depthTest ? "depth" : "overlay"}`
            );
            this.deckIconLayerKeys.add(layerKey);
            registry.upsert(layerKey, new IconLayer({
                id: layerKey,
                data: icons,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (d: DeckMergedIcon) => d.position,
                getColor: (d: DeckMergedIcon) => d.color,
                getSize: (d: DeckMergedIcon) => Math.max(d.width, d.height),
                sizeUnits: "pixels",
                getIcon: (d: DeckMergedIcon) => ({
                    url: d.image,
                    width: d.width,
                    height: d.height,
                    anchorX: d.width / 2,
                    anchorY: d.height / 2
                }),
                billboard,
                modelMatrix,
                parameters: depthTest ? undefined : DECK_NO_DEPTH_TEST_PARAMETERS,
                pickable: true,
                getId: (d: DeckMergedIcon) => d.featureAddresses
            } as any) as any, 510);
        }

        for (const {billboard, depthTest, data: labels} of labelsByBucket.values()) {
            if (!labels.length) {
                continue;
            }
            const layerKey = this.makeDeckLayerKey(
                `merged-label-${billboard ? "billboard" : "world"}-${depthTest ? "depth" : "overlay"}`
            );
            this.deckLabelLayerKeys.add(layerKey);
            registry.upsert(layerKey, new TextLayer({
                id: layerKey,
                data: labels,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (d: DeckMergedLabel) => d.position,
                getText: (d: DeckMergedLabel) => d.text,
                getColor: (d: DeckMergedLabel) => d.color,
                getOutlineColor: (d: DeckMergedLabel) => d.outlineColor,
                getOutlineWidth: (d: DeckMergedLabel) => d.outlineWidth,
                getSize: (d: DeckMergedLabel) => 14 * d.scale,
                sizeUnits: "pixels",
                getPixelOffset: (d: DeckMergedLabel) => d.pixelOffset,
                billboard,
                modelMatrix,
                parameters: depthTest ? undefined : DECK_NO_DEPTH_TEST_PARAMETERS,
                pickable: true,
                getId: (d: DeckMergedLabel) => d.featureAddresses
            } as any) as any, 520);
        }
    }

    private removeDeck(scene: DeckScene) {
        const registry = scene.layerRegistry;
        if (!registry) {
            return;
        }
        for (const layerKey of this.deckPointLayerKeys) {
            registry.remove(layerKey);
        }
        this.deckPointLayerKeys.clear();
        for (const layerKey of this.deckIconLayerKeys) {
            registry.remove(layerKey);
        }
        this.deckIconLayerKeys.clear();
        for (const layerKey of this.deckLabelLayerKeys) {
            registry.remove(layerKey);
        }
        this.deckLabelLayerKeys.clear();
    }

    private makeDeckLayerKey(kind: string): string {
        return `merged/${this.mapViewLayerStyleRuleId}/${this.tileId.toString()}/${kind}`;
    }

    private toDeckColor(input: any, fallback: DeckColor): DeckColor {
        if (Array.isArray(input) && input.length >= 4) {
            return [
                Number(input[0]),
                Number(input[1]),
                Number(input[2]),
                Number(input[3])
            ];
        }
        return fallback;
    }
}

/**
 * Service which manages the CRUD cycle of MergedPointsTiles.
 */
@Injectable({providedIn: 'root'})
export class PointMergeService
{
    mergedPointsTiles: Map<MapViewLayerStyleRule, Map<bigint, MergedPointsTile>> = new Map<MapViewLayerStyleRule, Map<bigint, MergedPointsTile>>();

    /**
     * Build a snapshot of merge counts for the corner tiles touched by sourceTileId.
     * Keys are encoded as `${mapViewLayerStyleRuleId}|${positionHash}`.
     */
    makeMergeCountSnapshot(
        sourceTileId: bigint,
        mapViewLayerStyleId: string,
        excludedSourceTileKey?: string
    ): Record<string, number> {
        const result: Record<string, number> = {};
        const cornerTileIds = [
            sourceTileId,
            coreLib.getTileNeighbor(sourceTileId, -1, 0),
            coreLib.getTileNeighbor(sourceTileId, 0, -1),
            coreLib.getTileNeighbor(sourceTileId, -1, -1),
        ];

        for (const [mapViewLayerStyleRuleId, tiles] of this.mergedPointsTiles.entries()) {
            if (!mapViewLayerStyleRuleId.startsWith(mapViewLayerStyleId)) {
                continue;
            }
            for (const cornerTileId of cornerTileIds) {
                const cornerTile = tiles.get(cornerTileId);
                if (!cornerTile) {
                    continue;
                }
                for (const [positionHash] of cornerTile.features.entries()) {
                    result[`${mapViewLayerStyleRuleId}|${positionHash}`] =
                        cornerTile.count(positionHash, excludedSourceTileKey);
                }
            }
        }

        return result;
    }

    /**
     * Count how many points have been merged for the given position and style rule so far.
     */
    count(
        geoPos: Cartographic,
        hashPos: PositionHash,
        level: number,
        mapViewLayerStyleRuleId: MapViewLayerStyleRule,
        excludedSourceTileKey?: string
    ): number {
        return this.getCornerTileByPosition(geoPos, level, mapViewLayerStyleRuleId).count(
            hashPos,
            excludedSourceTileKey
        );
    }

    /**
     * Get or create a MergedPointsTile for a particular cartographic location.
     * Calculates the tile ID of the given location. If the position
     * is north if the tile center, the tile IDs y component is decremented (unless it is already 0).
     * If the position is west of the tile center, the tile IDs x component is decremented (unless it is already 0).
     */
    getCornerTileByPosition(geoPos: Cartographic, level: number, mapViewLayerStyleRuleId: MapViewLayerStyleRule): MergedPointsTile {
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
        return this.getCornerTileById(tileId, mapViewLayerStyleRuleId);
    }

    /**
     * Get (or create) a corner tile by its style-rule-id + tile-id combo.
     */
    getCornerTileById(tileId: bigint, mapViewLayerStyleRuleId: MapViewLayerStyleRule): MergedPointsTile {
        // Get or create the tile-map for the mapViewLayerStyleRuleId.
        let styleRuleMap = this.mergedPointsTiles.get(mapViewLayerStyleRuleId);
        if (!styleRuleMap) {
            styleRuleMap = new Map<bigint, MergedPointsTile>();
            this.mergedPointsTiles.set(mapViewLayerStyleRuleId, styleRuleMap);
        }

        // Get or create the entry for the tile in the map.
        let result = styleRuleMap.get(tileId);
        if (!result) {
            result = new MergedPointsTile(tileId, mapViewLayerStyleRuleId);
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
    *insert(points: Array<MergedPointVisualization>, sourceTileId: bigint, sourceTileKey: string, mapViewLayerStyleRuleId: MapViewLayerStyleRule): Generator<MergedPointsTile> {
        // Insert the points into the relevant corner tiles.
        let level = coreLib.getTileLevel(sourceTileId);
        for (let point of points) {
            let mergedPointsTile = this.getCornerTileByPosition(point.position, level, mapViewLayerStyleRuleId);
            mergedPointsTile.add(point, sourceTileKey);
        }

        // Add the sourceTileId as a reference to the affected corner tile IDs.
        let cornerTileIds = [
            sourceTileId,
            coreLib.getTileNeighbor(sourceTileId, -1, 0),
            coreLib.getTileNeighbor(sourceTileId, 0, -1),
            coreLib.getTileNeighbor(sourceTileId, -1, -1),
        ];
        for (let cornerTileId of cornerTileIds) {
            let cornerTile = this.getCornerTileById(cornerTileId, mapViewLayerStyleRuleId);
            cornerTile.addReference(sourceTileId);
            yield cornerTile;
        }
    }

    /**
     * Remove a source tile contribution from each surrounding corner tile whose mapViewLayerStyleRuleId has a
     * prefix-match with the mapViewLayerStyleId. Yields all touched corner tiles so callers can refresh their scene
     * representation. Tiles whose references become empty are removed from the service map.
     */
    *remove(sourceTileId: bigint, sourceTileKey: string, mapViewLayerStyleId: string): Generator<MergedPointsTile> {
        for (let [mapViewLayerStyleRuleId, tiles] of this.mergedPointsTiles.entries()) {
            if (mapViewLayerStyleRuleId.startsWith(mapViewLayerStyleId)) {
                for (let [tileId, tile] of tiles) {
                    const hadReference = tile.referencingTiles.includes(sourceTileId);
                    if (!hadReference) {
                        continue;
                    }
                    tile.removeSource(sourceTileKey);
                    tile.referencingTiles = tile.referencingTiles.filter(val => val != sourceTileId);
                    yield tile;
                    if (!tile.referencingTiles.length) {
                        tiles.delete(tileId);
                    }
                }
            }
        }
    }

    /**
     * Clear all merged points for a particular mapViewLayerStyle prefix.
     * Yields MergedPointsTiles which should be removed from the active
     * renderer scene.
     */
    *clear(mapViewLayerStyleId: string): Generator<MergedPointsTile> {
        for (let [mapViewLayerStyleRuleId, tiles] of this.mergedPointsTiles.entries()) {
            if (mapViewLayerStyleRuleId.startsWith(mapViewLayerStyleId)) {
                yield* tiles.values();
                this.mergedPointsTiles.delete(mapViewLayerStyleRuleId);
            }
        }
    }

    makeMapViewLayerStyleId(viewIndex: number, mapId: string, layerId: string, styleId: string, highlightMode: HighlightMode): MapViewLayerStyleRule {
        return `${viewIndex}:${mapId}:${layerId}:${styleId}:${highlightMode.value}`;
    }
}
