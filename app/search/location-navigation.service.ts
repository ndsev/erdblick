import {inject, Injectable, OnDestroy} from "@angular/core";
import {map, merge, Observable, skip, Subscription} from "rxjs";
import {SearchTarget} from "../actions/omnibar";
import {MapViewService} from "../mapview/map-view.service";
import {ViewIdentity} from "../mapview/view-id";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {deepEquals} from "../shared/state-value";
import {AppStateService} from "../shared/appstate.service";
import {AppStore} from "../shared/app.store";
import {observeStore} from "../shared/persisted-state";
import {InfoMessageService} from "../shared/info.service";
import {JumpTargetService} from "./jump.service";
import {LocationSearchService, type LocationSearchMatch, type ResolvedLocationNavigation} from "./location.search.service";

/** Owns one selected location lookup until its single camera commit; later user actions win. */
@Injectable({providedIn: "root"})
export class LocationNavigationService implements OnDestroy {
    private readonly store = inject(AppStore);
    private pending?: Subscription;
    private readonly boundaryFeedback: Subscription;

    /** Connects resolution and renderer feedback without persisting transient navigation state. */
    constructor(
        private readonly locations: LocationSearchService,
        private readonly views: MapViewService,
        private readonly state: AppStateService,
        private readonly diagnostics: ViewLayerDiagnosticsService,
        private readonly jumps: JumpTargetService,
        private readonly messages: InfoMessageService
    ) {
        this.boundaryFeedback = views.locationBoundaryUnavailableTopic.subscribe(() =>
            messages.showInfo("The location boundary could not be displayed. Showing its bounding extent.")
        );
    }

    /** The omnibar subscription owns cancellation of location-provider searches. */
    searchTargets(query: string): Observable<SearchTarget[]> {
        return this.locations.search(query, this.store.location.locationSearchResultLimit())
            .pipe(map((matches) => matches.map((match) => this.createTarget(match))));
    }

    /** Bind transient provider metadata to the fixed location action and a live destination. */
    createTarget(match: LocationSearchMatch): SearchTarget {
        const target = this.store.captureView(this.store.focusedView())!;
        const {jump, ...presentation} = this.locations.createSearchTarget(match);
        return this.store.actionCatalog.candidate(this.store.navigateToLocation, {
            ...presentation,
            arguments: (_, payload) => ({actionId: presentation.id, payload: payload ?? match, target}),
            isCurrent: () => this.store.isCurrent(target),
            saveToHistory: () => true
        });
    }

    /** Reconstruct a saved identity through the same registered handler; never replay an old candidate closure. */
    runFromHistory(actionId: string, payload?: unknown): void {
        const target = this.store.captureView(this.store.focusedView())!;
        this.store.navigateToLocation({actionId, payload, target});
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
    navigate(actionId: string, payload?: unknown, captured?: ViewIdentity): void {
        const target = captured ?? this.store.captureView(this.store.focusedView())!;
        const targetView = this.store.requireCurrentView(target);
        this.cancel();
        const renderer = this.views.renderViewFor(targetView);
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
        const stillCurrent = () =>
            !pending.closed &&
            this.store.isCurrent(target) &&
            this.views.renderViewFor(this.store.indexOf(target.id)) === renderer &&
            this.store.focusedViewId() === target.id &&
            !renderer.isCameraInteractionActive() &&
            deepEquals(renderer.getLiveCameraState(), pose);
        pending.add(renderer.rendererInvalidated.subscribe({next: cancel, complete: cancel}));
        pending.add(
            observeStore(this.store, state => state.views.focusedViewId).pipe(skip(1)).subscribe(() => {
                if (!stillCurrent()) cancel();
            })
        );
        pending.add(
            observeStore(this.store, state => state.viewIds).pipe(skip(1)).subscribe(() => {
                if (!stillCurrent()) cancel();
            })
        );
        pending.add(observeStore(this.store, state => state.views.viewSync).pipe(skip(1)).subscribe(cancel));
        pending.add(this.state.stateApplied.subscribe(cancel));
        pending.add(
            this.diagnostics.cameraInteracting$.subscribe((active) => {
                if (active) cancel();
            })
        );
        pending.add(
            observeStore(this.store, state => state.views.cameraViewData).subscribe(() => {
                if (!stillCurrent()) cancel();
            })
        );
        pending.add(
            merge(
                this.views.navigationStarted,
                this.views.moveToWgs84PositionTopic,
                this.views.moveToRectangleTopic,
                this.views.moveToLocationAreaTopic,
                this.views.presentationCameraViewStateTopic
            ).subscribe(cancel)
        );
        if (pending.closed) return;
        pending.add(
            this.locations.resolveNavigation(actionId, payload).subscribe((result) => {
                if (!stillCurrent()) {
                    cancel();
                    return;
                }
                const commit = () => {
                    if (!stillCurrent()) {
                        cancel();
                        return;
                    }
                    const rect = renderer.getCanvasClientRect();
                    if (result.area && (rect.width < 1 || rect.height < 1)) return;
                    // Our own camera publication must not look like a competing navigation.
                    cancel();
                    this.commit(result, this.store.indexOf(target.id));
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
            })
        );
    }

    /** Publishes a location result after all asynchronous ownership checks have completed. */
    private commit(result: ResolvedLocationNavigation, targetView: number): void {
        if (result.error) {
            this.messages.showError(result.error);
            return;
        }
        if (result.area) this.views.moveToLocationAreaTopic.next({targetView, area: result.area});
        else if (result.point) {
            const [x, y] = result.point;
            this.views.moveToWgs84PositionTopic.next({
                targetView,
                x,
                y,
                z: this.store.views.cameraViewData()[this.store.idAt(targetView)!].destination.alt
            });
            if (result.label) this.views.showLocationLabelTopic.next({targetView, x, y, label: result.label});
            this.jumps.markedPosition.next([y, x, 0]);
        }
        if (result.notice) this.messages.showInfo(result.notice);
    }
}
