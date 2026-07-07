// @vitest-environment node
import {describe, expect, it} from "vitest";

import {
    decodeLayerNamesV2,
    decodeMapNamesV2,
    decodeSelectionsV2,
    decodeStyleOptionsV2,
    encodeLayerNamesV2,
    encodeMapNamesV2,
    encodeSelectionsV2,
    encodeStyleOptionsV2,
    featureSelectionLayerNames,
    sourceDataSelectionMapIds
} from "./url-state-codec";

const defaultColors = [
    "#fff314",
    "#4ad6d6",
    "#8f52ff",
    "#ff1212",
];

describe("URL state v2 codec", () => {
    it("round-trips adjacent prefix and suffix compressed map names", () => {
        const maps = [
            "Islands/https-api-nds-live-island6",
            "YetIslands/https-api-nds-live-island6",
            "https-api-nds-live-island1",
            "https-api-nds-live-island3",
            "filestore-home-vagram-nds-tomtom-eu-ndslive",
        ];

        const encoded = encodeMapNamesV2(maps);

        expect(encoded.length).toBeLessThan(maps.map(encodeURIComponent).join("~").length);
        expect(decodeMapNamesV2(encoded)).toEqual(maps);
    });

    it("encodes layer groups without changing the current layer order", () => {
        const layers = [
            "MapA/Lane",
            "MapA/POI",
            "MapB/Lane",
            "MapB/Road",
        ];

        const encoded = encodeLayerNamesV2(layers);

        expect(encoded.mapNames).toEqual(["MapA", "MapB"]);
        expect(decodeLayerNamesV2(encoded.map ?? "", encoded.l ?? "")).toEqual(layers);
    });

    it("encodes style options with show shorthand, view mirroring, and run-length values", () => {
        const styles = new Map<string, (string|number|boolean)[]>([
            ["MapA/Lane/T93C/showCenterLines", [true, true]],
            ["MapB/Lane/T93C/showCenterLines", [true, true]],
            ["MapA/Lane/T93C/showBoundaries", [false, false]],
            ["MapB/Lane/T93C/showBoundaries", [false, false]],
        ]);

        const encoded = encodeStyleOptionsV2(styles, ["MapA/Lane", "MapB/Lane"], 2);

        expect(encoded).toEqual({
            "T93C~0-1~.CenterLines~.Boundaries": "1x2~0x2",
        });

        const decoded = decodeStyleOptionsV2(encoded, ["MapA/Lane", "MapB/Lane"], 2, new Map());
        expect(decoded.get("MapA/Lane/T93C/showCenterLines")).toEqual(["1", "1"]);
        expect(decoded.get("MapB/Lane/T93C/showCenterLines")).toEqual(["1", "1"]);
        expect(decoded.get("MapA/Lane/T93C/showBoundaries")).toEqual(["0", "0"]);
        expect(decoded.get("MapB/Lane/T93C/showBoundaries")).toEqual(["0", "0"]);
    });

    it("round-trips feature and SourceData selections", () => {
        const layerNames = ["MapA/Lane", "MapB/Road"];
        const panels = [
            {
                id: 0,
                features: [{
                    mapTileKey: "Features:MapA:Lane:21fa0777000d:0",
                    featureId: "Lane.545379780.24:attribute#1,validity#0",
                }],
                locked: false,
                size: [30, 20] as [number, number],
                color: "#fff314",
                undocked: false,
            },
            {
                id: 3,
                features: [],
                sourceData: {
                    mapTileKey: "SourceData:MapB:SourceData-LaneGeometryLayer-1:21fa0777000d:0",
                    address: 783783249845n,
                },
                locked: false,
                size: [45, 32] as [number, number],
                color: "#ff1212",
                undocked: true,
            },
        ];
        const layerEncoding = encodeLayerNamesV2(layerNames, sourceDataSelectionMapIds(panels));

        const encoded = encodeSelectionsV2(panels, layerNames, layerEncoding.mapNames, defaultColors);

        expect(encoded).toContain("F:0:21fa0777000d");
        expect(encoded).toContain("Lane.545379780.24%3Aattribute%231%2Cvalidity%230");
        expect(encoded).toContain("SD:1:LaneGeometryLayer-1:21fa0777000d");

        const decoded = decodeSelectionsV2(encoded ?? "", layerNames, layerEncoding.mapNames, defaultColors);
        expect(decoded).toEqual([
            {
                id: 0,
                features: [{
                    mapTileKey: "Features:MapA:Lane:21fa0777000d:0",
                    featureId: "Lane.545379780.24:attribute#1,validity#0",
                }],
                locked: true,
                size: [30, 20],
                color: "#fff314",
                undocked: false,
            },
            {
                id: 3,
                features: [],
                sourceData: {
                    mapTileKey: "SourceData:MapB:SourceData-LaneGeometryLayer-1:21fa0777000d:0",
                    address: 783783249845n,
                },
                locked: true,
                size: [45, 32],
                color: "#ff1212",
                undocked: true,
            },
        ]);
    });

    it("round-trips selected features from slash-containing map ids when their layer is active", () => {
        const layerNames = [
            "Island-3D/Display3D",
            "Provider/Sample Munich/Landmark",
        ];
        const panels = [{
            id: 0,
            features: [
                {
                    mapTileKey: "Features:Island-3D:Display3D:545666604:0",
                    featureId: "DisplayMesh.545666604.8",
                },
                {
                    mapTileKey: "Features:Provider%2FSample Munich:Landmark:545666604:0",
                    featureId: "Landmark.545666604.12",
                },
            ],
            locked: false,
            size: [30, 20] as [number, number],
            color: "#fff314",
            undocked: false,
        }];
        const layerEncoding = encodeLayerNamesV2(layerNames);

        const encoded = encodeSelectionsV2(panels, layerNames, layerEncoding.mapNames, defaultColors);

        expect(encoded).toContain("F:0:545666604");
        expect(encoded).toContain("F:1:545666604");
        expect(decodeLayerNamesV2(layerEncoding.map ?? "", layerEncoding.l ?? "")).toEqual(layerNames);
        expect(decodeSelectionsV2(encoded ?? "", layerNames, layerEncoding.mapNames, defaultColors)).toEqual([{
            id: 0,
            features: [
                {
                    mapTileKey: "Features:Island-3D:Display3D:545666604:0",
                    featureId: "DisplayMesh.545666604.8",
                },
                {
                    mapTileKey: "Features:Provider/Sample Munich:Landmark:545666604:0",
                    featureId: "Landmark.545666604.12",
                },
            ],
            locked: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }]);
    });

    it("adds selected feature layers to v2 layer encoding when active layer state missed them", () => {
        const activeLayerNames = [
            "Germany/Road",
            "Island-3D/Display3D",
        ];
        const panels = [{
            id: 0,
            features: [
                {
                    mapTileKey: "Features:Provider%2FSample Munich:Lane:545555209:0",
                    featureId: "Lane.545555209.16803",
                },
                {
                    mapTileKey: "Features:Germany:Road:545666614:0",
                    featureId: "Road.545666614.1132",
                },
                {
                    mapTileKey: "Features:Island-3D:Display3D:545666604:0",
                    featureId: "DisplayMesh.545666604.54",
                },
            ],
            locked: true,
            size: [30, 20] as [number, number],
            color: "#fff314",
            undocked: false,
        }];
        const urlLayerNames = [...activeLayerNames];
        for (const layerName of featureSelectionLayerNames(panels)) {
            if (!urlLayerNames.includes(layerName)) {
                urlLayerNames.push(layerName);
            }
        }
        const layerEncoding = encodeLayerNamesV2(urlLayerNames);
        const encoded = encodeSelectionsV2(panels, urlLayerNames, layerEncoding.mapNames, defaultColors);

        expect(decodeLayerNamesV2(layerEncoding.map ?? "", layerEncoding.l ?? "")).toEqual([
            "Germany/Road",
            "Island-3D/Display3D",
            "Provider/Sample Munich/Lane",
        ]);
        expect(decodeSelectionsV2(encoded ?? "", urlLayerNames, layerEncoding.mapNames, defaultColors)).toEqual([{
            id: 0,
            features: [
                {
                    mapTileKey: "Features:Provider/Sample Munich:Lane:545555209:0",
                    featureId: "Lane.545555209.16803",
                },
                {
                    mapTileKey: "Features:Germany:Road:545666614:0",
                    featureId: "Road.545666614.1132",
                },
                {
                    mapTileKey: "Features:Island-3D:Display3D:545666604:0",
                    featureId: "DisplayMesh.545666604.54",
                },
            ],
            locked: true,
            size: [30, 20],
            color: "#fff314",
            undocked: false,
        }]);
    });
});
