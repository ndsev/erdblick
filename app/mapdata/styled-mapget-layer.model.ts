import {Subject} from "rxjs";
import type {
    FeatureLayerStyle,
    HighlightMode,
    RuleFidelity
} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import type {ErdblickStyle} from "../styledata/style.service";
import {sipHash64Hex} from "../styledata/hash";
import type {MapgetLayer} from "./mapget-layer.model";
import type {MapInfoService} from "./map-info.service";
import type {MapTileStreamService} from "./map-tile-stream.service";
import {
    FilterSubscriptionCoverage,
    FilterSubscriptionDefinition,
    FilterSubscriptionRef,
    TileAttachmentRef,
    filterSubscriptionCoverageEqual,
    type FilterChannelDefinition,
    type FilterTileInstallResult,
    type TileSubsetDelivery
} from "./filter-subscription.model";
import {
    FilterTileState
} from "./filter-tile-state.model";
import type {MapTileStreamFilterStatusPayload} from "./tilestream";

export type PresentationKind =
    | "regular"
    | "search"
    | "hover"
    | "selection"
    | "hover-details";

export interface StyledMapgetLayerIdentity {
    viewIndex: number;
    mapId: string;
    layerId: string;
    presentationKind: PresentationKind;
    presentationInstanceId: string;
}

export interface StyleFilterPlanIssue {
    ruleIndex: number;
    message: string;
}

export interface StyleFilterPlan {
    valid: boolean;
    channels: FilterChannelDefinition[];
    issues: StyleFilterPlanIssue[];
}

export type StyledMapgetLayerEvent =
    | {type: "tile-ready"; state: FilterTileState}
    | {type: "tiles-pending"; states: readonly FilterTileState[]}
    | {type: "tiles-removed"; states: readonly FilterTileState[]}
    | {type: "generation"; generation: number}
    | {type: "status"; status: MapTileStreamFilterStatusPayload}
    | {type: "error"; message: string};

/**
 * View-scoped aggregate for one mapget layer and one presentation.
 *
 * It owns filter demand and every delivered subset directly. It deliberately
 * exposes no cache lookup or hydration API to other styled layers.
 */
export class StyledMapgetLayer {
    readonly ownerId: string;
    readonly renderStyleKey: string;
    readonly events = new Subject<StyledMapgetLayerEvent>();
    readonly tileStates = new Map<number, FilterTileState>();
    readonly filterPlan: StyleFilterPlan;
    readonly filterRef: FilterSubscriptionRef;
    latestStatus: MapTileStreamFilterStatusPayload | null = null;
    styleOrder = 0;
    private coverage: FilterSubscriptionCoverage = {tileIds: []};
    private coverageVersionValue = 0;
    private disposed = false;
    private options: Record<string, boolean | number | string>;
    private readonly retiredTileStates = new Map<number, FilterTileState>();
    private readonly tileStatePresentationRefs =
        new Map<FilterTileState, number>();

    /** Create one filter subscription whose deliveries are owned by this presentation. */
    constructor(
        readonly identity: StyledMapgetLayerIdentity,
        readonly mapgetLayer: MapgetLayer,
        readonly style: ErdblickStyle,
        options: Record<string, boolean | number | string>,
        readonly mapInfo: MapInfoService,
        private readonly tileStream: MapTileStreamService,
        readonly highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
        readonly plannedFidelity: RuleFidelity = coreLib.RuleFidelity.ANY,
        filterPlan?: StyleFilterPlan
    ) {
        this.ownerId = [
            identity.viewIndex,
            identity.mapId,
            identity.layerId,
            identity.presentationKind,
            identity.presentationInstanceId
        ].map(value => encodeURIComponent(String(value))).join("/");
        this.renderStyleKey = [
            style.sourceRef.sourceHash ?? sipHash64Hex(style.source),
            style.source.length
        ].join(":");
        this.options = {...options};
        this.filterPlan = filterPlan
            ? structuredClone(filterPlan)
            : this.plan(style.featureLayerStyle, highlightMode, plannedFidelity);
        if (!this.filterPlan.valid) {
            const detail = this.filterPlan.issues.map(issue =>
                `rule ${issue.ruleIndex}: ${issue.message}`
            ).join("; ");
            throw new Error(`Cannot plan '${style.id}' for '${mapgetLayer.key}': ${detail}`);
        }
        this.filterRef = tileStream.createFilterSubscription(
            this.filterDefinition(),
            this.coverage,
            {
                onTile: (delivery, remainsPending) =>
                    this.acceptTile(delivery, remainsPending),
                onTilesPending: (tileIds, generation) =>
                    this.markTilesPending(tileIds, generation),
                onStatus: status => this.acceptStatus(status),
                onError: message => this.acceptError(message),
                onRequestSynchronized: () => this.disposeRetiredTileStates()
            },
            `styled:${this.ownerId}`
        );
    }

