import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import {
    FeatureSearchTileRequest,
    SearchLayerTileSet
} from "./map-runtime.model";
import {SearchResultTile} from "./search-result-tile.model";
import {FeatureSearchMapLayerRef, FeatureSearchStateEntry} from "../shared/feature-search-state";

export type FeatureSearchScopeResolver = (definition: FeatureSearchStateEntry) => "feature" | "attribute";

/** Extracts server-side result-field expressions needed by search-result styling. */
export function featureSearchResultFields(
    definition: FeatureSearchStateEntry,
    resolveScope: FeatureSearchScopeResolver
): string[] {
    const fields = new Set<string>();
    if (resolveScope(definition) === "attribute") {
        fields.add("$name");
    }
    for (const rule of definition.searchStyleRules ?? []) {
        for (const filter of rule.filter ?? []) {
            if (filter.field?.trim()) {
                fields.add(filter.field.trim());
            }
        }
        const color = rule.color;
        if ((color.mode === "gradient" || color.mode === "categories") && color.field.trim()) {
            fields.add(color.field.trim());
        }
    }
    return Array.from(fields).sort();
}

function selectedLayerKey(ref: FeatureSearchMapLayerRef): string {
    return FeatureSearchRuntimeState.layerKey(ref.mapId, ref.layerId);
}

function normalizedSelectedLayerRefs(definition: FeatureSearchStateEntry): FeatureSearchMapLayerRef[] {
    return [...definition.selectedMapLayers]
        .filter(ref => !!ref.mapId && !!ref.layerId)
        .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
}

/** Runtime state for one logical server-side feature search. */
export class FeatureSearchRuntimeState {
    readonly searchId: string;
    readonly tilesBySourceKey = new Map<string, SearchResultTile>();
    definition: FeatureSearchStateEntry;
    refresh = 0;

    private definitionFingerprint = "";
    private lastUpdateSerial: number | undefined;
    private updateSerial = 0;
    private generationSerial = 0;
    private hasAdoptedVisibleTiles = false;

    constructor(
        definition: FeatureSearchStateEntry,
        private readonly parser: TileLayerParser
    ) {
        this.searchId = definition.id;
        this.definition = definition;
    }

    /** Applies a normalized persisted definition and returns tiles invalidated by a new backend generation. */
    applyDefinition(
        definition: FeatureSearchStateEntry,
        resolveScope: FeatureSearchScopeResolver,
        forceGeneration = false
    ): SearchResultTile[] {
        this.definition = definition;
        if (forceGeneration) {
            this.generationSerial += 1;
        }
        const fingerprint = this.buildDefinitionFingerprint(resolveScope);
        if (fingerprint === this.definitionFingerprint) {
            return [];
        }
        this.definitionFingerprint = fingerprint;
        this.refresh += 1;
        this.lastUpdateSerial = undefined;
        this.hasAdoptedVisibleTiles = false;
        return this.clearTiles();
    }

    /** Returns all concrete source layer keys represented by this search's current tile coverage. */
    layerKeys(): Set<string> {
        const result = new Set<string>();
        for (const tile of this.tilesBySourceKey.values()) {
            result.add(FeatureSearchRuntimeState.layerKey(tile.sourceMapId, tile.sourceLayerId));
        }
        return result;
    }

    /** Returns whether the source map/layer is selected for this search. */
    acceptsLayer(mapId: string, layerId: string): boolean {
        const selectedRefs = normalizedSelectedLayerRefs(this.definition);
        const key = FeatureSearchRuntimeState.layerKey(mapId, layerId);
        return selectedRefs.some(ref => selectedLayerKey(ref) === key);
    }

    /** Filters global visible source-tile coverage down to this search's selected layers. */
    filterVisibleLayerTiles(visibleLayerTiles: Map<string, SearchLayerTileSet>): Map<string, SearchLayerTileSet> {
        const selectedRefs = normalizedSelectedLayerRefs(this.definition);
        const selectedKeys = new Set(selectedRefs.map(selectedLayerKey));
        const filtered = new Map<string, SearchLayerTileSet>();
        for (const [key, entry] of visibleLayerTiles) {
            if (selectedKeys.has(key)) {
                filtered.set(key, entry);
            }
        }
        return filtered;
    }

