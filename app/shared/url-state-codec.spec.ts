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
});