    get generation(): number {
        return this.filterRef.generation;
    }

    get featureLayerStyle(): FeatureLayerStyle {
        return this.style.featureLayerStyle;
    }

    get resolvedOptions(): Readonly<Record<string, boolean | number | string>> {
        return this.options;
    }

    /** Monotonic exact-coverage version used by view-local reconciliation. */
    get coverageVersion(): number {
        return this.coverageVersionValue;
    }

    /** Replace exact tile demand while retaining ready values through transport handover. */
    setCoverage(
        tileIds: readonly number[],
        priorityTileIds: readonly number[] = [],
        roots: FilterSubscriptionCoverage["roots"] = undefined
    ): void {
        this.assertLive();
        const orderedTileIds = [...tileIds].map(Number);
        const nextCoverage: FilterSubscriptionCoverage = {
            tileIds: orderedTileIds,
            ...(priorityTileIds.length ? {priorityTileIds: [...priorityTileIds]} : {}),
            ...(roots?.length ? {roots: structuredClone(roots)} : {})
        };
        if (filterSubscriptionCoverageEqual(
            nextCoverage,
            this.coverage
        )) {
            return;
        }
        const demanded = new Set(orderedTileIds);
        const removedStates: FilterTileState[] = [];
        for (const [tileId, state] of this.tileStates) {
            if (demanded.has(tileId)) {
                continue;
            }
            this.tileStates.delete(tileId);
            removedStates.push(state);
            if (this.filterRef.suspended &&
                !this.tileStatePresentationRefs.has(state)) {
                state.dispose();
            } else {
                this.retiredTileStates.set(tileId, state);
            }
        }
        if (removedStates.length) {
            this.events.next({type: "tiles-removed", states: removedStates});
        }
        this.coverage = nextCoverage;
        this.coverageVersionValue += 1;
        const previousGeneration = this.generation;
        this.filterRef.setCoverage(nextCoverage);
        if (this.generation !== previousGeneration) {
            this.disposeRetiredTileStates();
        }
        for (const tileId of orderedTileIds) {
            let state = this.tileStates.get(tileId);
            let restored = false;
            if (!state) {
                state = this.retiredTileStates.get(tileId);
                if (state) {
                    this.retiredTileStates.delete(tileId);
                    restored = true;
                } else {
                    const mapTileKey = coreLib.getTileFeatureLayerKey(
                        this.mapgetLayer.mapId,
                        this.mapgetLayer.layerId,
                        tileId
                    );
                    state = new FilterTileState(
                        this.mapgetLayer.mapId,
                        this.mapgetLayer.layerId,
                        tileId,
                        mapTileKey,
                        this.generation
                    );
                }
                this.tileStates.set(tileId, state);
            }
            if (this.filterRef.isPending(tileId)) {
                state.markPending(this.generation);
            }
            if (restored && state.status === "ready") {
                this.events.next({type: "tile-ready", state});
            }
        }
        if (this.generation !== previousGeneration) {
            this.events.next({type: "generation", generation: this.generation});
        }
    }

    /** Restart filtering only when resolved style bindings materially change. */
    setOptions(options: Record<string, boolean | number | string>): void {
        this.assertLive();
        const normalized = {...options};
        const keys = Object.keys(normalized);
        if (keys.length === Object.keys(this.options).length &&
            keys.every(key => normalized[key] === this.options[key])) {
            return;
        }
        this.disposeRetiredTileStates();
        this.options = normalized;
        this.filterRef.replace(this.filterDefinition(), this.coverage);
        for (const state of this.tileStates.values()) {
            state.markPending(this.generation);
        }
        this.events.next({type: "generation", generation: this.generation});
    }

    /** Pause backend demand without discarding the last complete presentation. */
    setSuspended(suspended: boolean): void {
        this.assertLive();
        if (suspended) {
            this.disposeRetiredTileStates();
            this.filterRef.suspend();
        } else {
            this.filterRef.resume();
        }
    }

    /** Re-evaluate the unchanged definition and coverage as a fresh generation. */
    refresh(): void {
        this.assertLive();
        this.disposeRetiredTileStates();
        this.filterRef.refresh();
        for (const state of this.tileStates.values()) {
            state.markPending(this.generation);
        }
        this.events.next({type: "generation", generation: this.generation});
    }

    /** Creates one independently releasable presentation ref for a tile attachment. */
    retainAttachment(state: FilterTileState, name: string): TileAttachmentRef {
        this.assertLive();
        return this.tileStream.retainTileAttachment({
            sourceId: this.mapgetLayer.sourceId,
            mapId: this.mapgetLayer.mapId,
            layerId: this.mapgetLayer.layerId,
            tileId: state.tileId,
            name,
            incarnation: state.valueVersion
        });
    }

