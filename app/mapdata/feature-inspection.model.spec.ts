import {describe, expect, it} from "vitest";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {InspectionFeatureTile} from "./feature-inspection.model";
import {TileDeliveryError} from "./tile-diagnostics";

describe("InspectionFeatureTile error lifetime", () => {
    it("preserves the failed value's absolute expiry without a retry hint", () => {
        const parser = {
            readTileLayerMetadata: () => ({
                id: "Features:Map:Road:42", stringPoolId: "source", mapName: "Map",
                layerName: "Road", partition: {kind: "tile", id: 42}, tileId: 42,
                numFeatures: 0, error: "temporary outage", conversionTimestampMs: 1000, ttlMs: 5000
            })
        } as unknown as TileLayerParser;
        let failure: unknown;
        try {
            new InspectionFeatureTile(parser, new Uint8Array([0]));
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(TileDeliveryError);
        expect((failure as TileDeliveryError).message).toBe("temporary outage");
        expect((failure as TileDeliveryError).expiresAtMs).toBe(6000);
    });
});
