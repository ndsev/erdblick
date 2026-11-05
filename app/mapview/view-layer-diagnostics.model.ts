/**
 * Read-only diagnostic snapshots of a view's current layer presentations.
 * Aggregation and display consume these values without constructing the service
 * that gathers them from live renderers.
 */
import type { PresentationKind } from "../mapdata/styled-mapget-layer.model";
export interface SubsetDiagnosticsTile {
    viewIndex: number;
    ownerId: string;
    presentationKind: PresentationKind;
    mapName: string;
    layerName: string;
    tileId: number | string;
    mapTileKey: string;
    conversionTimestampMs: number | null;
    ready: boolean;
    error: string | null;
    warnings: readonly string[];
    sourceFeatureCount: number | null;
    renderedEntryCount: number;
    stats: Map<string, number[]>;
}

export interface SubsetDiagnosticsError {
    viewIndex: number;
    ownerId: string;
    presentationKind: PresentationKind;
    mapName: string;
    layerName: string;
    mapTileKey: string;
    message: string;
}

export interface ViewLayerDiagnosticsSummary {
    expected: number;
    ready: number;
    errors: number;
    sourceFeatures: number;
    vertices: number;
}
