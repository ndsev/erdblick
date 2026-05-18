import {coreLib, initializeLibrary, uint8ArrayToWasm} from "../integrations/wasm";
import {TileFeatureLayer} from "../../build/libs/core/erdblick-core";

/**
 * Worker payload for evaluating a full search query against one tile and its overlays.
 */
export interface SearchWorkerTask {
    type: 'SearchWorkerTask';
    tileId: bigint;
    mapTileKey: string;
    dataVersion: number;
    tileBlobs: Uint8Array[];
    fieldDictBlob: Uint8Array;
    query: string;
    dataSourceInfo: Uint8Array;
    nodeId: string;
    taskId: string;
    groupId: string;
}

/**
 * Worker payload for generating completion candidates from one tile snapshot.
 */
export interface CompletionWorkerTask {
    type: 'CompletionWorkerTask';
    tileBlobs: Uint8Array[];
    fieldDictBlob: Uint8Array;
    dataSourceInfo: Uint8Array;
    query: string; // Query prefix to complete
    point: number; // Cursor position to complete at
    nodeId: string;
    limit: number | undefined;
    taskId: string;
    groupId: string;
}

/**
 * Encodes the optional spatial location attached to a search match.
 *
 * The worker returns both cartesian and cartographic forms so the main thread can
 * build overlays without re-reading the tile data.
 */
export interface SearchResultPosition {
    cartesian: {x: number, y: number, z: number},
    cartographic: {x: number, y: number, z: number} | null,
    cartographicRad: {longitude: number, latitude: number, height: number}
}

/**
 * Timing information emitted by the core search engine for one traced function.
 */
export interface TraceResult {
    name: string;
    calls: bigint;
    totalus: bigint;
    values: Array<string>;
}

/**
 * Human-facing query diagnostic emitted by simfil validation or execution.
 */
export interface DiagnosticsMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number},
    fix: null | string;
}

/**
 * Search result bundle returned for one tile.
 *
 * The main thread merges many of these structures into the result tree, marker overlays,
 * and diagnostics views.
 */
export interface SearchResultForTile {
    type: 'SearchResultForTile';
    tileId: bigint;
    mapTileKey: string;
    dataVersion: number;
    query: string;
    numFeatures: number;
    matches: Array<[string, string, SearchResultPosition]>;  // Array of (MapTileKey, FeatureId, SearchResultPosition)
    traces: Map<string, TraceResult> | null;
    diagnostics: Uint8Array | null;
    billboardPrimitiveIndices?: Array<number>;  // Used by search service for visualization.
    error: string | null;
    taskId?: string;
    groupId?: string;
}

/**
 * One autocompletion suggestion produced for the current query and cursor position.
 */
export interface CompletionCandidate {
    text: string;   /// The completion
    kind: string;   /// Type of the completion ("constant", "field", ...)
    begin: number;  /// Offset where to insert the completion
    end: number;    /// Length of the to be replaced input
    query: string;  /// Query with the completion applied
    source: string; /// Source query this candidate is for
    hint: string;   /// Extra information
}

/**
 * Completion candidates contributed by one tile.
 */
export interface CompletionCandidatesForTile {
    type: 'CompletionCandidatesForTile';
    query: string;
    candidates: CompletionCandidate[];
    taskId?: string;
    groupId?: string;
}

/**
 * Handshake request that asks a freshly created worker to report the loaded module URL.
 */
export interface WorkerInitMessage {
    type: 'WorkerInit';
}

/**
 * Handshake response used to clone the search worker script for additional workers.
 */
export interface WorkerReadyMessage {
    type: 'WorkerReady';
    scriptUrl: string;
}

export type WorkerTask = SearchWorkerTask | CompletionWorkerTask;
export type WorkerResult = SearchResultForTile | CompletionCandidatesForTile;
export type WorkerInboundMessage = WorkerTask | WorkerInitMessage;
export type WorkerOutboundMessage = WorkerResult | WorkerReadyMessage;

/**
 * Parses the base stage blob and attaches any overlay blobs to the same TileFeatureLayer.
 *
 * Search and completion work on the merged tile view so staged overlays behave the same way
 * they do in the renderer and inspection code.
 */
function parseTileWithOverlays(parser: any, tileBlobs: Uint8Array[]): TileFeatureLayer | null {
    if (!tileBlobs.length) {
        return null;
    }
    const baseTile: TileFeatureLayer | null = uint8ArrayToWasm(data => parser.readTileFeatureLayer(data), tileBlobs[0]);
    if (!baseTile) {
        return null;
    }
    try {
        for (let i = 1; i < tileBlobs.length; i++) {
            const overlay = uint8ArrayToWasm(data => parser.readTileFeatureLayer(data), tileBlobs[i]) as TileFeatureLayer | null;
            if (!overlay) {
                continue;
            }
            try {
                baseTile.attachOverlay(overlay);
            } finally {
                overlay.delete();
            }
        }
    } catch (error) {
        baseTile.delete();
        throw error;
    }
    return baseTile;
}

