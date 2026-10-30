/**
 * Datasource catalog values and their normalization rules.
 * These contracts are shared by transport, layer models and the map tree without
 * constructing the tree controller or subscribing to application state.
 */

export type DataSourceCatalogStatus = "initializing" | "ready" | "failed";

/**
 * Browser-local schema installation, independent of the server's startup status.
 * A server-ready source remains visible while loading, but cannot yet supply
 * tiles, completion or feature-type choices. A failure must not prune saved state.
 */
export type MapSchemaStatus = "loading" | "ready" | "failed";

/** Descriptive format metadata; only schemaId identifies an exact domain graph. */
export interface MapFormat {
    name: string;
    version: string;
    subsystems?: Record<string, string>;
}

/**
 * Exact validated schema bytes retained for isolated WASM workers.
 * Each heap installs its own copy; parsers within a heap share the native owner.
 */
export interface MapSchemaArtifact {
    schemaId: string;
    bytes: Uint8Array;
}

/** Expected structure of a LayerInfoItem's coverage entry. */
export interface CoverageRectItem extends Record<string, any> {
    min: number,
    max: number
}

/** Expected structure of a list entry in the MapInfoItem's layer entry. */
export interface LayerInfoItem extends Record<string, any> {
    canRead: boolean;
    canWrite: boolean;
    defaultVisible?: boolean;
    coverage: Array<number | CoverageRectItem>;
    /** Legacy input only. Native metadata import moves these definitions into MapSchema. */
    featureTypes?: Array<{ name: string, uniqueIdCompositions: Array<any> }>;
    layerId: string;
    type: string;
    version: { major: number, minor: number, patch: number };
    zoomLevels: Array<number>;
    partitionKind?: "tile" | "object";
    tileAssociationLevel?: number;
}

/** Expected structure of a list entry in the /sources endpoint. */
export interface MapInfoItem extends Record<string, any> {
    extraJsonAttachment: any;
    layers: Record<string, LayerInfoItem>;
    mapId: string;
    maxParallelJobs: number;
    sourceId: string;
    stringPoolId: string;
    mapFormat?: MapFormat;
    schemaId?: string;
    /** Local decoration, never sent back to mapget or included in metadata identity. */
    schemaStatus?: MapSchemaStatus;
    schemaMessage?: string;
    protocolVersion?: { major: number, minor: number, patch: number };
    addOn: boolean;
    status?: DataSourceCatalogStatus | string;
    statusMessage?: string;
    retrying?: boolean;
    progress?: number | null;
    configIndex?: number;
    type?: string;
}

/** Normalizes legacy and catalog-aware `/sources` entries into a known datasource state. */
export function dataSourceCatalogStatus(item: Pick<MapInfoItem, "status">): DataSourceCatalogStatus {
    return item.status === "initializing" || item.status === "failed"
        ? item.status
        : "ready";
}

/** Returns true when a `/sources` catalog entry can be used for tile and search requests. */
export function isDataSourceCatalogEntryReady(item: Pick<MapInfoItem, "status" | "schemaStatus">): boolean {
    return dataSourceReadinessStatus(item) === "ready";
}

/** Maps independent server and browser states to the map tree's availability indicator. */
export function dataSourceReadinessStatus(
    item: Pick<MapInfoItem, "status" | "schemaStatus">
): DataSourceCatalogStatus {
    const serverStatus = dataSourceCatalogStatus(item);
    if (serverStatus !== "ready") {
        return serverStatus;
    }
    if (item.schemaStatus === "loading") {
        return "initializing";
    }
    return item.schemaStatus === "failed" ? "failed" : "ready";
}

/** Normalizes optional datasource startup progress to a display percentage. */
export function dataSourceProgressPercent(item: Pick<MapInfoItem, "progress">): number | null {
    if (typeof item.progress !== "number" || !Number.isFinite(item.progress)) {
        return null;
    }
    const percent = item.progress <= 1
        ? item.progress * 100
        : item.progress;
    return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Sorts catalog snapshots in config order while keeping legacy entries stable at the end. */
export function sortDataSourceCatalogEntries(entries: MapInfoItem[]): MapInfoItem[] {
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((lhs, rhs) => {
            const lhsIndex = Number.isFinite(lhs.entry.configIndex)
                ? Number(lhs.entry.configIndex)
                : Number.MAX_SAFE_INTEGER;
            const rhsIndex = Number.isFinite(rhs.entry.configIndex)
                ? Number(rhs.entry.configIndex)
                : Number.MAX_SAFE_INTEGER;
            return lhsIndex - rhsIndex || lhs.index - rhs.index;
        })
        .map(({ entry }) => entry);
}
