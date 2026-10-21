import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { merge, skip, Subscription } from "rxjs";
import {
    ActionCandidateHistory,
    ActionInput,
    ActionOutput,
    AppActionCandidate,
    applied,
    rejectAction
} from "../actions/app-action";
import { AppActionService } from "../actions/app-action.service";
import { ViewerActionFailure } from "../actions/viewer-action-relay.contract";
import { InspectionSelectionService } from "../inspection/inspection-selection.service";
import { coreLib } from "../integrations/wasm";
import { MapTileStreamService } from "../mapdata/map-tile-stream.service";
import { MapViewStateService } from "../mapview/map-view-state.service";
import { MapViewService } from "../mapview/map-view.service";
import { ViewLayerDiagnosticsService } from "../mapview/view-layer-diagnostics.service";
import { deepEquals } from "../shared/app-state";
import { AppStateService } from "../shared/appstate.service";
import { InfoMessageService } from "../shared/info.service";
import { JumpTargetService } from "./jump.service";
import { locationActions, navigationActions } from "./location-navigation.service.declarations";
import {
    LocationSearchMatch,
    LocationSearchService,
    normalizeLocationSearchPayload,
    type ResolvedLocationNavigation
} from "./location.search.service";

/** Owns one selected location lookup until its single camera commit; later user actions win. */
@Injectable({ providedIn: "root" })
export class LocationNavigationService implements OnDestroy {
    private pending?: Subscription;
    private readonly boundaryFeedback: Subscription;

    /** Connects resolution and renderer feedback without persisting transient navigation state. */
    constructor(
        private readonly locations: LocationSearchService,
        private readonly views: MapViewService,
        private readonly state: AppStateService,
        private readonly diagnostics: ViewLayerDiagnosticsService,
        private readonly jumps: JumpTargetService,
        private readonly messages: InfoMessageService,
        public readonly viewSettings: MapViewStateService,
        private readonly stream: MapTileStreamService,
        private readonly inspections: InspectionSelectionService,
        private readonly zone: NgZone
    ) {
        this.boundaryFeedback = views.locationBoundaryUnavailableTopic.subscribe(() =>
            messages.showInfo("The location boundary could not be displayed. Showing its bounding extent."));
    }

    /** Releases the tab-level feedback subscription together with pending navigation. */
    ngOnDestroy(): void {
        this.cancel();
        this.boundaryFeedback.unsubscribe();
    }

    /** Cancels transport, guards and any wait for a visible pane without applying fallbacks. */
    cancel(): void {
        this.pending?.unsubscribe();
        this.pending = undefined;
    }

    /** Resolves fresh selections and saved identities through exactly the same path. */
    navigate(actionId: string, payload?: unknown): void {
        this.cancel();
        const targetView = this.viewSettings.focusedView;
        const target = this.views.captureView(targetView);
        const renderer = target ? this.views.resolveCapturedView(target) : undefined;
        if (!renderer) {
            this.messages.showError("The destination map is unavailable.");
            return;
        }
        if (this.diagnostics.cameraInteracting) return;
        this.views.navigationStarted.next();
        this.views.clearLocationHighlightTopic.next(targetView);
        const pending = new Subscription();
        this.pending = pending;
        const pose = renderer.getLiveCameraState();
        const cancel = () => this.cancel();
        const stillCurrent = () => !pending.closed && !!target && this.views.resolveCapturedView(target) === renderer
            && this.viewSettings.focusedViewIdState.value === target.viewId
            && !renderer.isCameraInteractionActive() && deepEquals(renderer.getLiveCameraState(), pose);
        pending.add(renderer.rendererInvalidated.subscribe(cancel));
        pending.add(this.viewSettings.focusedViewIdState.pipe(skip(1)).subscribe(id => { if (id !== target!.viewId) cancel(); }));
        pending.add(this.viewSettings.viewIdsState.pipe(skip(1)).subscribe(() => { if (!stillCurrent()) cancel(); }));
        pending.add(this.viewSettings.viewSyncState.pipe(skip(1)).subscribe(cancel));
        pending.add(this.state.stateApplied.subscribe(cancel));
        pending.add(this.diagnostics.cameraInteracting$.subscribe(active => { if (active) cancel(); }));
        pending.add(this.viewSettings.cameraViewDataState.appState.subscribe(() => { if (!stillCurrent()) cancel(); }));
        pending.add(merge(this.views.navigationStarted, this.views.moveToWgs84PositionTopic, this.views.moveToRectangleTopic,
            this.views.moveToLocationAreaTopic, this.views.presentationCameraViewStateTopic).subscribe(cancel));
        if (pending.closed) return;
        pending.add(this.locations.resolveNavigation(actionId, payload).subscribe(result => {
            if (!stillCurrent()) { cancel(); return; }
            const commit = () => {
                if (!stillCurrent()) { cancel(); return; }
                const rect = renderer.getCanvasClientRect();
                if (result.area && (rect.width < 1 || rect.height < 1)) return;
                // Our own camera publication must not look like a competing navigation.
                cancel();
                this.commit(result, this.viewSettings.indexOfView(target!.viewId));
            };
            commit();
            if (!pending.closed) {
                renderer.onTick(commit);
                pending.add(() => renderer.offTick(commit));
                const deadline = setTimeout(() => {
                    if (!pending.closed) {
                        cancel();
                        this.messages.showError("The destination map is not visible.");
                    }
                }, 8000);
                pending.add(() => clearTimeout(deadline));
            }
        }));
    }

