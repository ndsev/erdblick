import { Component,OnDestroy,QueryList,signal,ViewChild,ViewChildren } from "@angular/core";
import { Splitter } from "primeng/splitter";
import { Subscription } from "rxjs";
import { ViewerUiService } from "../actions/viewer-ui.service";
import { environment } from "../environments/environment";
import { AppLayoutService } from "../shared/app-layout.service";
import { AppStateService } from "../shared/appstate.service";
import { KeyboardService } from "../shared/keyboard.service";
import { MapViewStateService } from "./map-view-state.service";
import { MapViewComponent } from "./view.component";

@Component({
    selector: 'mapview-container',
    template: `
        @if (viewModel$ | async; as vm) { 
            @if (vm.panelCount > 0) {
                <!-- TODO: Get rid of this, think about using https://github.com/angular-split/angular-split.
                      Unfortunately, the prime-ng splitter seems to be badly maintained 
                      (see https://github.com/primefaces/primeng/issues/13300) -->
                @for (v of [version()]; track v) {
                    <p-splitter [panelSizes]="vm.panelSizes" [minSizes]="[5, 5]" class="mb-8" data-testid="mapview-container"
                                (onResizeStart)="resizing = true" (onResizeEnd)="onSplitResizeEnd($event.sizes)">
                        @for (idx of vm.viewIndices; track idx) {
                            <ng-template pTemplate="panel">
                                <map-view [viewIndex]="idx"></map-view>
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
 * Container that lays out one or two `MapViewComponent`s and routes keyboard focus between them.
 * The extra `version` signal forces splitter recreation when the number of views changes.
 */
export class MapViewContainerComponent implements OnDestroy {
    @ViewChildren(MapViewComponent) mapViewComponents!: QueryList<MapViewComponent>;
    private unregisterResizeTarget?: () => void;
    private readonly subscriptions = new Subscription();
    protected resizing = false;

    /** Binds each real splitter instance; stale snapshot targets retire when view membership changes. */
    @ViewChild(Splitter) set resizeSplitter(splitter: Splitter | undefined) {
        this.unregisterResizeTarget?.();
        this.resizing = false;
        if (!splitter) return;
        this.unregisterResizeTarget = this.viewerUi.registerResizeTarget(splitter.el.nativeElement, {
            describe: () => ({kind: "split", dimensions: this.viewSettings.numViews === 2 ? ["panelSizes"] : [], busy: this.resizing,
                ...(this.viewSettings.numViews === 2 ? {panelSizes: [...splitter.panelSizes]} : {})}),
            resize: size => {
                if (!("panelSizes" in size)) return;
                const left = Math.min(95, Math.max(5, size.panelSizes[0]));
                const sizes = [left, 100 - left];
                // PrimeNG's public setter updates flex-basis in place, retaining both Deck renderers.
                splitter.panelSizes = [...sizes];
                this.layout.viewPanelSizesState.next(sizes);
            }
        });
    }

    version = signal("");

    viewModel$ = this.stateService.observe(() => {
        const ids = this.viewSettings.viewIds;
        const n = ids.length;
        const storedSizes = this.layout.viewPanelSizesState.value;
        return {
            identity: ids.join(","), panelCount: n,
            viewIndices: ids.map((_, index) => index),
            panelSizes: n === 2 && storedSizes.length === 2 && storedSizes[0] + storedSizes[1] > 0
                ? this.normalizePanelSizes(storedSizes) : ids.map(() => 100 / n)
        };
    });

    /** Keeps the container model in sync with app state and registers global focused-view shortcuts. */
    constructor(private stateService: AppStateService, private keyboardService: KeyboardService, private viewerUi: ViewerUiService,
        public readonly viewSettings: MapViewStateService,
        public readonly layout: AppLayoutService) {
        this.subscriptions.add(this.viewModel$.subscribe(vm => {
            this.version.set(vm.identity);
        }));

        // Register a shortcut to cycle the view focus.
        this.keyboardService.registerShortcut("Ctrl+ArrowRight", this.cycleViewFocus.bind(this, 1), true);
        this.keyboardService.registerShortcut("Ctrl+ArrowLeft", this.cycleViewFocus.bind(this, -1), true);

        // Ensure that keyboard shortcuts are always registered for the focused view.
        this.subscriptions.add(this.viewSettings.focusedViewChanges.subscribe(_ => {
            this.setupKeyboardShortcutsForFocusedView();
        }));

    }

    /** Persists a completed human resize, sharing the same local state as explicit size commands. */
    protected onSplitResizeEnd(sizes: Array<string | number>): void {
        this.resizing = false;
        if (sizes.length === 2) this.layout.viewPanelSizesState.next(this.normalizePanelSizes(sizes.map(Number)));
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
        this.subscriptions.unsubscribe();
    }

    /** Cycles focused-view ownership left or right across the currently visible views. */
    cycleViewFocus(direction: number) {
        console.assert(direction === -1 || direction === 1);
        const nextView = (this.viewSettings.focusedView + direction) % this.viewSettings.numViews;
        this.viewSettings.focusedView = nextView < 0 ? this.viewSettings.numViews - 1 : nextView;
    }

    /**
     * Registers movement/zoom shortcuts on the renderer instance of the focused view only.
     * This is rerun whenever focus changes because the keyboard service stores concrete callbacks.
     */
    private setupKeyboardShortcutsForFocusedView() {
        if (environment.visualizationOnly) {
            return;
        }

        if (this.mapViewComponents === undefined) {
            return;
        }

        for (const viewComponent of this.mapViewComponents) {
            if (viewComponent.mapView?.viewIndex !== this.viewSettings.focusedView) {
                continue;
            }
            const mapView = viewComponent.mapView;
            if (mapView) {
                this.keyboardService.registerShortcut('q', mapView.zoomIn.bind(mapView), true);
                this.keyboardService.registerShortcut('e', mapView.zoomOut.bind(mapView), true);
                this.keyboardService.registerShortcut('w', mapView.moveUp.bind(mapView), true);
                this.keyboardService.registerShortcut('a', mapView.moveLeft.bind(mapView), true);
                this.keyboardService.registerShortcut('s', mapView.moveDown.bind(mapView), true);
                this.keyboardService.registerShortcut('d', mapView.moveRight.bind(mapView), true);
                this.keyboardService.registerShortcut('r', mapView.resetOrientation.bind(mapView), true);
            }
            break;
        }
    }



    protected readonly environment = environment;
}
