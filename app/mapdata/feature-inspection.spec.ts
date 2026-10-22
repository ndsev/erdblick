import {describe, expect, it, vi} from "vitest";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {InspectionFeatureTile} from "./feature-inspection";
import {TileDeliveryError} from "./tile-diagnostics";
import {coreLib} from "../integrations/wasm";
import {MAP_TILE_STREAM_HEADER_SIZE, MAP_TILE_STREAM_TYPE_END_OF_STREAM, MAP_TILE_STREAM_TYPE_STATUS} from "./tilestream";

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

describe('Incoming inspection response validation', () => {
    it('rejects success without a manifest instead of showing an empty result', async () => {
        const frame = (type: number, value: object) => {
            const payload = new TextEncoder().encode(JSON.stringify(value));
            const result = new Uint8Array(MAP_TILE_STREAM_HEADER_SIZE + payload.length);
            const header = new DataView(result.buffer);
            header.setUint16(0, coreLib.tileLayerStreamProtocolMajor(), true);
            header.setUint16(2, coreLib.tileLayerStreamProtocolMinor(), true);
            header.setUint8(6, type);
            header.setUint32(7, payload.length, true);
            result.set(payload, MAP_TILE_STREAM_HEADER_SIZE);
            return result;
        };
        const success = frame(MAP_TILE_STREAM_TYPE_STATUS, {type: 'mapget.filter.status', state: 'Success'});
        const end = frame(MAP_TILE_STREAM_TYPE_END_OF_STREAM, {});
        const bytes = new Uint8Array(success.length + end.length);
        bytes.set(success); bytes.set(end, success.length);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
        const parser = {
            getFieldDictOffsets: () => ({}),
            readTileLayerMetadata: () => ({
                id: 'Features:Map:Surface:42', stringPoolId: 'source', mapName: 'Map',
                layerName: 'Surface', partition: {kind: 'tile', id: 42}, tileId: 42, numFeatures: 1
            })
        } as unknown as TileLayerParser;
        try {
            const tile = new InspectionFeatureTile(parser, new Uint8Array([0]));
            await expect(tile.loadIncoming('Surface.1', new AbortController().signal))
                .rejects.toThrow('Incomplete incoming inspection response');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