    /** Publishes a location result after all asynchronous ownership checks have completed. */
    private commit(result: ResolvedLocationNavigation, targetView: number): void {
        if (result.error) { this.messages.showError(result.error); return; }
        if (result.area) this.views.moveToLocationAreaTopic.next({ targetView, area: result.area });
        else if (result.point) {
            const [x, y] = result.point;
            this.views.moveToWgs84PositionTopic.next({
                targetView, x, y,
                z: this.viewSettings.cameraViewDataState.getValue(targetView).destination.alt
            });
            if (result.label) this.views.showLocationLabelTopic.next({ targetView, x, y, label: result.label });
            this.jumps.markedPosition.next([y, x, 0]);
        }
        if (result.notice) this.messages.showInfo(result.notice);
    }

    registerActions(actions: AppActionService): void {
        actions.registerAction(locationActions.navigateLocation, input => {
            if (!this.locations.isLocationTargetId(input.actionId)) rejectAction("Invalid location identity", "invalid_arguments");
            this.navigate(input.actionId, input.payload);
            return applied();
        }, (query, history) => this.locationCandidates(query, history));
        actions.registerAction(navigationActions.navigate, (input, signal) => this.navigateToTarget(input, signal));
    }

    /** Captures renderer lifetimes before locate/load; reorder resolves current presentation indices at commit. */
    async navigateToTarget(input: ActionInput<typeof navigationActions.navigate>, signal?: AbortSignal): Promise<ActionOutput<typeof navigationActions.navigate>> {
        this.views.requireViewIndex(input.viewId);
        const sync = this.viewSettings.viewSync.includes("pos") || this.viewSettings.viewSync.includes("mov");
        const ids = sync ? [...this.viewSettings.viewIds] : [input.viewId];
        this.views.requireIdleMapCameras(ids);
        const targets = ids.map(id => this.views.captureView(id)!);
        const renderers = targets.map(target => this.views.resolveCapturedView(target)!);
        this.views.navigationStarted.next();
        const controller = new AbortController();
        const abort = () => controller.abort(new ViewerActionFailure({ code: "cancelled", message: "Navigation was interrupted", outcome: "not_applied" }));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const guards = new Subscription();
        const poses = renderers.map(view => view.getLiveCameraState());
        const syncBefore = this.viewSettings.viewSync;
        const stillCurrent = () => targets.every((target, index) => this.views.resolveCapturedView(target) === renderers[index]);
        guards.add(this.views.navigationStarted.subscribe(abort));
        guards.add(this.state.stateApplied.subscribe(abort));
        guards.add(this.diagnostics.cameraInteracting$.subscribe(active => { if (active && renderers.some(view => view.isCameraInteractionActive())) abort(); }));
        guards.add(this.state.observe(() => this.viewSettings.viewIds).subscribe(() => { if (!stillCurrent()) abort(); }));
        guards.add(this.viewSettings.cameraViewDataState.appState.subscribe(() => {
            if (!stillCurrent() || renderers.some((view, index) => !deepEquals(view.getLiveCameraState(), poses[index]))) abort();
        }));
        guards.add(this.viewSettings.viewSyncState.subscribe(value => { if (!deepEquals(value, syncBefore)) abort(); }));
        for (const view of renderers) guards.add(view.rendererInvalidated.subscribe(abort));
        try {
            const target = input.target;
            const features = "features" in target ? await this.stream.resolveFeatureIdentities(target.features, controller.signal) : undefined;
            const loaded = features ? await this.stream.loadFeatures(features, controller.signal) : undefined;
            controller.signal.throwIfAborted();
            if (!stillCurrent()) rejectAction("The target view was replaced", "cancelled");
            if (features && loaded?.length !== features.length) rejectAction("Some requested features could not be loaded");
            const position = loaded ? this.inspections.featureSetZoomTarget(loaded) : undefined;
            if (loaded && !position) rejectAction("Some requested features have no usable geometry extent");
            let bounds: { west: number; south: number; east: number; north: number } | undefined;
            if ("bounds" in target) bounds = target.bounds;
            if ("mapTileKey" in target) {
                const parsed = this.stream.parseMapPartitionKeySafe(target.mapTileKey);
                if (!parsed || parsed[2].kind !== "tile") rejectAction("Tile fitting requires a tile partition", "invalid_arguments");
                const box = coreLib.getTileBox(parsed[2].id);
                bounds = { west: box[0], south: box[1], east: box[2], north: box[3] };
            }
            if (bounds && (bounds.west >= bounds.east || bounds.south >= bounds.north)) rejectAction("Bounds must have positive extent and not cross the antimeridian", "invalid_arguments");
            guards.unsubscribe();
            return this.zone.run(() => {
                controller.signal.throwIfAborted();
                const index = this.views.requireViewIndex(input.viewId);
                this.state.transaction(() => {
                    this.viewSettings.focusedView = index;
                    if (position) this.views.moveToWgs84PositionTopic.next({ targetView: index, ...position });
                    else this.views.moveToRectangleTopic.next({ targetView: index, rectangle: bounds! });
                });
                return applied();
            });
        } finally {
            guards.unsubscribe();
            signal?.removeEventListener("abort", abort);
        }
    }

