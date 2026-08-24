import {Injectable, OnDestroy} from "@angular/core";
import {debounceTime, skip, Subject, Subscription} from "rxjs";
import type {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {
    AppStateService,
    defaultHoverLabelFieldKey,
    type HoverLabelFieldConfig,
    type TileFeatureId
} from "../shared/appstate.service";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import type {ErdblickStyle} from "../styledata/style.service";
import type {SearchResultTileEntry} from "./map-runtime.model";
import {MapInfoService} from "./map-info.service";
import {MapTileStreamService} from "./map-tile-stream.service";
import type {MapgetLayer} from "./mapget-layer.model";
import {
    StyledMapgetLayer,
    type StyleFilterPlan,
    type StyledMapgetLayerEvent
} from "./styled-mapget-layer.model";
import {MAX_STYLE_LOD} from "../shared/lod-policy";

export type HoverDetailField = {key: string; value: string; colorKey: string};
export type HoverFeatureDetails = {
    featureId: string;
    showFeatureId: boolean;
    fields: HoverDetailField[];
};

const FEATURE_ID_EXPRESSION = "id";
const DECODED_TILE_CACHE_LIMIT = 16;

/**
 * Keeps scalar hover fields resident for visible feature tiles without adding
 * geometry or issuing requests in response to pointer movement.
 */
@Injectable({providedIn: "root"})
export class HoverDetailService implements OnDestroy {
    readonly valuesChanged = new Subject<string | null>();

    private readonly subscriptions = new Subscription();
    private readonly desiredCoverageByView = new Map<number, Array<{
        mapgetLayer: MapgetLayer;
        tileIds: readonly number[];
        priorityTileIds: readonly number[];
    }>>();
    private readonly layers = new Map<string, {
        layer: StyledMapgetLayer;
        subscription: Subscription;
    }>();
    private readonly decodedTiles = new Map<string, {
        valueVersion: number;
        valuesByFeatureId: Map<string, Map<string, unknown>>;
    }>();
    private syntheticStyle: ErdblickStyle | null = null;
    private enabled: boolean;
    private activeFields: HoverLabelFieldConfig[];

    /** Connects persisted field configuration to the proactive filter owners. */
    constructor(
        private readonly state: AppStateService,
        private readonly mapInfo: MapInfoService,
        private readonly tileStream: MapTileStreamService
    ) {
        this.enabled = this.state.hoverLabelsEnabled;
        this.activeFields = this.normalizeFields(this.state.hoverLabelFields);
        this.subscriptions.add(this.state.hoverLabelsEnabledState.pipe(
            skip(1)
        ).subscribe(enabled => {
            this.enabled = enabled;
            this.rebuildLayers();
            this.valuesChanged.next(null);
        }));
        this.subscriptions.add(this.state.hoverLabelFieldsState.pipe(
            skip(1),
            debounceTime(200)
        ).subscribe(fields => {
            this.activeFields = this.normalizeFields(fields);
            this.rebuildLayers();
            this.valuesChanged.next(null);
        }));
    }

    /** Reconciles visible coverage for one view while retaining scalar-only subset values. */
    reconcileView(
        viewIndex: number,
        coverage: ReadonlyArray<{
            mapgetLayer: MapgetLayer;
            tileIds: readonly number[];
            priorityTileIds: readonly number[];
        }>
    ): void {
        const previous = this.desiredCoverageByView.get(viewIndex);
        if (previous?.length === coverage.length &&
            previous.every((entry, index) =>
                entry.mapgetLayer === coverage[index].mapgetLayer &&
                entry.tileIds === coverage[index].tileIds &&
                entry.priorityTileIds ===
                    coverage[index].priorityTileIds)) {
            return;
        }
        this.desiredCoverageByView.set(viewIndex, coverage.map(entry => ({
            mapgetLayer: entry.mapgetLayer,
            tileIds: entry.tileIds,
            priorityTileIds: entry.priorityTileIds
        })));
        this.reconcileLayersForView(viewIndex);
    }

    /** Releases all proactive hover-detail demand owned by a destroyed view. */
    clearView(viewIndex: number): void {
        this.desiredCoverageByView.delete(viewIndex);
        for (const [key, owned] of [...this.layers]) {
            if (owned.layer.identity.viewIndex !== viewIndex) {
                continue;
            }
            this.layers.delete(key);
            this.disposeLayer(owned);
        }
    }

    /** Returns configured values already present in local subset blobs for the picked features. */
    detailsFor(
        viewIndex: number,
        featureIds: readonly (TileFeatureId | null)[]
    ): HoverFeatureDetails[] {
        if (!this.enabled) {
            return [];
        }
        const fields = this.activeFields;
        if (!fields.length) {
            return [];
        }
        const result: HoverFeatureDetails[] = [];
        const seen = new Set<string>();
        for (const target of featureIds) {
            if (!target) {
                continue;
            }
            const baseFeatureId = stripFeatureInspectionTarget(target.featureId);
            const identity = `${target.mapTileKey}\n${baseFeatureId}`;
            if (seen.has(identity)) {
                continue;
            }
            seen.add(identity);
            const parsed = this.tileStream.parseMapTileKeySafe(target.mapTileKey);
            const values = parsed
                ? this.valuesForFeature(
                    viewIndex,
                    parsed[0],
                    parsed[1],
                    parsed[2],
                    baseFeatureId
                )
                : undefined;
            const displayedFields = fields.flatMap(field => {
                const expression = field.expression.trim();
                if (expression === FEATURE_ID_EXPRESSION) {
                    return [];
                }
                const rawValue = values?.get(expression);
                const value = this.displayValue(rawValue);
                return value === null ? [] : [{
                    key: field.displayKey?.trim() ||
                        defaultHoverLabelFieldKey(expression),
                    value,
                    colorKey: expression
                }];
            });
            const showFeatureId = fields.some(field =>
                field.expression === FEATURE_ID_EXPRESSION
            );
            if (showFeatureId || displayedFields.length) {
                result.push({featureId: baseFeatureId, showFeatureId, fields: displayedFields});
            }
        }
        return result;
    }

    /** Releases filter subscriptions and the synthetic native style at application shutdown. */
    ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        for (const owned of this.layers.values()) {
            this.disposeLayer(owned);
        }
        this.layers.clear();
        this.decodedTiles.clear();
        this.syntheticStyle?.featureLayerStyle.delete?.();
        this.syntheticStyle = null;
        this.valuesChanged.complete();
    }

    /** Recreates all filter definitions after the ordered expression list changes. */
    private rebuildLayers(): void {
        for (const owned of this.layers.values()) {
            this.disposeLayer(owned);
        }
        this.layers.clear();
        this.decodedTiles.clear();
        for (const viewIndex of this.desiredCoverageByView.keys()) {
            this.reconcileLayersForView(viewIndex);
        }
    }

    /** Reconciles one view's configured projection against its latest visible coverage. */
    private reconcileLayersForView(viewIndex: number): void {
        const expressions = this.enabled ? this.projectedExpressions() : [];
        const desiredCoverage = expressions.length
            ? (this.desiredCoverageByView.get(viewIndex) ?? [])
            : [];
        const desiredKeys = new Set(desiredCoverage.map(entry =>
            this.layerKey(viewIndex, entry.mapgetLayer)));
        for (const [key, owned] of [...this.layers]) {
            if (owned.layer.identity.viewIndex !== viewIndex || desiredKeys.has(key)) {
                continue;
            }
            this.layers.delete(key);
            this.disposeLayer(owned);
        }
        for (const coverage of desiredCoverage) {
            const key = this.layerKey(viewIndex, coverage.mapgetLayer);
            let owned = this.layers.get(key);
            if (owned && owned.layer.mapgetLayer !== coverage.mapgetLayer) {
                this.layers.delete(key);
                this.disposeLayer(owned);
                owned = undefined;
            }
            if (!owned) {
                owned = this.createLayer(viewIndex, coverage.mapgetLayer, expressions);
                this.layers.set(key, owned);
            }
            owned.layer.setCoverage(
                coverage.tileIds,
                coverage.priorityTileIds
            );
        }
    }

    /** Creates one no-geometry feature projection for a visible map layer. */
    private createLayer(
        viewIndex: number,
        mapgetLayer: MapgetLayer,
        expressions: readonly string[]
    ): {layer: StyledMapgetLayer; subscription: Subscription} {
        const plan: StyleFilterPlan = {
            valid: true,
            channels: [{
                channelId: "hover-details:0",
                scope: "feature",
                rewrite: false,
                featureTypes: [],
                featureFields: [...expressions],
                entryFields: [],
                geometryTypes: 0
            }],
            issues: []
        };
        const layer = new StyledMapgetLayer(
            {
                viewIndex,
                mapId: mapgetLayer.mapId,
                layerId: mapgetLayer.layerId,
                presentationKind: "hover-details",
                presentationInstanceId: expressions.join("\u0000")
            },
            mapgetLayer,
            this.getSyntheticStyle(),
            {},
            this.mapInfo,
            this.tileStream,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            MAX_STYLE_LOD,
            plan
        );
        return {
            layer,
            subscription: layer.events.subscribe(event =>
                this.handleLayerEvent(layer, event))
        };
    }

    /** Invalidates decoded values and wakes a visible popover when subset data changes. */
    private handleLayerEvent(
        layer: StyledMapgetLayer,
        event: StyledMapgetLayerEvent
    ): void {
        if (event.type === "tiles-removed") {
            for (const state of event.states) {
                this.decodedTiles.delete(this.decodedTileKey(
                    layer,
                    state.tileId
                ));
            }
            this.valuesChanged.next(null);
            return;
        }
        if (event.type !== "tile-ready") {
            return;
        }
        this.decodedTiles.delete(this.decodedTileKey(layer, event.state.tileId));
        this.valuesChanged.next(event.state.mapTileKey);
    }

    /** Decodes one locally resident subset tile on first hover and reuses it nearby. */
    private valuesForFeature(
        viewIndex: number,
        mapId: string,
        layerId: string,
        tileId: number,
        featureId: string
    ): Map<string, unknown> | undefined {
        const owned = this.layers.get(this.layerIdentityKey(
            viewIndex,
            mapId,
            layerId
        ));
        const state = owned?.layer.tileStates.get(tileId);
        if (!owned || !state?.subsetBlob || state.status !== "ready") {
            return undefined;
        }
        const cacheKey = this.decodedTileKey(owned.layer, tileId);
        let cached = this.decodedTiles.get(cacheKey);
        if (!cached || cached.valueVersion !== state.valueVersion) {
            const valuesByFeatureId = this.decodeTile(
                state.subsetBlob,
                this.projectedExpressions()
            );
            if (!valuesByFeatureId) {
                return undefined;
            }
            cached = {valueVersion: state.valueVersion, valuesByFeatureId};
            this.decodedTiles.delete(cacheKey);
            this.decodedTiles.set(cacheKey, cached);
            while (this.decodedTiles.size > DECODED_TILE_CACHE_LIMIT) {
                const oldestKey = this.decodedTiles.keys().next().value as string;
                this.decodedTiles.delete(oldestKey);
            }
        } else {
            this.decodedTiles.delete(cacheKey);
            this.decodedTiles.set(cacheKey, cached);
        }
        return cached.valuesByFeatureId.get(featureId);
    }

    /** Converts one immutable TileSubsetLayer into feature-id keyed scalar values. */
    private decodeTile(
        blob: Uint8Array,
        expressions: readonly string[]
    ): Map<string, Map<string, unknown>> | null {
        const subset = uint8ArrayToWasm(
            data => this.mapInfo.tileLayerParser.readTileSubsetLayer(data),
            blob
        );
        if (!subset) {
            return null;
        }
        try {
            const schema = subset.channelSchema(0) as {
                featureFields: string[];
                entryCount: number;
            };
            const fieldIndices = expressions.map(expression =>
                schema.featureFields.indexOf(expression));
            const entryCount = Math.max(0, Math.floor(Number(schema.entryCount)));
            const valuesByFeatureId = new Map<string, Map<string, unknown>>();
            for (let offset = 0; offset < entryCount; offset += 1024) {
                const entries = subset.entryRange(
                    0,
                    offset,
                    Math.min(1024, entryCount - offset),
                    false
                ) as SearchResultTileEntry[];
                for (const entry of entries) {
                    const values = Array.isArray(entry.values) ? entry.values : [];
                    const byExpression = new Map<string, unknown>();
                    expressions.forEach((expression, index) => {
                        const fieldIndex = fieldIndices[index];
                        if (fieldIndex >= 0 && fieldIndex < values.length) {
                            byExpression.set(expression, values[fieldIndex]);
                        }
                    });
                    valuesByFeatureId.set(entry.featureId, byExpression);
                }
            }
            return valuesByFeatureId;
        } finally {
            subset.delete();
        }
    }

    /** Trims persisted expressions and excludes unfinished empty editor rows. */
    private normalizeFields(
        fields: readonly HoverLabelFieldConfig[]
    ): HoverLabelFieldConfig[] {
        return fields
            .map(field => ({
                ...field,
                expression: field.expression.trim(),
                displayKey: field.displayKey?.trim() || undefined
            }))
            .filter(field => field.expression.length > 0);
    }

    /** Returns unique expressions that need backend projection rather than intrinsic pick data. */
    private projectedExpressions(): string[] {
        return [...new Set(this.activeFields
            .map(field => field.expression)
            .filter(expression => expression !== FEATURE_ID_EXPRESSION))];
    }

    /** Produces the synthetic style object required by StyledMapgetLayer's presentation contract. */
    private getSyntheticStyle(): ErdblickStyle {
        if (this.syntheticStyle) {
            return this.syntheticStyle;
        }
        const source = JSON.stringify({
            name: "Internal/Hover Details",
            version: 2,
            rules: [{scope: "feature", geometry: ["point"], color: "#000000"}]
        });
        const featureLayerStyle = uint8ArrayToWasm(
            data => new coreLib.FeatureLayerStyle(data),
            new TextEncoder().encode(source)
        ) as FeatureLayerStyle;
        if (!featureLayerStyle?.isValid()) {
            const report = featureLayerStyle?.validationReport?.();
            featureLayerStyle?.delete?.();
            throw new Error(
                `Internal hover-detail style is invalid: ${JSON.stringify(report ?? {})}`
            );
        }
        const syntheticStyle: ErdblickStyle = {
            id: "internal:hover-details",
            modified: false,
            imported: false,
            additional: true,
            category: "base",
            source,
            featureLayerStyle,
            options: [],
            presets: [],
            shortId: "hover-details",
            visible: false,
            url: "",
            sourceRef: {styleName: "Internal/Hover Details", sourceKind: "editor"}
        };
        this.syntheticStyle = syntheticStyle;
        return syntheticStyle;
    }

    /** Formats projected scalar values without turning absent values into misleading text. */
    private displayValue(value: unknown): string | null {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === "string") {
            return value;
        }
        if (typeof value === "number" || typeof value === "boolean" ||
            typeof value === "bigint") {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    /** Builds the stable owner key used for one view/map/layer projection. */
    private layerKey(viewIndex: number, layer: MapgetLayer): string {
        return this.layerIdentityKey(viewIndex, layer.mapId, layer.layerId);
    }

    /** Encodes map and layer ids so slashes inside configured ids cannot collide. */
    private layerIdentityKey(
        viewIndex: number,
        mapId: string,
        layerId: string
    ): string {
        return [viewIndex, mapId, layerId]
            .map(value => encodeURIComponent(String(value)))
            .join("/");
    }

    /** Builds the small LRU key for one concrete subset generation. */
    private decodedTileKey(layer: StyledMapgetLayer, tileId: number): string {
        return `${layer.ownerId}/${tileId}`;
    }

    /** Releases one hidden layer and every decoded tile derived from it. */
    private disposeLayer(owned: {
        layer: StyledMapgetLayer;
        subscription: Subscription;
    }): void {
        owned.subscription.unsubscribe();
        owned.layer.dispose();
        const prefix = `${owned.layer.ownerId}/`;
        for (const key of [...this.decodedTiles.keys()]) {
            if (key.startsWith(prefix)) {
                this.decodedTiles.delete(key);
            }
        }
    }
}
