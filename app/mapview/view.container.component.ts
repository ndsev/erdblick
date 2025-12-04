import {Component, QueryList, signal, ViewChildren} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {map} from "rxjs";
import {MapViewComponent} from "./view.component";
import {KeyboardService} from "../shared/keyboard.service";
import {environment} from "../environments/environment";

@Component({
    selector: 'mapview-container',
    template: `
        @if (viewModel$ | async; as vm) { 
            @if (vm.panelCount > 0) {
                <!-- TODO: Get rid of this, think about using https://github.com/angular-split/angular-split.
                      Unfortunately, the prime-ng splitter seems to be badly maintained 
                      (see https://github.com/primefaces/primeng/issues/13300) -->
                @for (v of [version()]; track v) {
                    <p-splitter [panelSizes]="vm.panelSizes" class="mb-8">
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
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class MapViewContainerComponent {
    @ViewChildren(MapViewComponent) mapViewComponents!: QueryList<MapViewComponent>;

    version = signal(0);

    viewModel$ = this.stateService.numViewsState.pipe(
        map(n => n > 0
            ? {
                panelCount: n,
                viewIndices: Array.from({ length: n }, (_, i) => i),
                panelSizes: Array.from({ length: n }, () => 100 / n)
            }
            : { panelCount: 0, viewIndices: [], panelSizes: [] }
        )
    );

    constructor(private stateService: AppStateService, private keyboardService: KeyboardService) {
        this.viewModel$.subscribe(vm => {
            this.version.update(_ => vm.panelCount);
        });

        // Register a shortcut to cycle the view focus.
        this.keyboardService.registerShortcut("Ctrl+ArrowRight", this.cycleViewFocus.bind(this, 1), true);
        this.keyboardService.registerShortcut("Ctrl+ArrowLeft", this.cycleViewFocus.bind(this, -1), true);

        // Ensure that keyboard shortcuts are always registered for the focused view.
        this.stateService.focusedViewState.subscribe(_ => {
            this.setupKeyboardShortcutsForFocusedView();
        });
    }

    cycleViewFocus(direction: number) {
        console.assert(direction === -1 || direction === 1);
        const nextView = (this.stateService.focusedView + direction) % this.stateService.numViews;
        this.stateService.focusedView = nextView < 0 ? this.stateService.numViews - 1 : nextView;
    }

    /**
     * Setup keyboard shortcuts
     */
    private setupKeyboardShortcutsForFocusedView() {
        if (environment.visualizationOnly) {
            return;
        }

        if (this.mapViewComponents === undefined) {
            return;
        }

        for (const viewComponent of this.mapViewComponents) {
            if (viewComponent.mapView?.viewIndex !== this.stateService.focusedView) {
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
}
