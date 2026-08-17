import "@angular/compiler";
import {WebMercatorViewport} from "@deck.gl/core";
import {addMetersToLngLat} from "@math.gl/web-mercator";
import {describe, expect, it, vi} from "vitest";

import type {TileFeatureId} from "../../shared/appstate.service";
import {DeckMapView2D} from "./deck-view2d";
import {DeckMapView3D} from "./deck-view3d";
import {
    DECK_MAP_FAR_Z_MULTIPLIER,
    DECK_MAP_FOV_DEGREES,
    DECK_MAP_NEAR_Z_MULTIPLIER
} from "./navigation/web-mercator-feature-navigation";

function createView() {
    const view = new DeckMapView2D(
        0,
        "canvas",
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    );
    return view;
}

/** Creates the perspective sibling used when a test exercises depth reconstruction. */
function create3DView() {
    return new DeckMapView3D(
        0,
        "canvas",
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    );
}

function subsetPickResolver(
    mapTileKey: string
): (address: number) => TileFeatureId[] {
    return address => [{
        mapTileKey,
        featureId: `feature-${address}`
    }];
}

describe("Deck rendered-feature picking", () => {
    it("uses one configured-radius deep query, excludes untagged layers, and continues after an unresolved hit", () => {
        const view = createView();
        const unselectableLayer = {
            id: "base-unselectable",
            props: {
                drillPickEligible: true,
                tileKey: "map-a/tile",
                featureAddresses: [0xffffffff],
                subsetPickResolver: subsetPickResolver("map-a/tile")
            }
        };
        const selectableLayer = {
            id: "base-selectable",
            props: {
                drillPickEligible: true,
                tileKey: "map-b/tile",
                featureAddresses: [7],
                subsetPickResolver: subsetPickResolver("map-b/tile")
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
        const view = createView();
        const mergedLayer = {
            id: "merged-base",
            props: {
                drillPickEligible: true,
                subsetPickResolver: (address: number): TileFeatureId[] => [{
                    mapTileKey: address === 0
                        ? "map-a/tile"
                        : "map-b/tile",
                    featureId: "feature-4"
                }]
            }
        };
        const pickMultipleObjects = vi.fn(() => [
            {
                layer: mergedLayer,
                object: {
                    featureAddresses: [0, 0, 1, 2]
                }
            },
            {
                layer: mergedLayer,
                object: {
                    featureAddresses: [1]
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

    it("selects only the top unique feature on primary click", () => {
        const view = createView() as any;
        const top = {mapTileKey: "map/tile", featureId: "top"};
        const lower = {mapTileKey: "map/tile", featureId: "lower"};
        view.desktopDrillPickingEnabled = true;
        view.stateService = {
            focusedView: 0,
            drillPickRadius: 2,
            inspectionsLimit: 10,
            marker: false,
            unsetUnlockedSelections: vi.fn()
        };
        view.inspectionSelection = {inspectFeatureIds: vi.fn()};
        view.coordinatesService = {
            mouseClickCoordinates: {next: vi.fn()}
        };
        view.menuService = {tileOutline: {next: vi.fn()}};
        view.drillPickFeatures = vi.fn(() => ({featureIds: [top, lower]}));
        view.pickCartographic = vi.fn(() => null);

        view.onClick(
            {x: 10, y: 20},
            {srcEvent: {button: 0, pointerType: "mouse", ctrlKey: false}}
        );

        expect(view.inspectionSelection.inspectFeatureIds)
            .toHaveBeenCalledWith([top], false);
    });

    it("picks after a touch tap when no pointer-down picking info is available", () => {
        const view = createView() as any;
        const tapped = {mapTileKey: "map/tile", featureId: "tapped"};
        view.desktopDrillPickingEnabled = false;
        view.stateService = {
            focusedView: 0,
            drillPickRadius: 5,
            inspectionsLimit: 10,
            marker: false,
            unsetUnlockedSelections: vi.fn()
        };
        view.inspectionSelection = {inspectFeatureIds: vi.fn()};
        view.coordinatesService = {
            mouseClickCoordinates: {next: vi.fn()}
        };
        view.menuService = {tileOutline: {next: vi.fn()}};
        view.drillPickFeatures = vi.fn(() => ({featureIds: [tapped]}));
        view.pickCartographic = vi.fn(() => null);

        view.onClick(
            {x: 10, y: 20},
            {srcEvent: {button: 0, pointerType: "touch", ctrlKey: false}}
        );

        expect(view.drillPickFeatures).toHaveBeenCalledWith({x: 10, y: 20}, 5, 1);
        expect(view.inspectionSelection.inspectFeatureIds)
            .toHaveBeenCalledWith([tapped], false);
    });

    it("uses one bounded asynchronous rectangle query with the same eligible layer set", async () => {
        const view = createView();
        const baseLayer = {
            id: "base-path",
            props: {
                drillPickEligible: true,
                tileKey: "map/tile",
                featureAddressesByPath: [9],
                subsetPickResolver: subsetPickResolver("map/tile")
            }
        };
        const gltfLayer = {
            id: "map/tile/gltf-pick-proxy",
            props: {pickable: true}
        };
        const pickObjectsAsync = vi.fn(async () => [{layer: baseLayer, index: 0}]);
        (view as any).deck = {
            props: {layers: [baseLayer, gltfLayer]},
            pickObjectsAsync
        };

        const result = await view.pickFeaturesInRectangle(
            {x: 5, y: 6, width: 70, height: 80},
            4
        );

        expect(pickObjectsAsync).toHaveBeenCalledOnce();
        expect(pickObjectsAsync).toHaveBeenCalledWith({
            x: 5,
            y: 6,
            width: 70,
            height: 80,
            layerIds: ["base-path"],
            maxObjects: 4
        });
        expect(result).toEqual({
            featureIds: [{mapTileKey: "map/tile", featureId: "feature-9"}]
        });
    });

    it("separates the configured-radius anchor and deep hover queries", async () => {
        const view = createView() as any;
        const baseLayer = {
            id: "base-path",
            props: {
                drillPickEligible: true,
                navigationAnchorEligible: true,
                featureAddresses: [7],
                subsetPickResolver: subsetPickResolver("map/tile")
            }
        };
        const pickObjectAsync = vi.fn(async () => ({layer: baseLayer, index: 0}));
        const pickObjectsAsync = vi.fn(async () => [{layer: baseLayer, index: 0}]);
        view.deckCanvasPointerInside = true;
        view.latestHoverPosition = {x: 12, y: 24};
        view.stateService = {drillPickRadius: 6};
        view.inspectionSelection = {setHoveredFeatures: vi.fn()};
        view.groundNavigationTarget = vi.fn(() => ({position: [11, 48, 0]}));
        view.setHoverNavigationPivot = vi.fn();
        view.deck = {
            props: {layers: [baseLayer]},
            getCanvas: () => ({clientWidth: 100, clientHeight: 100}),
            pickObjectAsync,
            pickObjectsAsync,
            setProps: vi.fn()
        };

        await view.processHoverAnchorPick({x: 12, y: 24});

        expect(pickObjectAsync).toHaveBeenCalledWith({
            x: 12,
            y: 24,
            radius: 6,
            layerIds: ["base-path"],
            unproject3D: false
        });
        expect(pickObjectsAsync).not.toHaveBeenCalled();
        expect(view.inspectionSelection.setHoveredFeatures)
            .toHaveBeenCalledWith([{
                mapTileKey: "map/tile",
                featureId: "feature-7"
            }]);

        await view.processHoverDetailPick({x: 12, y: 24});

        expect(pickObjectsAsync).toHaveBeenCalledWith({
            x: 6,
            y: 18,
            width: 13,
            height: 13,
            layerIds: ["base-path"],
            maxObjects: 10
        });
        expect(view.inspectionSelection.setHoveredFeatures)
            .toHaveBeenCalledWith([{
                mapTileKey: "map/tile",
                featureId: "feature-7"
            }]);
        // The deep pick resolved to the same logical stack, so it is not republished.
        expect(view.inspectionSelection.setHoveredFeatures).toHaveBeenCalledTimes(1);
    });

    it("retains representative altitude as a fallback when a depth coordinate is unavailable", async () => {
        const view = create3DView() as any;
        const viewport = new WebMercatorViewport({
            width: 1000,
            height: 700,
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 55,
            bearing: 30
        });
        const expected = viewport.unproject([12, 24], {targetZ: 120});
        const baseLayer = {
            id: "gpu-vector",
            props: {
                drillPickEligible: true,
                navigationAnchorEligible: true,
                featureAddresses: [7],
                subsetPickResolver: subsetPickResolver("map/tile"),
                navigationAltitudeResolver: () => 120
            }
        };
        const pickObjectAsync = vi.fn().mockResolvedValue({
            layer: baseLayer,
            index: 0,
            object: {globalPickIndex: 0},
            viewport,
            x: 12,
            y: 24
        });
        view.deckCanvasPointerInside = true;
        view.latestHoverPosition = {x: 12, y: 24};
        view.stateService = {drillPickRadius: 6};
        view.inspectionSelection = {setHoveredFeatures: vi.fn()};
        view.groundNavigationTarget = vi.fn(() => ({position: [11, 48, 0]}));
        view.setHoverNavigationPivot = vi.fn();
        view.deck = {
            props: {layers: [baseLayer]},
            pickObjectAsync,
            setProps: vi.fn()
        };

        await view.processHoverAnchorPick({x: 12, y: 24});

        expect(view.inspectionSelection.setHoveredFeatures)
            .toHaveBeenCalledWith([{
                mapTileKey: "map/tile",
                featureId: "feature-7"
            }]);
        expect(pickObjectAsync).toHaveBeenCalledTimes(1);
        expect(pickObjectAsync).toHaveBeenCalledWith({
            x: 12,
            y: 24,
            radius: 6,
            layerIds: ["gpu-vector"],
            unproject3D: false
        });
        const target = view.setHoverNavigationPivot.mock.calls[0][0];
        expect(target.position[0]).toBeCloseTo(expected[0], 7);
        expect(target.position[1]).toBeCloseTo(expected[1], 7);
        expect(target.position[2]).toBeCloseTo(expected[2], 7);
    });

    it("samples the exact top surface when right-button rotation starts", () => {
        const view = create3DView() as any;
        const depthCoordinate: [number, number, number] = [11.25, 48.5, 123];
        const baseLayer = {
            id: "gpu-vector",
            props: {navigationAnchorEligible: true}
        };
        const pickObject = vi.fn(() => ({
            layer: baseLayer,
            index: 0,
            coordinate: depthCoordinate
        }));
        view.stateService = {drillPickRadius: 6};
        view.deck = {
            props: {layers: [baseLayer]},
            pickObject
        };
        view.setHoverNavigationPivot = vi.fn();
        view.groundNavigationTarget = vi.fn();
        const preventDefault = vi.fn();

        view.deckCanvasPointerDown({
            button: 2,
            offsetX: 12,
            offsetY: 24,
            preventDefault
        });

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(pickObject).toHaveBeenCalledWith({
            x: 12,
            y: 24,
            radius: 6,
            layerIds: ["gpu-vector"],
            unproject3D: true
        });
        expect(view.pointerNavigationTarget).toEqual({
            position: depthCoordinate
        });
        expect(view.setHoverNavigationPivot).toHaveBeenCalledWith({
            position: depthCoordinate
        });
        expect(view.groundNavigationTarget).not.toHaveBeenCalled();
    });

    it("uses the pointer-down pixel with physical vector altitude", () => {
        const view = create3DView() as any;
        const viewport = new WebMercatorViewport({
            width: 1000,
            height: 700,
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 55,
            bearing: 30
        });
        const baseLayer = {
            id: "gpu-vector",
            props: {
                navigationAnchorEligible: true,
                navigationAltitudeResolver: () => 500
            }
        };
        const pickObject = vi.fn(() => ({
            layer: baseLayer,
            index: 0,
            object: {globalPickIndex: 0},
            coordinate: [11.25, 48.5, 123],
            viewport
        }));
        view.stateService = {drillPickRadius: 6};
        view.deck = {
            props: {layers: [baseLayer]},
            pickObject
        };
        view.setHoverNavigationPivot = vi.fn();
        view.groundNavigationTarget = vi.fn();

        view.deckCanvasPointerDown({
            button: 2,
            offsetX: 12,
            offsetY: 24,
            preventDefault: vi.fn()
        });

        const expected = viewport.unproject([12, 24], {targetZ: 500});
        expect(view.pointerNavigationTarget.position[0]).toBeCloseTo(expected[0], 10);
        expect(view.pointerNavigationTarget.position[1]).toBeCloseTo(expected[1], 10);
        expect(view.pointerNavigationTarget.position[2]).toBeCloseTo(500, 7);
    });

    it("keeps a representative feature pivot without another depth readback", async () => {
        const view = create3DView() as any;
        const viewport = new WebMercatorViewport({
            width: 1000,
            height: 700,
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 55,
            bearing: 30
        });
        const baseLayer = {
            id: "gpu-vector",
            props: {
                drillPickEligible: true,
                navigationAnchorEligible: true,
                featureAddresses: [7],
                subsetPickResolver: subsetPickResolver("map/tile"),
                navigationAltitudeResolver: () => 120
            }
        };
        const representativePick = {
            layer: baseLayer,
            index: 0,
            object: {globalPickIndex: 0},
            viewport,
            x: 12,
            y: 24
        };
        view.deckCanvasPointerInside = true;
        view.latestHoverPosition = {x: 12, y: 24};
        view.stateService = {drillPickRadius: 6};
        view.inspectionSelection = {setHoveredFeatures: vi.fn()};
        view.setHoverNavigationPivot = vi.fn();
        view.deck = {
            props: {layers: [baseLayer]},
            getCanvas: () => ({clientWidth: 100, clientHeight: 100}),
            pickObjectsAsync: vi.fn(async () => [representativePick]),
            pickObjectAsync: vi.fn(),
            setProps: vi.fn()
        };

        await view.processHoverDetailPick({x: 12, y: 24});

        expect(view.deck.pickObjectAsync).not.toHaveBeenCalled();
        expect(view.setHoverNavigationPivot).toHaveBeenCalledTimes(1);
        expect(view.setHoverNavigationPivot.mock.calls[0][0].position[2])
            .toBeCloseTo(120, 7);
    });

    it("does not move the navigation pivot or start a hover pick while dragging", () => {
        const view = createView() as any;
        view.deckCanvasPointerInside = true;
        view.coordinatesService = {mouseMoveCoordinates: {next: vi.fn()}};
        view.pickCartographic = vi.fn(() => ({lon: 11, lat: 48, alt: 0}));
        view.groundNavigationTarget = vi.fn();
        view.setHoverNavigationPivot = vi.fn();
        view.queueHoverPicks = vi.fn();

        view.onCanvasPointerMove({offsetX: 12, offsetY: 24, buttons: 1});

        expect(view.setHoverNavigationPivot).not.toHaveBeenCalled();
        expect(view.groundNavigationTarget).not.toHaveBeenCalled();
        expect(view.queueHoverPicks).not.toHaveBeenCalled();
    });

    it("waits for pointer idle before starting the deep hover query", async () => {
        vi.useFakeTimers();
        try {
            const view = createView() as any;
            const position = {x: 12, y: 24};
            view.deckCanvasPointerInside = true;
            view.pendingHoverDetailPosition = position;
            view.hoverDetailPickDueAtMs = performance.now() + 120;
            view.processHoverDetailPick = vi.fn(async () => undefined);

            view.scheduleHoverDetailPick();
            await vi.advanceTimersByTimeAsync(119);
            expect(view.processHoverDetailPick).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(view.processHoverDetailPick).toHaveBeenCalledWith(position);
        } finally {
            vi.useRealTimers();
        }
    });

    it("snaps a thick picked path ribbon to its base XYZ centerline", () => {
        const view = createView();
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
                subsetPickResolver: subsetPickResolver("map/tile"),
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
        (pathLayer as any).projectPosition = (position: number[]) =>
            viewport.projectPosition(addMetersToLngLat(origin, position));
        const ribbonCoordinate = addMetersToLngLat(origin, [50, 8, 0]);
        const expected = addMetersToLngLat(origin, [50, 0, 0]);
        const cursor = viewport.project(expected);
        const pickMultipleObjects = vi.fn(() => [{
            layer: pathLayer,
            index: 0,
            coordinate: ribbonCoordinate,
            viewport,
            x: cursor[0],
            y: cursor[1]
        }]);
        (view as any).deck = {pickMultipleObjects};

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});

        expect(target?.featureIds).toEqual([
            {mapTileKey: "map/tile", featureId: "feature-12"}
        ]);
        expect(target?.position[0]).toBeCloseTo(expected[0], 7);
        expect(target?.position[1]).toBeCloseTo(expected[1], 7);
        expect(target?.position[2]).toBeCloseTo(expected[2], 7);
        expect(pickMultipleObjects).toHaveBeenCalledWith({
            x: cursor[0],
            y: cursor[1],
            radius: 4,
            depth: 32,
            unproject3D: true
        });
    });

    it("rejects a thick ribbon hit outside the configured centreline tolerance", () => {
        const view = createView();
        const origin: [number, number, number] = [11, 48, 100];
        const pathLayer = {
            id: "base-path",
            props: {
                navigationAnchorEligible: true,
                tileKey: "map/tile",
                featureAddressesByPath: [12],
                subsetPickResolver: subsetPickResolver("map/tile"),
                pathCenterline: {
                    positions: new Float32Array([
                        0, 0, 0,
                        100, 0, 0
                    ]),
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
        (pathLayer as any).projectPosition = (position: number[]) =>
            viewport.projectPosition(addMetersToLngLat(origin, position));
        const ribbonCoordinate = addMetersToLngLat(origin, [50, 20, 0]);
        const cursor = viewport.project(ribbonCoordinate);
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [{
                layer: pathLayer,
                index: 0,
                coordinate: ribbonCoordinate,
                viewport,
                x: cursor[0],
                y: cursor[1]
            }])
        };

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});

        expect(target).toBeUndefined();
    });

    it("uses the configured pick radius when snapping a path navigation target", () => {
        const view = createView();
        const origin: [number, number, number] = [11, 48, 100];
        const pathLayer = {
            id: "base-path",
            props: {
                navigationAnchorEligible: true,
                featureAddressesByPath: [12],
                subsetPickResolver: subsetPickResolver("map/tile"),
                pathCenterline: {
                    positions: new Float32Array([0, 0, 0, 100, 0, 0]),
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
        (pathLayer as any).projectPosition = (position: number[]) =>
            viewport.projectPosition(addMetersToLngLat(origin, position));
        const expected = addMetersToLngLat(origin, [50, 0, 0]);
        const projected = viewport.project(expected);
        const firstProjected = viewport.project(origin);
        const secondProjected = viewport.project(
            addMetersToLngLat(origin, [100, 0, 0])
        );
        const direction = [
            secondProjected[0] - firstProjected[0],
            secondProjected[1] - firstProjected[1]
        ];
        const directionLength = Math.hypot(direction[0], direction[1]);
        const cursor = [
            projected[0] - direction[1] * 8 / directionLength,
            projected[1] + direction[0] * 8 / directionLength
        ];
        const pickMultipleObjects = vi.fn(() => [{
            layer: pathLayer,
            index: 0,
            viewport,
            x: cursor[0],
            y: cursor[1]
        }]);
        (view as any).stateService = {drillPickRadius: 10};
        (view as any).deck = {pickMultipleObjects};

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});

        expect(target?.position[0]).toBeCloseTo(expected[0], 7);
        expect(target?.position[1]).toBeCloseTo(expected[1], 7);
        expect(pickMultipleObjects).toHaveBeenCalledWith({
            x: cursor[0],
            y: cursor[1],
            radius: 10,
            depth: 32,
            unproject3D: true
        });
    });

    it("snaps a path correctly when its other endpoint is behind the camera", () => {
        const view = createView();
        const origin: [number, number, number] = [11.62353515625, 48.27392578125, 0];
        const pathLayer = {
            id: "base-path",
            props: {
                navigationAnchorEligible: true,
                featureAddressesByPath: [12],
                subsetPickResolver: subsetPickResolver("map/tile"),
                pathCenterline: {
                    positions: new Float32Array([
                        361.51239013671875, -6038.67333984375, 536.7999877929688,
                        375.9411926269531, -5995.0078125, 536.75
                    ]),
                    startIndices: new Uint32Array([0, 2]),
                    coordinateOrigin: origin
                }
            }
        };
        const viewport = new WebMercatorViewport({
            width: 1555,
            height: 1391,
            longitude: 11.625705744539573,
            latitude: 48.231868116614734,
            zoom: 16.173423152264448,
            pitch: 68.44308175262151,
            bearing: 350.39624489258654,
            fovy: DECK_MAP_FOV_DEGREES,
            nearZMultiplier: DECK_MAP_NEAR_Z_MULTIPLIER,
            farZMultiplier: DECK_MAP_FAR_Z_MULTIPLIER
        });
        (pathLayer as any).projectPosition = (position: number[]) =>
            viewport.projectPosition(addMetersToLngLat(origin, position));
        const coordinate: [number, number, number] = [
            11.628603850518628,
            48.21999052746244,
            536.7616557379134
        ];
        const expected = addMetersToLngLat(origin, [
            375.9411926269531,
            -5995.0078125,
            536.75
        ]);
        const cursor = viewport.project(expected);
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [{
                layer: pathLayer,
                index: 0,
                coordinate,
                viewport,
                x: cursor[0],
                y: cursor[1]
            }])
        };

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});
        const projected = viewport.project(target!.position);

        expect(Math.hypot(projected[0] - cursor[0], projected[1] - cursor[1])).toBeLessThanOrEqual(4);
        expect(projected[2]).toBeGreaterThan(0);
        expect(projected[2]).toBeLessThan(1);
    });

    it("returns the normalized surface orientation with an ordinary surface target", () => {
        const view = createView();
        const surfaceLayer = {
            id: "base-surface",
            props: {
                navigationAnchorEligible: true,
                tileKey: "map/tile",
                featureAddresses: [12],
                surfaceNormals: new Float32Array([0, -2, 2]),
                subsetPickResolver: subsetPickResolver("map/tile")
            }
        };
        const coordinate: [number, number, number] = [11, 48, 120];
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [{
                layer: surfaceLayer,
                index: 0,
                coordinate
            }])
        };

        const target = view.pickNavigationTarget({x: 500, y: 350});

        expect(target?.position).toEqual(coordinate);
        expect(target?.surfaceNormal?.[0]).toBe(0);
        expect(target?.surfaceNormal?.[1]).toBeCloseTo(-Math.SQRT1_2, 6);
        expect(target?.surfaceNormal?.[2]).toBeCloseTo(Math.SQRT1_2, 6);
    });

    it("reconstructs a GPU vector anchor at its physical altitude instead of biased render depth", () => {
        const view = create3DView();
        const viewport = new WebMercatorViewport({
            width: 1000,
            height: 700,
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 65,
            bearing: 30
        });
        const cursor: [number, number] = [620, 390];
        const expected = viewport.unproject(cursor, {targetZ: 120});
        const biasedCoordinate = viewport.unproject([cursor[0], cursor[1], 0.1]);
        const layer = {
            id: "gpu-vector",
            props: {
                navigationAnchorEligible: true,
                navigationAltitudeResolver: vi.fn(() => 120),
                subsetPickResolver: subsetPickResolver("map/tile")
            }
        };
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [{
                layer,
                index: 47,
                object: {globalPickIndex: 47},
                coordinate: biasedCoordinate,
                viewport,
                x: cursor[0],
                y: cursor[1]
            }])
        };

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});

        expect(layer.props.navigationAltitudeResolver).toHaveBeenCalledWith(47);
        expect(target?.position[0]).toBeCloseTo(expected[0], 8);
        expect(target?.position[1]).toBeCloseTo(expected[1], 8);
        expect(target?.position[2]).toBeCloseTo(120, 8);
        expect(target?.position[2]).not.toBeCloseTo(Number(biasedCoordinate[2]), 3);
    });

    it("accepts an eligible physical surface without a logical feature identity", () => {
        const view = createView();
        const coordinate: [number, number, number] = [11, 48, 120];
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [{
                layer: {props: {navigationAnchorEligible: true}},
                coordinate
            }])
        };

        const target = view.pickNavigationTarget({x: 500, y: 350});

        expect(target?.position).toEqual(coordinate);
        expect(target?.featureIds).toEqual([]);
    });

    it("uses a deeper surface orientation for the same topmost path feature", () => {
        const view = createView();
        const origin: [number, number, number] = [11, 48, 100];
        const pathLayer = {
            id: "base-path",
            props: {
                navigationAnchorEligible: true,
                featureAddressesByPath: [12],
                subsetPickResolver: subsetPickResolver("map/tile"),
                pathCenterline: {
                    positions: new Float32Array([0, 0, 0, 100, 0, 0]),
                    startIndices: new Uint32Array([0, 2]),
                    coordinateOrigin: origin
                }
            }
        };
        const surfaceLayer = {
            id: "base-surface",
            props: {
                navigationAnchorEligible: true,
                featureAddresses: [12],
                surfaceNormals: new Float32Array([0, -2, 2]),
                subsetPickResolver: subsetPickResolver("map/tile")
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
        (pathLayer as any).projectPosition = (position: number[]) =>
            viewport.projectPosition(addMetersToLngLat(origin, position));
        const pathCoordinate = addMetersToLngLat(origin, [50, 8, 0]);
        const expected = addMetersToLngLat(origin, [50, 0, 0]);
        const cursor = viewport.project(expected);
        (view as unknown as {deck: unknown}).deck = {
            pickMultipleObjects: vi.fn(() => [
                {
                    layer: pathLayer,
                    index: 0,
                    coordinate: pathCoordinate,
                    viewport,
                    x: cursor[0],
                    y: cursor[1]
                },
                {layer: surfaceLayer, index: 0, coordinate: [11, 48, 120], viewport}
            ])
        };

        const target = view.pickNavigationTarget({x: cursor[0], y: cursor[1]});

        expect(target?.position[0]).toBeCloseTo(expected[0], 7);
        expect(target?.position[1]).toBeCloseTo(expected[1], 7);
        expect(target?.surfaceNormal?.[1]).toBeCloseTo(-Math.SQRT1_2, 6);
        expect(target?.surfaceNormal?.[2]).toBeCloseTo(Math.SQRT1_2, 6);
    });

    it("skips a nonphysical label and anchors navigation and markers to the feature point", () => {
        const view = createView();
        const targetFeature = {mapTileKey: "map/tile", featureId: "feature-12"};
        const labelLayer = {
            id: "base-label",
            props: {
                drillPickEligible: true,
                tileKey: targetFeature.mapTileKey,
                featureAddresses: [12],
                subsetPickResolver: subsetPickResolver(
                    targetFeature.mapTileKey
                )
            }
        };
        const origin: [number, number, number] = [11, 48, 100];
        const pointLayer = {
            id: "base-point",
            props: {
                drillPickEligible: true,
                navigationAnchorEligible: true,
                markerAnchorEligible: true,
                tileKey: targetFeature.mapTileKey,
                featureAddresses: [12],
                subsetPickResolver: subsetPickResolver(
                    targetFeature.mapTileKey
                ),
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

        const navigationTarget = view.pickNavigationTarget({x: 500, y: 350});
        const position = (view as any).markerPositionForFeature(
            {layer: labelLayer, index: 0, coordinate: [11, 48, 999]},
            {x: 500, y: 350},
            targetFeature,
            1,
            10
        );
        const expected = addMetersToLngLat(origin, [10, 20, 30]);

        expect(navigationTarget?.featureIds).toEqual([targetFeature]);
        expect(navigationTarget?.position[0]).toBeCloseTo(expected[0], 7);
        expect(navigationTarget?.position[1]).toBeCloseTo(expected[1], 7);
        expect(navigationTarget?.position[2]).toBeCloseTo(expected[2], 7);
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