    private suggestionQuery = "";
    private suggestions: LocationSearchMatch[] = [];

    /** The UI owns debounce/cancellation; the location owner retains only the current result set. */
    updateSuggestions(query: string, matches: LocationSearchMatch[]): void {
        this.suggestionQuery = query;
        this.suggestions = matches;
    }

    private locationCandidates(query: string, history?: ActionCandidateHistory): AppActionCandidate<ActionInput<typeof locationActions.navigateLocation>>[] {
        const saved = normalizeLocationSearchPayload(history?.payload);
        const matches = saved ? [saved] : query.trim() === this.suggestionQuery ? this.suggestions : [];
        const candidates: AppActionCandidate<ActionInput<typeof locationActions.navigateLocation>>[] = matches.map(match => {
            const target = this.locations.createSearchTarget(match);
            return {
                id: target.id, name: target.name, label: target.label, icon: target.icon,
                iconType: target.iconType, color: target.color, enabled: true, payload: match,
                input: { actionId: target.id, payload: match }
            };
        });
        if (history && !candidates.some(candidate => candidate.id === history.id) && this.locations.isLocationTargetId(history.id)) {
            candidates.push({
                id: history.id, name: "Saved location", label: "Resolve saved location in the focused map", icon: "location_city",
                iconType: "material", color: "green", enabled: true, payload: history.payload,
                input: { actionId: history.id, payload: history.payload }
            });
        }
        return candidates;
    }

}