    /**
     * Pins immutable subset bytes while an in-flight visualization owns them.
     */
    retainTileState(state: FilterTileState): void {
        this.assertLive();
        this.tileStatePresentationRefs.set(
            state,
            (this.tileStatePresentationRefs.get(state) ?? 0) + 1
        );
    }

    /** Releases one presentation pin and eagerly drops an off-coverage value. */
    releaseTileState(state: FilterTileState): void {
        const count = this.tileStatePresentationRefs.get(state) ?? 0;
        if (count <= 1) {
            this.tileStatePresentationRefs.delete(state);
            if (this.retiredTileStates.get(state.tileId) === state) {
                this.retiredTileStates.delete(state.tileId);
                state.dispose();
            }
            return;
        }
        this.tileStatePresentationRefs.set(state, count - 1);
    }

    /** Release transport ownership and every retained current or retired tile value. */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.filterRef.release();
        const removedStates = [...this.tileStates.values()];
        if (removedStates.length) {
            this.events.next({type: "tiles-removed", states: removedStates});
        }
        for (const state of removedStates) {
            state.dispose();
        }
        this.tileStates.clear();
        for (const state of this.retiredTileStates.values()) {
            state.dispose();
        }
        this.retiredTileStates.clear();
        this.tileStatePresentationRefs.clear();
        this.events.complete();
    }

    /** Ask WASM to translate style semantics into server-side filter channels. */
    private plan(
        style: FeatureLayerStyle,
        highlightMode: HighlightMode,
        fidelity: RuleFidelity
    ): StyleFilterPlan {
        return this.mapInfo.planStyleFilter(
            style,
            this.mapgetLayer.mapId,
            this.mapgetLayer.layerId,
            highlightMode.value,
            fidelity.value
        ) as StyleFilterPlan;
    }

    /** Materialize the immutable filter definition from the validated plan. */
    private filterDefinition(): FilterSubscriptionDefinition {
        return {
            mapId: this.mapgetLayer.mapId,
            layerId: this.mapgetLayer.layerId,
            ...(this.mapgetLayer.sourceId
                ? {sourceId: this.mapgetLayer.sourceId}
                : {}),
            channels: this.filterPlan.channels,
            bindings: {...this.options}
        };
    }

    /** Install a delivery only when its generation and tile are still demanded. */
    private acceptTile(
        delivery: TileSubsetDelivery,
        remainsPending: boolean
    ): FilterTileInstallResult {
        if (this.disposed || delivery.generation !== this.generation) {
            return {status: "superseded"};
        }
        const state = this.tileStates.get(delivery.tileId);
        if (!state) {
            return {status: "superseded"};
        }
        if (!state.install(delivery, remainsPending)) {
            return {status: "superseded"};
        }
        const valueVersion = state.valueVersion;
        try {
            this.events.next({type: "tile-ready", state});
        } catch (error) {
            // Immutable-byte installation is the acceptance boundary.
            // Presentation observers run downstream and cannot roll it back.
            console.error("Subset presentation observer failed.", error);
        }
        return {status: "accepted", valueVersion};
    }

    /** Mark retained values stale while their ordinary replacement is pending. */
    private markTilesPending(
        tileIds: readonly number[],
        generation: number
    ): void {
        if (this.disposed || generation !== this.generation) {
            return;
        }
        const states = tileIds.flatMap(tileId => {
            const state = this.tileStates.get(tileId);
            if (!state) {
                return [];
            }
            state.markPending(generation);
            return [state];
        });
        if (states.length) {
            this.events.next({type: "tiles-pending", states});
        }
    }

    /** Forward backend completion and convert status errors into tile failures. */
    private acceptStatus(status: MapTileStreamFilterStatusPayload): void {
        this.latestStatus = status;
        this.events.next({type: "status", status});
        if (status.error) {
            this.acceptError(status.error);
        }
    }

    /** Mark all current outputs failed without discarding their last ready bytes. */
    private acceptError(message: string): void {
        for (const state of this.tileStates.values()) {
            state.fail(this.generation, message);
        }
        this.events.next({type: "error", message});
    }

    /** Releases values removed from presentation coverage once transport state agrees. */
    private disposeRetiredTileStates(): void {
        for (const [tileId, state] of [...this.retiredTileStates]) {
            if (this.tileStatePresentationRefs.has(state)) {
                continue;
            }
            state.dispose();
            this.retiredTileStates.delete(tileId);
        }
    }

    /** Fail fast when stale reconciliation code touches a retired owner. */
    private assertLive(): void {
        if (this.disposed) {
            throw new Error(`StyledMapgetLayer '${this.ownerId}' is disposed.`);
        }
    }
}
