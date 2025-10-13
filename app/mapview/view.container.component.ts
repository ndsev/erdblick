import {Component, QueryList, signal, ViewChildren} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {map} from "rxjs";
import {MapViewComponent} from "./view.component";
import {SplitterResizeEndEvent} from "primeng/splitter";

@Component({
    selector: 'mapview-container',
    template: `
        <ng-container *ngIf="viewModel$ | async as vm">
            @if (vm.panelCount > 0) {
                @for (v of [version()]; track v) {
                    <p-splitter [panelSizes]="vm.panelSizes" class="mb-8" (onResizeEnd)="handleResizeEnd($event)">>
                        @for (idx of vm.viewIndices; track idx) {
                            <ng-template pTemplate="panel">
                                <map-view [viewIndex]="idx"></map-view>
                            </ng-template>
                        }
                    </p-splitter>
                }
            }
        </ng-container>
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
    private previousPanelSizes: number[] = [];

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

    constructor(private stateService: AppStateService) {
        this.viewModel$.subscribe(vm => {
            this.version.update(_ => vm.panelCount);
        });
    }

    handleResizeEnd(event: SplitterResizeEndEvent) {
        if (this.mapViewComponents.length === 0) {
            return;
        }

        const sizes = event?.sizes ?? [];
        const fallbackPercent = this.mapViewComponents.length > 0 ? 100 / this.mapViewComponents.length : 0;

        if (this.previousPanelSizes.length !== this.mapViewComponents.length) {
            this.previousPanelSizes = Array.from({ length: this.mapViewComponents.length }, () => fallbackPercent);
        }

        this.mapViewComponents.forEach((view, index) => {
            const sizePercent = typeof sizes[index] === 'number' ? sizes[index]! : fallbackPercent;
            const previousPercent = this.previousPanelSizes[index] ?? fallbackPercent;
            if (sizePercent > 50) {
                view.applyCameraScaleFromWidthChange(previousPercent, sizePercent * 1.1);
            } else {
                view.applyCameraScaleFromWidthChange(1, 1);
            }
        });

        this.previousPanelSizes = this.mapViewComponents.map((_, index) =>
            typeof sizes[index] === 'number' ? sizes[index]! : fallbackPercent
        );
    }
}
