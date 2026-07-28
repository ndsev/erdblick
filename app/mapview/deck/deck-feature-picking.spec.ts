import "@angular/compiler";
import {WebMercatorViewport} from "@deck.gl/core";
import {addMetersToLngLat} from "@math.gl/web-mercator";
import {describe, expect, it, vi} from "vitest";

import type {TileFeatureId} from "../../shared/appstate.service";
import {DeckMapView2D} from "./deck-view2d";

function createView() {
    const resolveTileFeatureIdByAddress = vi.fn((mapTileKey: string, address: number): TileFeatureId => ({
        mapTileKey,
        featureId: `feature-${address}`
    }));
    const view = new DeckMapView2D(
        0,
        "canvas",
        {} as never,
        {} as never,
        {resolveTileFeatureIdByAddress} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    );
    return {view, resolveTileFeatureIdByAddress};
}

describe("Deck rendered-feature picking", () => {
    it("uses one configured-radius deep query, excludes untagged layers, and continues after an unresolved hit", () => {
        const {view} = createView();
        const unselectableLayer = {
            id: "base-unselectable",
            props: {
                drillPickEligible: true,
                tileKey: "map-a/tile",
                featureAddresses: [0xffffffff]
            }
        };
        const selectableLayer = {
            id: "base-selectable",
            props: {
                drillPickEligible: true,
                tileKey: "map-b/tile",
                featureAddresses: [7]
            }
        };
        const highlightLayer = {
            id: "selection-highlight",
            props: {pickable: true, drillPickEligible: false}
        };
        const searchLayer = {
            id: "search-results",
            props: {pickable: true}
        };
        const pickMultipleObjects = vi.fn(() => [
            {layer: unselectableLayer, index: 0},
            {layer: selectableLayer, index: 0}
        ]);
        (view as any).deck = {
            props: {layers: [unselectableLayer, selectableLayer, highlightLayer, searchLayer]},
            pickMultipleObjects
        };

        const result = view.drillPickFeatures({x: 12, y: 24}, 3, 5);

        expect(pickMultipleObjects).toHaveBeenCalledOnce();
        expect(pickMultipleObjects).toHaveBeenCalledWith({
            x: 12,
            y: 24,
            radius: 3,
            depth: 5,
            layerIds: ["base-unselectable", "base-selectable"],
            unproject3D: false
        });
        expect(result).toEqual({
            featureIds: [{mapTileKey: "map-b/tile", featureId: "feature-7"}]
        });
    });

    it("flattens merged objects and deduplicates by the full tile-feature identity", () => {
        const {view} = createView();
        const mergedLayer = {
            id: "merged-base",
            props: {drillPickEligible: true}
        };
        const pickMultipleObjects = vi.fn(() => [
            {
                layer: mergedLayer,
                object: {
                    featureAddresses: [4, 4, 4],
                    featureTileKeys: ["map-a/tile", "map-a/tile", "map-b/tile"]
                }
            },
            {
                layer: mergedLayer,
                object: {
                    featureAddresses: [4],
                    featureTileKeys: ["map-b/tile"]
                }
            }
        ]);
        (view as any).deck = {
            props: {layers: [mergedLayer]},
            pickMultipleObjects
        };

        expect(view.drillPickFeatures({x: 0, y: 0}, 1, 2).featureIds).toEqual([
            {mapTileKey: "map-a/tile", featureId: "feature-4"},
            {mapTileKey: "map-b/tile", featureId: "feature-4"}
        ]);
    });

    it("snaps a thick picked path ribbon to its base XYZ centerline", () => {
        const {view} = createView();
        const origin: [number, number, number] = [11, 48, 100];
        const positions = new Float32Array([
            0, 0, 0,
            100, 0, 0
        ]);
        const pathLayer = {
            id: "base-path",
            props: {
                navigationAnchorEligible: true,
                tileKey: "map/tile",
                featureAddressesByPath: [12],
                pathCenterline: {
                    positions,
                    startIndices: new Uint32Array([0, 2]),
                    coordinateOrigin: origin
                }
            }
        };
        const viewport = new WebMercatorViewport({
            width: 1000,
            height: 700,
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 55,
            bearing: 30
        });
        const ribbonCoordinate = addMetersToLngLat(origin, [50, 8, 0]);
        const pickMultipleObjects = vi.fn(() => [{
            layer: pathLayer,
            index: 0,
            coordinate: ribbonCoordinate,
            viewport
        }]);
        (view as any).deck = {pickMultipleObjects};

        const target = view.pickNavigationTarget({x: 500, y: 350});
        const expected = addMetersToLngLat(origin, [50, 0, 0]);

        expect(target?.featureIds).toEqual([
            {mapTileKey: "map/tile", featureId: "feature-12"}
        ]);
        expect(target?.position[0]).toBeCloseTo(expected[0], 7);
        expect(target?.position[1]).toBeCloseTo(expected[1], 7);
        expect(target?.position[2]).toBeCloseTo(expected[2], 7);
    });

    it("skips a nonphysical label and anchors a marker to the feature point", () => {
        const {view} = createView();
        const targetFeature = {mapTileKey: "map/tile", featureId: "feature-12"};
        const labelLayer = {
            id: "base-label",
            props: {
                drillPickEligible: true,
                tileKey: targetFeature.mapTileKey,
                featureAddresses: [12]
            }
        };
        const origin: [number, number, number] = [11, 48, 100];
        const pointLayer = {
            id: "base-point",
            props: {
                drillPickEligible: true,
                markerAnchorEligible: true,
                tileKey: targetFeature.mapTileKey,
                featureAddresses: [12],
                coordinateOrigin: origin,
                anchorPositions: new Float32Array([10, 20, 30])
            }
        };
        const pickMultipleObjects = vi.fn(() => [
            {layer: labelLayer, index: 0, coordinate: [11, 48, 999]},
            {layer: pointLayer, index: 0, coordinate: [11, 48, 0]}
        ]);
        (view as any).deck = {
            props: {layers: [labelLayer, pointLayer]},
            pickMultipleObjects
        };

        const position = (view as any).markerPositionForFeature(
            {layer: labelLayer, index: 0, coordinate: [11, 48, 999]},
            {x: 500, y: 350},
            targetFeature,
            1,
            10
        );
        const expected = addMetersToLngLat(origin, [10, 20, 30]);

        expect(position[0]).toBeCloseTo(expected[0], 7);
        expect(position[1]).toBeCloseTo(expected[1], 7);
        expect(position[2]).toBeCloseTo(expected[2], 7);
        expect(pickMultipleObjects).toHaveBeenCalledWith({
            x: 500,
            y: 350,
            radius: 1,
            depth: 10,
            layerIds: ["base-label", "base-point"],
            unproject3D: true
        });
    });
});