/**
 * Executes one search task and posts either matches or a serialized error back to the main thread.
 */
function processSearch(task: SearchWorkerTask) {
    let postError = (name: string, message: string) => {
        let result: SearchResultForTile = {
            type: 'SearchResultForTile',
            tileId: task.tileId,
            mapTileKey: task.mapTileKey,
            dataVersion: task.dataVersion,
            query: task.query,
            numFeatures: 0,
            matches: [],
            traces: null,
            diagnostics: null,
            error: `${name}: ${message}`,
            taskId: task.taskId,
            groupId: task.groupId
        };
        postMessage(result);
    }

    try {
        // Parse the tile.
        let parser = new coreLib.TileLayerParser();
        uint8ArrayToWasm(data => parser.setDataSourceInfo(data), task.dataSourceInfo);
        uint8ArrayToWasm(data => parser.addFieldDict(data), task.fieldDictBlob);
        let tile = parseTileWithOverlays(parser, task.tileBlobs);
        if (!tile) {
            throw new Error("No tile blobs provided for search task.");
        }
        const numFeatures = tile.numFeatures();
        const tileId = tile.tileId();

        // Get the query results from the tile.
        let search = new coreLib.FeatureLayerSearch(tile);
        const queryResult = search.filter(task.query);
        search.delete();
        tile.delete();

        if (queryResult["error"]) {
            postError("Error", queryResult.error);
        } else {
            // Post result back to the main thread.
            let result: SearchResultForTile = {
                type: 'SearchResultForTile',
                tileId: tileId,
                mapTileKey: task.mapTileKey,
                dataVersion: task.dataVersion,
                query: task.query,
                numFeatures: numFeatures,
                matches: queryResult.result,
                traces: queryResult.traces,
                diagnostics: queryResult.diagnostics,
                error: null,
                taskId: task.taskId,
                groupId: task.groupId
            };
            postMessage(result);
        }
    }
    catch (someException: any) {
        let error = someException as Error
        postError(error.name, error.message);
    }
}

/**
 * Executes one completion task and returns candidates for the current query prefix.
 *
 * Completion failures are logged but intentionally not surfaced as blocking UI errors.
 */
function processCompletion(task: CompletionWorkerTask) {
    try {
        // Parse the tile.
        let parser = new coreLib.TileLayerParser();
        uint8ArrayToWasm(data => parser.setDataSourceInfo(data), task.dataSourceInfo);
        uint8ArrayToWasm(data => parser.addFieldDict(data), task.fieldDictBlob);
        let tile = parseTileWithOverlays(parser, task.tileBlobs);
        if (!tile) {
            throw new Error("No tile blobs provided for completion task.");
        }

        // Get the query results from the tile.
        let search = new coreLib.FeatureLayerSearch(tile);

        let candidates = search.complete(task.query, task.point, {
            limit: task.limit,
        });
        search.delete();
        tile.delete();

        // We do not show completion errors.
        if (candidates["error"]) {
            console.error("Completion error", candidates["error"]);
            candidates = null;
        }

        // Post result back to the main thread.
        let result: CompletionCandidatesForTile = {
            type: 'CompletionCandidatesForTile',
            query: task.query,
            candidates: (candidates || []).map((item: any) => {
                return {
                    text: item.text,
                    begin: item.range[0],
                    end: item.range[1],
                    query: item.query,
                    source: task.query,
                    kind: item.type,
                    hint: item.hint,
                }
            }),
            taskId: task.taskId,
            groupId: task.groupId
        };
        postMessage(result);
    }
    catch (exc: any) {
        console.error("Completion error", exc);
    }
}

/**
 * Entry point shared by the worker handshake and the actual search/completion execution.
 */
addEventListener('message', async ({data}) => {
    const task = (data as WorkerInboundMessage);

    if (task?.type === 'WorkerInit') {
        postMessage({
            type: 'WorkerReady',
            scriptUrl: self.location.href
        } as WorkerReadyMessage);
        return;
    }

    await initializeLibrary();

    switch (task['type']) {
        case 'SearchWorkerTask':
            return processSearch(task as SearchWorkerTask);
        case 'CompletionWorkerTask':
            return processCompletion(task as CompletionWorkerTask);
    }
})
