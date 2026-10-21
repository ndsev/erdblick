import {MapViewStateService} from "../mapview/map-view-state.service";
import {inject} from "@angular/core";
import {Injectable, OnDestroy} from "@angular/core";
import {merge, skip, Subscription} from "rxjs";
import {MapViewService} from "../mapview/map-view.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {AppStateService} from "../shared/appstate.service";
import {deepEquals} from "../shared/app-state";
import {InfoMessageService} from "../shared/info.service";
import {JumpTargetService} from "./jump.service";
import {LocationSearchService, type ResolvedLocationNavigation} from "./location.search.service";

/** Owns one selected location lookup until its single camera commit; later user actions win. */
@Injectable({providedIn: "root"})
export class LocationNavigationService implements OnDestroy {
    readonly viewStateOwner = inject(MapViewStateService);
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
        const targetView = this.viewStateOwner.focusedView;
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
        const target = this.viewStateOwner.captureView(targetView)!;
        const pose = renderer.getLiveCameraState();
        const cancel = () => this.cancel();
        const stillCurrent = () => !pending.closed && this.viewStateOwner.isCurrent(target)
            && this.views.renderViewFor(this.viewStateOwner.indexOf(target.id)) === renderer
            && this.viewStateOwner.focusedViewId() === target.id
            && !renderer.isCameraInteractionActive() && deepEquals(renderer.getLiveCameraState(), pose);
        pending.add(renderer.rendererInvalidated.subscribe(cancel));
        pending.add(this.viewStateOwner.focusedViewState.pipe(skip(1)).subscribe(() => { if (!stillCurrent()) cancel(); }));
        pending.add(this.viewStateOwner.viewIdsState.pipe(skip(1)).subscribe(() => { if (!stillCurrent()) cancel(); }));
        pending.add(this.viewStateOwner.viewSyncState.pipe(skip(1)).subscribe(cancel));
        pending.add(this.state.stateApplied.subscribe(cancel));
        pending.add(this.diagnostics.cameraInteracting$.subscribe(active => { if (active) cancel(); }));
        pending.add(this.viewStateOwner.cameraViewDataState.appState.subscribe(() => { if (!stillCurrent()) cancel(); }));
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
                this.commit(result, this.viewStateOwner.indexOf(target.id));
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
        if (result.area) this.views.moveToLocationAreaTopic.next({targetView, area: result.area});
        else if (result.point) {
            const [x, y] = result.point;
            this.views.moveToWgs84PositionTopic.next({targetView, x, y,
                z: this.viewStateOwner.cameraViewDataState.getValue(targetView).destination.alt});
            if (result.label) this.views.showLocationLabelTopic.next({targetView, x, y, label: result.label});
            this.jumps.markedPosition.next([y, x, 0]);
        }
        if (result.notice) this.messages.showInfo(result.notice);
    }
}
