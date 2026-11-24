import type {RenderRectangle} from "../mapview/render-view.model";
import {spatialExtentEnvelope} from "../mapview/spatial-extent-bounds.util";
import type {SpatialExtentBounds} from "./spatial-extent.model";

/** Exact metadata and display levels captured when one Focus control is activated. */
export interface SpatialExtentFocusTarget {
    viewId: string;
    mapId: string;
    layerId?: string;
    generation: number;
    layers: Array<{layerId: string; level: number}>;
}

/** Retain only the latest small navigation result per target, never its region arrays. */
export class SpatialExtentFocus {
    private readonly entries = new Map<string, {
        viewId: string;
        mapId: string;
        signature: string;
        rectangle: RenderRectangle | null;
    }>();

    /** Geometry reads are borrowed synchronously and occur only on explicit activation. */
    constructor(private readonly bounds: (mapId: string, layerId: string, level: number) => SpatialExtentBounds[]) {}

    /** Fit original intervals together so independent layer envelopes cannot hide a dateline gap. */
    rectangle(target: SpatialExtentFocusTarget): RenderRectangle | null {
        const key = JSON.stringify([target.viewId, target.mapId, target.layerId ?? null]);
        const signature = JSON.stringify([target.generation, target.layers]);
        let entry = this.entries.get(key);
        if (!entry || entry.signature !== signature) {
            const bounds = target.layers.flatMap(layer => this.bounds(target.mapId, layer.layerId, layer.level));
            entry = {viewId: target.viewId, mapId: target.mapId, signature, rectangle: spatialExtentEnvelope(bounds)};
            this.entries.set(key, entry);
        }
        return entry.rectangle ? {...entry.rectangle} : null;
    }

    /** Retired generations must disappear even before a replacement becomes ready. */
    invalidateMaps(mapIds: readonly string[]): void {
        const removed = new Set(mapIds);
        for (const [key, entry] of this.entries) if (removed.has(entry.mapId)) this.entries.delete(key);
    }

    /** Logical view identities survive reordering, but removed views release their cache. */
    retainViews(viewIds: readonly string[]): void {
        const retained = new Set(viewIds);
        for (const [key, entry] of this.entries) if (!retained.has(entry.viewId)) this.entries.delete(key);
    }

    /** Release panel-owned results with the component. */
    clear(): void { this.entries.clear(); }
}
