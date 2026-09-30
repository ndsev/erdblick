import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {FeatureLayerStyle, TileLayerParser} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasmOrThrow} from "../integrations/wasm";
import {MapInfoService} from "./map-info.service";
import type {MapInfoItem} from "./map.tree.model";

describe("MapInfoService style parser ownership", () => {
    it("deletes a failed parser, propagates its error, and caches only a successful retry", () => {
        const source: MapInfoItem = {
            extraJsonAttachment: {},
            layers: {
                Road: {
                    layerId: "Road",
                    type: "Features",
                    canRead: true,
                    canWrite: false,
                    coverage: [],
                    featureTypes: [],
                    version: {major: 1, minor: 0, patch: 0},
                    zoomLevels: [13]
                }
            },
            mapId: "Map",
            sourceId: "Map",
            stringPoolId: "Map",
            maxParallelJobs: 1,
            addOn: false
        };
        const parsers = new Map<string, TileLayerParser>();
        // Exercise the real planning and WASM bridge without unrelated map-tree subscriptions.
        const service: MapInfoService = Object.assign(Object.create(MapInfoService.prototype), {
            sourceCatalogEntries: [source],
            styleParsersByMapId: parsers
        });
        const style = uint8ArrayToWasmOrThrow<FeatureLayerStyle>(
            buffer => new coreLib.FeatureLayerStyle(buffer),
            new TextEncoder().encode("name: Test\nversion: 2\nrules:\n  - geometry: line\n    color: '#ffffff'\n")
        );
        const parseError = new Error("Invalid layer schema");
        const prototype: TileLayerParser = coreLib.TileLayerParser.prototype;
        const initialize = vi.spyOn(prototype, "setDataSourceInfo").mockImplementationOnce(() => {
            throw parseError;
        });
        const release = vi.spyOn(prototype, "delete");
        const plan = vi.spyOn(prototype, "planStyleFilter");

        try {
            expect(style.isValid(), JSON.stringify(style.validationReport())).toBe(true);
            expect(() => service.planStyleFilter(style, "Map", "Road", 0, 7)).toThrow(parseError);
            expect(initialize).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
            expect(plan).not.toHaveBeenCalled();
            expect(parsers.size).toBe(0);

            const result = service.planStyleFilter(style, "Map", "Road", 0, 7);
            expect(result).toMatchObject({valid: true});
            expect(initialize).toHaveBeenCalledTimes(2);
            expect(initialize.mock.contexts[1]).not.toBe(initialize.mock.contexts[0]);
            expect(release).toHaveBeenCalledTimes(1);
            expect(plan).toHaveBeenCalledTimes(1);
            expect(parsers.size).toBe(1);

            expect(service.planStyleFilter(style, "Map", "Road", 0, 7)).toEqual(result);
            expect(initialize).toHaveBeenCalledTimes(2);
            expect(plan).toHaveBeenCalledTimes(2);
        } finally {
            for (const parser of parsers.values()) {
                parser.delete();
            }
            style.delete();
            vi.restoreAllMocks();
        }
    });
});