    /** Returns whether the current visible tile set should replace this search's desired coverage. */
    shouldAdoptVisibleTiles(): boolean {
        return this.definition.autoUpdate
            || this.lastUpdateSerial !== this.updateSerial
            || !this.hasAdoptedVisibleTiles;
    }

    /** Requests a differential refresh over the current visible tile coverage. */
    requestCoverageUpdate(): void {
        this.updateSerial += 1;
    }

    /** Replaces desired tile coverage and returns tiles evicted from the search area. */
    adoptVisibleTiles(visibleLayerTiles: Map<string, SearchLayerTileSet>): SearchResultTile[] {
        const removedTiles: SearchResultTile[] = [];
        const desiredKeys = new Set<string>();
        for (const entry of visibleLayerTiles.values()) {
            for (const tileId of entry.tileIds) {
                const sourceTileId = BigInt(tileId);
                const sourceTileKey = coreLib.getTileFeatureLayerKey(entry.mapId, entry.layerId, sourceTileId);
                desiredKeys.add(sourceTileKey);
                const priority = entry.priorityTileIds.has(tileId);
                const existing = this.tilesBySourceKey.get(sourceTileKey);
                if (existing && existing.refresh === this.refresh) {
                    existing.priority = priority;
                    continue;
                }
                if (existing) {
                    this.tilesBySourceKey.delete(sourceTileKey);
                    removedTiles.push(existing);
                }
                this.tilesBySourceKey.set(sourceTileKey, new SearchResultTile(
                    this.parser,
                    this.searchId,
                    sourceTileKey,
                    entry.mapId,
                    entry.layerId,
                    sourceTileId,
                    this.refresh,
                    priority
                ));
            }
        }

        for (const [sourceTileKey, tile] of Array.from(this.tilesBySourceKey.entries())) {
            if (!desiredKeys.has(sourceTileKey)) {
                this.tilesBySourceKey.delete(sourceTileKey);
                removedTiles.push(tile);
            }
        }
        this.lastUpdateSerial = this.updateSerial;
        this.hasAdoptedVisibleTiles = true;
        return removedTiles;
    }

    /** Keeps completed results but makes unfinished tiles eligible for another request. */
    markPendingTilesForResume(): void {
        for (const tile of this.tilesBySourceKey.values()) {
            tile.markPending();
        }
    }

    /** Accepts one streamed result layer into the matching source tile. */
    acceptResultTile(
        refresh: number,
        sourceTileKey: string,
        nodeId: string,
        layerBlob: Uint8Array,
        resultCount: number
    ): SearchResultTile | null {
        if (refresh !== this.refresh) {
            return null;
        }
        const tile = this.tilesBySourceKey.get(sourceTileKey);
        if (!tile) {
            return null;
        }
        if (resultCount <= 0) {
            tile.markCompletedEmpty(refresh);
            return tile;
        }
        tile.update({refresh, nodeId, layerBlob, resultCount});
        return tile;
    }

    /** Returns current full-coverage progress, independent from the latest differential backend request. */
    progressSnapshot(): {tilesConsidered: number; tilesCompleted: number} {
        let tilesCompleted = 0;
        for (const tile of this.tilesBySourceKey.values()) {
            if (tile.completed) {
                tilesCompleted += 1;
            }
        }
        return {tilesConsidered: this.tilesBySourceKey.size, tilesCompleted};
    }

