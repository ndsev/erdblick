/** Lossless browser representation of mapget's tagged PartitionId. */
export type TilePartitionId = {readonly kind: "tile"; readonly id: number};
export type ObjectPartitionId = {
    readonly kind: "object";
    readonly id: string;
};
export type PartitionId = TilePartitionId | ObjectPartitionId;

const UINT64_MAX = 18_446_744_073_709_551_615n;

/** Construct a checked tile partition from a packed signed TileId. */
export function tilePartition(id: number): TilePartitionId {
    if (!Number.isInteger(id) || id < -0x8000_0000 || id > 0x7fff_ffff) {
        throw new Error(`Invalid packed tile partition id '${id}'.`);
    }
    return {kind: "tile", id};
}

/** Construct a checked, canonical unsigned object partition. */
export function objectPartition(id: string | bigint): ObjectPartitionId {
    const text = typeof id === "bigint" ? id.toString() : id;
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
        throw new Error(`Invalid object partition id '${text}'.`);
    }
    const value = BigInt(text);
    if (value > UINT64_MAX) {
        throw new Error(`Object partition id '${text}' exceeds uint64.`);
    }
    return {kind: "object", id: value.toString()};
}

/** Validate an untrusted JSON/WASM partition without narrowing object IDs. */
export function parsePartition(value: unknown): PartitionId {
    if (!value || typeof value !== "object") {
        throw new Error("Partition identity must be an object.");
    }
    const candidate = value as {kind?: unknown; id?: unknown};
    if (candidate.kind === "tile" && typeof candidate.id === "number") {
        return tilePartition(candidate.id);
    }
    if (candidate.kind === "object" && typeof candidate.id === "string") {
        return objectPartition(candidate.id);
    }
    throw new Error("Partition identity must be a tagged tile or object id.");
}

/** Stable in-process key; tagged prefixes prevent tile/object collisions. */
export function partitionKey(partition: PartitionId): string {
    return `${partition.kind}:${partition.id}`;
}

/** Stable suffix understood by mapget's MapPartitionKey serializer. */
export function partitionKeySuffix(partition: PartitionId): string {
    return partition.kind === "tile"
        ? String(partition.id)
        : `object/${partition.id}`;
}

/** Return a detached JSON request value. */
export function partitionJson(partition: PartitionId): PartitionId {
    return partition.kind === "tile"
        ? {kind: "tile", id: partition.id}
        : {kind: "object", id: partition.id};
}

/** Structural equality for tagged partition identities. */
export function partitionsEqual(
    left: PartitionId,
    right: PartitionId
): boolean {
    return left.kind === right.kind && left.id === right.id;
}

/**
 * Decode a MapPartitionKey through the current WASM API, with a tile-only
 * fallback for lightweight tests and rolling host/WASM upgrades.
 */
export function parseMapPartitionKey(
    library: {
        parseMapPartitionKey?: (key: string) => unknown;
        parseMapTileKey: (key: string) => unknown;
    },
    key: string
): [string, string, PartitionId] {
    if (typeof library.parseMapPartitionKey === "function") {
        const result = library.parseMapPartitionKey(key) as unknown[];
        return [
            String(result[0]),
            String(result[1]),
            parsePartition(result[2])
        ];
    }
    const legacy = library.parseMapTileKey(key) as unknown[];
    return [
        String(legacy[0]),
        String(legacy[1]),
        tilePartition(Number(legacy[2]))
    ];
}
