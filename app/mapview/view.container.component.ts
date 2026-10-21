import {Component, computed, inject, OnDestroy, ViewChild} from "@angular/core";
import {AppLayoutService} from "../shared/app-layout.service";
import {MapViewStateService} from "./map-view-state.service";
import {MapViewService} from "./map-view.service";
import {KeyboardService} from "../shared/keyboard.service";
import {environment} from "../environments/environment";
import {Splitter} from "primeng/splitter";
import {ViewerUiService} from "../actions/viewer-ui.service";

@Component({
    selector: 'mapview-container',
    template: `
        @if (viewModel(); as vm) { 
            @if (vm.panelCount > 0) {
                <!-- TODO: Get rid of this, think about using https://github.com/angular-split/angular-split.
                      Unfortunately, the prime-ng splitter seems to be badly maintained 
                      (see https://github.com/primefaces/primeng/issues/13300) -->
                @for (layout of [vm]; track layout.membershipKey) {
                    <p-splitter [panelSizes]="layout.panelSizes" [minSizes]="[5, 5]" class="mb-8" data-testid="mapview-container"
                                (onResizeStart)="resizing = true" (onResizeEnd)="onSplitResizeEnd($event.sizes)">
                        @for (id of layout.viewIds; track id) {
                            <ng-template pTemplate="panel">
                                <map-view [viewId]="id"></map-view>
                            </ng-template>
                        }
                    </p-splitter>
                }
            }
        }
    `,
    standalone: false
})
/**
 * Container that lays out map views and routes keyboard commands to the focused live renderer.
 * PrimeNG captures panel templates at initialization, so ordered membership changes
 * recreate the splitter and its renderers. View owners retain each logical ID's state.
 */
export class MapViewContainerComponent implements OnDestroy {
    readonly viewStateOwner = inject(MapViewStateService);
    readonly layoutState = inject(AppLayoutService);
    private unregisterResizeTarget?: () => void;
    private readonly keyboardShortcuts = new Map<string, () => void>();
    protected resizing = false;

    /** Binds each real splitter instance; stale snapshot targets retire when view membership changes. */
    @ViewChild(Splitter) set resizeSplitter(splitter: Splitter | undefined) {
        this.unregisterResizeTarget?.();
        this.resizing = false;
        if (!splitter) return;
        this.unregisterResizeTarget = this.viewerUi.registerResizeTarget(splitter.el.nativeElement, {
            describe: () => ({kind: "split", dimensions: this.viewStateOwner.numViews === 2 ? ["panelSizes"] : [], busy: this.resizing,
                ...(this.viewStateOwner.numViews === 2 ? {panelSizes: [...splitter.panelSizes]} : {})}),
            resize: size => {
                if (!("panelSizes" in size)) return;
                const left = Math.min(95, Math.max(5, size.panelSizes[0]));
                const sizes = [left, 100 - left];
                // PrimeNG's public setter updates flex-basis in place, retaining both Deck renderers.
                splitter.panelSizes = [...sizes];
                this.layoutState.viewPanelSizesState.next(sizes);
            }
        });
    }

    readonly viewModel = computed(() => {
        const ids = this.viewStateOwner.viewIds();
        const storedSizes = this.layoutState.viewPanelSizesState.signal();
        return {panelCount: ids.length, viewIds: ids, membershipKey: ids.join(","),
            panelSizes: ids.length === 2 && storedSizes.length === 2 && storedSizes[0] + storedSizes[1] > 0
                ? this.normalizePanelSizes(storedSizes) : ids.map(() => 100 / ids.length)};
    });

    /** Keeps the container model in sync with app state and registers global focused-view shortcuts. */
    constructor(private mapViews: MapViewService, private keyboardService: KeyboardService, private viewerUi: ViewerUiService) {
        // Register a shortcut to cycle the view focus.
        this.keyboardShortcuts.set("Ctrl+ArrowRight", () => this.cycleViewFocus(1));
        this.keyboardShortcuts.set("Ctrl+ArrowLeft", () => this.cycleViewFocus(-1));

        // Renderers initialize asynchronously and are replaced on layout/projection changes.
        // Resolve the live identity at keydown instead of retaining a retired renderer callback.
        if (!environment.visualizationOnly) {
            const focusedView = () => this.mapViews.renderViewFor(this.viewStateOwner.focusedView);
            this.keyboardShortcuts.set('q', () => focusedView()?.zoomIn());
            this.keyboardShortcuts.set('e', () => focusedView()?.zoomOut());
            this.keyboardShortcuts.set('w', () => focusedView()?.moveUp());
            this.keyboardShortcuts.set('a', () => focusedView()?.moveLeft());
            this.keyboardShortcuts.set('s', () => focusedView()?.moveDown());
            this.keyboardShortcuts.set('d', () => focusedView()?.moveRight());
            this.keyboardShortcuts.set('r', () => focusedView()?.resetOrientation());
        }
        for (const [key, callback] of this.keyboardShortcuts) {
            this.keyboardService.registerShortcut(key, callback, true);
        }

    }

    /** Persists a completed human resize, sharing the same local state as explicit size commands. */
    protected onSplitResizeEnd(sizes: Array<string | number>): void {
        this.resizing = false;
        if (sizes.length === 2) this.layoutState.viewPanelSizesState.next(this.normalizePanelSizes(sizes.map(Number)));
    }

    /** Removes rounding drift while retaining PrimeNG's minimum visible panel sizes. */
    private normalizePanelSizes(sizes: number[]): number[] {
        const total = sizes[0] + sizes[1];
        const left = Number.isFinite(total) && total > 0 ? Math.min(95, Math.max(5, 100 * sizes[0] / total)) : 50;
        return [left, 100 - left];
    }

    /** Releases live element registrations and component-lifetime subscriptions. */
    ngOnDestroy(): void {
        this.unregisterResizeTarget?.();
        for (const [key, callback] of this.keyboardShortcuts) {
            this.keyboardService.unregisterShortcut(key, callback);
        }
    }

    /** Cycles focused-view ownership left or right across the currently visible views. */
    cycleViewFocus(direction: number) {
        console.assert(direction === -1 || direction === 1);
        const nextView = (this.viewStateOwner.focusedView + direction) % this.viewStateOwner.numViews;
        this.viewStateOwner.focusedView = nextView < 0 ? this.viewStateOwner.numViews - 1 : nextView;
    }

    protected readonly environment = environment;
}
