import {
    objectPartition,
    parseMapPartitionKey,
    parsePartition,
    partitionJson,
    partitionKey,
    partitionKeySuffix,
    tilePartition
} from "./partition.model";

describe("PartitionId", () => {
    it("preserves the complete unsigned object-id range as decimal text", () => {
        const partition = parsePartition({
            kind: "object",
            id: "18446744073709551615"
        });

        expect(partition).toEqual({
            kind: "object",
            id: "18446744073709551615"
        });
        expect(partitionKey(partition)).toBe(
            "object:18446744073709551615"
        );
        expect(partitionKeySuffix(partition)).toBe(
            "object/18446744073709551615"
        );
        expect(partitionJson(partition)).toEqual(partition);
    });

    it("keeps signed packed tile ids distinct from object ids", () => {
        expect(partitionKey(tilePartition(-1))).toBe("tile:-1");
        expect(partitionKey(objectPartition("18446744073709551615")))
            .not.toBe(partitionKey(tilePartition(-1)));
    });

    it("rejects lossy, non-canonical, and out-of-range object ids", () => {
        expect(() => parsePartition({
            kind: "object",
            id: Number("9007199254740993")
        }))
            .toThrow();
        expect(() => objectPartition("01")).toThrow();
        expect(() => objectPartition("18446744073709551616")).toThrow();
    });

    it("decodes generic keys while retaining a tile-only rolling fallback", () => {
        expect(parseMapPartitionKey({
            parseMapPartitionKey: () => [
                "Map",
                "Road",
                {kind: "object", id: "9007199254740993"}
            ],
            parseMapTileKey: () => {
                throw new Error("generic decoder should win");
            }
        }, "object-key")).toEqual([
            "Map",
            "Road",
            objectPartition("9007199254740993")
        ]);
        expect(parseMapPartitionKey({
            parseMapTileKey: () => ["Map", "Road", -1]
        }, "tile-key")).toEqual([
            "Map",
            "Road",
            tilePartition(-1)
        ]);
    });
});
