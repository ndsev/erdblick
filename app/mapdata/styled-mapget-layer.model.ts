import {Subject} from "rxjs";
import type {
    FeatureLayerStyle,
    HighlightMode,
    RuleFidelity
} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import type {ErdblickStyle} from "../styledata/style.service";
import type {MapgetLayer} from "./mapget-layer.model";
import type {MapInfoService} from "./map-info.service";
import type {MapTileStreamService} from "./map-tile-stream.service";
import {
    FilterSubscriptionCoverage,
    FilterSubscriptionDefinition,
    FilterSubscriptionRef,
    TileAttachmentRef,
    type FilterChannelDefinition,
    type TileSubsetDelivery
} from "./filter-subscription.model";
import {
    FilterTileState
} from "./filter-tile-state.model";
import type {MapTileStreamFilterStatusPayload} from "./tilestream";

export type PresentationKind = "regular" | "search" | "hover" | "selection";

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
    | {type: "tile-removed"; state: FilterTileState}
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
    readonly events = new Subject<StyledMapgetLayerEvent>();
    readonly tileStates = new Map<number, FilterTileState>();
    readonly filterPlan: StyleFilterPlan;
    readonly filterRef: FilterSubscriptionRef;
    latestStatus: MapTileStreamFilterStatusPayload | null = null;
    styleOrder = 0;
    private coverage: FilterSubscriptionCoverage = {tileIds: []};
    private disposed = false;
    private options: Record<string, boolean | number | string>;
    private readonly retiredTileStates = new Map<number, FilterTileState>();
    private readonly tileStatePresentationRefs =
        new Map<FilterTileState, number>();
    private readonly attachmentRefs = new Map<number, {
        name: string;
        ref: TileAttachmentRef;
    }>();

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
                onTile: delivery => this.acceptTile(delivery),
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
        if (JSON.stringify(nextCoverage) === JSON.stringify(this.coverage)) {
            return;
        }
        const demanded = new Set(orderedTileIds);
        for (const [tileId, state] of this.tileStates) {
            if (demanded.has(tileId)) {
                continue;
            }
            this.tileStates.delete(tileId);
            this.events.next({type: "tile-removed", state});
            this.releaseAttachment(tileId);
            if (this.filterRef.suspended &&
                !this.tileStatePresentationRefs.has(state)) {
                state.dispose();
            } else {
                this.retiredTileStates.set(tileId, state);
            }
        }
        this.coverage = nextCoverage;
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
            if (restored && state.status === "ready") {
                this.events.next({type: "tile-ready", state});
            } else if (!restored &&
                       (this.generation !== previousGeneration ||
                        state.status !== "ready")) {
                state.markPending(this.generation);
            }
        }
        if (this.generation !== previousGeneration) {
            this.events.next({type: "generation", generation: this.generation});
        }
    }

    setOptions(options: Record<string, boolean | number | string>): void {
        this.assertLive();
        const normalized = {...options};
        if (JSON.stringify(normalized) === JSON.stringify(this.options)) {
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

    /** Retains one tile attachment as presentation state, replacing any prior name. */
    retainAttachment(state: FilterTileState, name: string): TileAttachmentRef {
        this.assertLive();
        const existing = this.attachmentRefs.get(state.tileId);
        if (existing?.name === name && existing.ref.state !== "released") {
            return existing.ref;
        }
        existing?.ref.release();
        const ref = this.tileStream.retainTileAttachment({
            sourceId: this.mapgetLayer.sourceId,
            mapId: this.mapgetLayer.mapId,
            layerId: this.mapgetLayer.layerId,
            tileId: state.tileId,
            name
        });
        this.attachmentRefs.set(state.tileId, {name, ref});
        return ref;
    }

    /**
     * Pins immutable subset bytes while a spatial presentation block still
     * overlaps current coverage.
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

    /** Drops one tile's raw attachment demand immediately. */
    releaseAttachment(tileId: number): void {
        const existing = this.attachmentRefs.get(tileId);
        if (!existing) {
            return;
        }
        this.attachmentRefs.delete(tileId);
        existing.ref.release();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.filterRef.release();
        for (const state of this.tileStates.values()) {
            this.events.next({type: "tile-removed", state});
            this.releaseAttachment(state.tileId);
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

    private acceptTile(delivery: TileSubsetDelivery): void {
        if (this.disposed || delivery.generation !== this.generation) {
            return;
        }
        const state = this.tileStates.get(delivery.tileId);
        if (!state) {
            return;
        }
        state.install(delivery);
        this.events.next({type: "tile-ready", state});
    }

    private acceptStatus(status: MapTileStreamFilterStatusPayload): void {
        this.latestStatus = status;
        this.events.next({type: "status", status});
        if (status.error) {
            this.acceptError(status.error);
        }
    }

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

    private assertLive(): void {
        if (this.disposed) {
            throw new Error(`StyledMapgetLayer '${this.ownerId}' is disposed.`);
        }
    }
}
