import type {MapInfoItem} from "../mapdata/source-catalog.model";

/** Import formats only. Every accepted document and datasource is GeoJSON. */
export type DrawingFileKind = "coordinates" | "geojson";
export const EMPTY_DRAWING = '{"type":"FeatureCollection","features":[]}\n';

/** Native document metadata; geographic positions always use longitude/latitude order. */
export interface DrawingSummary {
    revision: number;
    rowCount: number;
    bounds: [number, number, number, number] | null;
    projectionLimited: boolean;
    joined: boolean;
    metadata: MapInfoItem;
}

/** A bounded page of native source rows, independent of mapget's property representation. */
export interface DrawingRow {
    id: string;
    featureId: string;
    ordinal: number;
    description: string;
    role: string;
    geometryType: string;
    longitude?: number;
    latitude?: number;
    heightCm?: number;
    position: [number, number, number?] | null;
    externalId?: string;
}

/** Worker operations carry explicit document identity; removal is never a network fallback. */
export type DrawingOperation =
    | {type: "convert-coordinates"; text: string}
    | {type: "create"; mapId: string; text: string; checkpoint?: string}
    | {type: "tool"; mapId: string; text: string; preview: boolean}
    | {type: "replace"; mapId: string; text: string}
    | {type: "description"; mapId: string; id: string; description: string}
    | {type: "append"; mapId: string; longitude: number; latitude: number; description: string}
    | {type: "join"; mapId: string; ids: string[]}
    | {type: "rows"; mapId: string; offset: number; count: number}
    | {type: "filter"; mapId: string; request: Record<string, unknown>}
    | {type: "snapshot"; mapId: string; ids: string[]}
    | {type: "remove"; mapId: string};

/** Transfer-owned outputs never contain native pointers or views into WASM memory. */
export interface DrawingReply {
    summary?: DrawingSummary;
    text?: string;
    rows?: DrawingRow[];
    bytes?: Uint8Array;
    schema?: Uint8Array;
    dictionary?: Uint8Array;
    revision?: number;
    checkpoint?: string;
}

export interface DrawingWorkerRequest {
    id: number;
    operation: DrawingOperation;
}
export interface DrawingWorkerResponse {
    id: number;
    result?: DrawingReply;
    error?: string;
}
