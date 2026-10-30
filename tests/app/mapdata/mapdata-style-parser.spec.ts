import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {FeatureLayerStyle} from "../../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasmOrThrow} from "../../../app/integrations/wasm.adapter";
import {MapDataService} from "../../../app/mapdata/mapdata.service";

describe("MapDataService style parser ownership", () => {
    it("plans against the installed shared parser and refuses an unready source", () => {
        const parser = new coreLib.TileLayerParser();
        uint8ArrayToWasmOrThrow(data => parser.setDataSourceInfo(data), new TextEncoder().encode(JSON.stringify([{
            mapId: "Map", stringPoolId: "Map", layers: {Road: {
                layerId: "Road", type: "Features", featureTypes: []
            }}
        }])));
        let ready = true;
        // The tree lifecycle has separate catalog tests. This boundary verifies
        // that planning reuses its native owner and never reparses metadata.
        const service: MapDataService = Object.assign(Object.create(MapDataService.prototype), {
            parserInstance: parser,
            isMapLayerReady: () => ready
        });
        const style = uint8ArrayToWasmOrThrow<FeatureLayerStyle>(
            buffer => new coreLib.FeatureLayerStyle(buffer),
            new TextEncoder().encode("name: Test\nversion: 2\nrules:\n  - geometry: line\n    color: '#ffffff'\n")
        );
        const initialize = vi.spyOn(parser, "setDataSourceInfo");
        const plan = vi.spyOn(parser, "planStyleFilter");
        try {
            expect(style.isValid(), JSON.stringify(style.validationReport())).toBe(true);
            expect(service.planStyleFilter(style, "Map", "Road", 0, 7)).toMatchObject({valid: true});
            expect(service.planStyleFilter(style, "Map", "Road", 0, 7)).toMatchObject({valid: true});
            expect(plan).toHaveBeenCalledTimes(2);
            expect(initialize).not.toHaveBeenCalled();
            ready = false;
            expect(() => service.planStyleFilter(style, "Map", "Road", 0, 7)).toThrow("not ready");
            expect(plan).toHaveBeenCalledTimes(2);
        } finally {
            vi.restoreAllMocks();
            parser.delete();
            style.delete();
        }
    });
});
