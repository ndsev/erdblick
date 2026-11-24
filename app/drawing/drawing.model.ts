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
    space?: "2d" | "3d";
    visible?: boolean;
    measurements?: DrawingMeasurements;
    kind?: DrawingAuthoring['kind'];
    vertexCount?: number;
    heightState?: 'absent' | 'present' | 'mixed';
}

/** Authoritative mutations can be prepared in the worker before their publication is authorized. */
export type DrawingMutation =
    | {type: "replace"; mapId: string; text: string}
    | {type: "description"; mapId: string; id: string; description: string}
    | {type: "append"; mapId: string; longitude: number; latitude: number; description: string}
    | {type: "join"; mapId: string; ids: string[]}
    | {type: "objects"; mapId: string; request: {revision: number; operations: DrawingObjectEdit[]}};

/** Worker operations carry explicit document identity; removal is never a network fallback. */
export type DrawingOperation =
    | DrawingMutation
    | {type: "compose"; sources: string[]; separate: boolean; ordinary?: boolean; collection?: {version: 1; id: string; name: string; layout: 'one' | 'separate'; members: {id: string; name: string}[]}}
    | {type: "convert-coordinates"; text: string}
    | {type: "create"; mapId: string; text: string; checkpoint?: string}
    | {type: "tool"; mapId: string; text: string; preview: boolean}
    | {type: "prepare"; mapId: string; operation: DrawingMutation}
    | {type: "commit"; mapId: string}
    | {type: "cancel"; mapId: string}
    | {type: "object"; mapId: string; id: string}
    | {type: "branch"; mapId: string; request: {id: string; path?: string; offset?: number; count?: number; revision?: number; editing?: boolean}}
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
    object?: DrawingObject;
    branch?: DrawingBranch;
    sources?: string[];
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

/** Authoring controls augment standard sampled GeoJSON; decorations never enter source. */
export type DrawingPosition = [number, number, number?];
export interface DrawingMeasurements {
    distances?: boolean; angles?: boolean; area?: boolean; perimeter?: boolean;
    ticks?: boolean; intervalMeters?: number; marker?: 'point' | 'tick';
}
export interface DrawingPlane {origin: DrawingPosition; u: [number, number, number]; v: [number, number, number];}
export interface DrawingAuthoring {
    version: 1; kind: 'point' | 'polyline' | 'polygon' | 'ellipse' | 'annotation' | 'ordinary';
    space: '2d' | '3d'; points?: DrawingPosition[]; curves?: Record<string, [DrawingPosition, DrawingPosition]>;
    plane?: DrawingPlane; text?: string; fontSize?: number; unit?: 'meters' | 'miles'; measurements?: DrawingMeasurements;
}
export interface DrawingFeature {
    type: 'Feature'; geometry: unknown; properties: Record<string, unknown> | null;
    'erdblick:drawing'?: DrawingAuthoring; 'erdblick:object'?: string;
    [key: string]: unknown;
}
export interface DrawingObject {
    id: string; revision: number; feature: DrawingFeature;
    presentation?: {bounds: [number, number, number, number] | null; projectionLimited: boolean};
    metrics: DrawingMetrics | null;
}

/** Unavailable is distinct from a genuine zero in every UI and integration surface. */
export interface DrawingMetrics {
    lengthMeters?: number | null; areaSquareMeters?: number | null; perimeterMeters?: number | null;
    anglesDegrees?: (number | null)[]; angleCount?: number; markerLimit?: boolean; warning?: string;
    availability?: Record<string, {available: boolean; reason?: string}>;
}

/** A branch descriptor carries exact JSON leaf text; expanding a branch never transfers its descendants. */
export interface DrawingValueNode {
    key: string; path: string; type: string; size?: number; text?: string; limited?: boolean;
}

/** Bounded native Quick-editor read with a small object summary only at the root. */
export interface DrawingBranch extends DrawingValueNode {
    id: string; revision: number; entries: DrawingValueNode[]; nextOffset: number | null;
    object?: DrawingObject; row?: DrawingRow; controlCount?: number; curveSegments?: string[]; curveCount?: number;
}

/** Capture mutations against a workspace and its exact accepted/raw document revisions. */
export interface DrawingWorkspaceTarget {
    workspaceId: string; workspaceRevision: number;
    members: {mapId: string; revision: number; draftRevision: number}[];
}
export type DrawingObjectEdit =
    | {type: 'insert'; feature: DrawingFeature}
    | {type: 'delete' | 'convert'; id: string}
    | {type: 'visibility'; id: string; visible: boolean}
    | {type: 'author'; id: string; value: Partial<DrawingAuthoring>}
    | {type: 'set'; id: string; path: string; value: unknown; preserveGeometry?: boolean}
    | {type: 'setExact'; id: string; path: string; text: string}
    | {type: 'height'; id: string; meters: number}
    | {type: 'curve'; id: string; index: number; enabled: boolean}
    | {type: 'remove'; id: string; path: string}
    | {type: 'insertVertex'; id: string; path: string; index: number; value?: DrawingPosition}
    | {type: 'deleteVertex'; id: string; path: string; index: number};

/** Unknown extension versions remain ordinary GeoJSON, including in the Quick editor. */
export function recognizedDrawingAuthoring(value: unknown): DrawingAuthoring | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const author = value as DrawingAuthoring;
    return author.version === 1 && ['point','annotation','polyline','polygon','ellipse','ordinary'].includes(author.kind) ? author : undefined;
}
