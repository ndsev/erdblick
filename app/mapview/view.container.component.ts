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
        // Loop through each MapViewComponent and call its resize handler
        // for (const mapViewComp of this.mapViewComponents.toArray()) {
        //     mapViewComp.onContainerResized();
        // }
    }
}