    /** Groups incomplete source tiles into concrete backend search requests. */
    buildPendingRequests(resolveScope: FeatureSearchScopeResolver): FeatureSearchTileRequest[] {
        const statesByLevelLayer = new Map<string, {mapId: string; layerId: string; tileIds: number[]; priorityTileIds: number[]}>();
        for (const tile of this.tilesBySourceKey.values()) {
            if (tile.completed) {
                continue;
            }
            const tileId = Number(tile.sourceTileId);
            const tileLevel = Math.trunc(tileId % 0x10000);
            const key = `${tile.sourceMapId}/${tile.sourceLayerId}/${tileLevel}`;
            let entry = statesByLevelLayer.get(key);
            if (!entry) {
                entry = {mapId: tile.sourceMapId, layerId: tile.sourceLayerId, tileIds: [], priorityTileIds: []};
                statesByLevelLayer.set(key, entry);
            }
            entry.tileIds.push(tileId);
            if (tile.priority) {
                entry.priorityTileIds.push(tileId);
            }
            tile.requested = true;
        }

        return Array.from(statesByLevelLayer.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId))
            .map(entry => {
                entry.tileIds.sort((lhs, rhs) => lhs - rhs);
                entry.priorityTileIds.sort((lhs, rhs) => lhs - rhs);
                return this.createTileRequest(
                    this.definition,
                    entry.mapId,
                    entry.layerId,
                    entry.tileIds,
                    entry.priorityTileIds,
                    this.refresh,
                    resolveScope
                );
            });
    }

    /** Creates empty tile requests that cancel or pause a server-side search on previous layers. */
    cancellationRequests(
        layerKeys: Iterable<string>,
        refresh: number,
        resolveScope: FeatureSearchScopeResolver
    ): FeatureSearchTileRequest[] {
        const cancellations: FeatureSearchTileRequest[] = [];
        for (const layerKey of layerKeys) {
            const parsed = FeatureSearchRuntimeState.parseLayerKey(layerKey);
            if (!parsed) {
                continue;
            }
            cancellations.push(this.createTileRequest(
                this.definition,
                parsed.mapId,
                parsed.layerId,
                [],
                [],
                refresh,
                resolveScope
            ));
        }
        return cancellations;
    }

    /** Clears all source tile state for this search and returns the removed tiles. */
    clearTiles(): SearchResultTile[] {
        const removed = Array.from(this.tilesBySourceKey.values());
        this.tilesBySourceKey.clear();
        return removed;
    }

    /** Encodes map/layer ids without relying on slash splitting, since map ids may be grouped paths. */
    static layerKey(mapId: string, layerId: string): string {
        return JSON.stringify([mapId, layerId]);
    }

    /** Decodes a key produced by layerKey(). */
    static parseLayerKey(key: string): {mapId: string; layerId: string} | null {
        try {
            const parsed = JSON.parse(key);
            if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
                return {mapId: parsed[0], layerId: parsed[1]};
            }
        } catch (_error) {
            // Ignore malformed legacy keys.
        }
        return null;
    }

    /** Builds the stable logical-search fingerprint that owns the backend refresh generation. */
    private buildDefinitionFingerprint(resolveScope: FeatureSearchScopeResolver): string {
        return JSON.stringify({
            searchId: this.definition.id,
            generationSerial: this.generationSerial,
            query: this.definition.query,
            scope: resolveScope(this.definition),
            selectedMapLayers: normalizedSelectedLayerRefs(this.definition),
            withFields: featureSearchResultFields(this.definition, resolveScope)
        });
    }

    /** Builds one concrete mapget search request object for a map/layer tile set. */
    private createTileRequest(
        request: FeatureSearchStateEntry,
        mapId: string,
        layerId: string,
        tileIds: number[],
        priorityTileIds: number[],
        refresh: number,
        resolveScope: FeatureSearchScopeResolver
    ): FeatureSearchTileRequest {
        const result: FeatureSearchTileRequest = {
            mapId,
            layerId,
            tileIds,
            searchId: request.id,
            refresh,
            searchQuery: request.query,
            searchScope: resolveScope(request),
        };
        if (priorityTileIds.length) {
            result.priorityTileIds = priorityTileIds;
        }
        const withFields = featureSearchResultFields(request, resolveScope);
        if (withFields.length) {
            result.withFields = withFields;
        }
        return result;
    }
}
