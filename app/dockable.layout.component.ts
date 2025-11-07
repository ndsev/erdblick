import {Component} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService} from "./shared/appstate.service";

@Component({
    selector: 'dockable-layout',
    template: `
        <div class="main-layout">
            <div style="width: 100%">
                <mapview-container></mapview-container>
                @if (!environment.visualizationOnly) {
                    <pref-components></pref-components>
                    <div class="dock-toggle" (click)="toggleDock()">
                    <span class="material-symbols-outlined">
                        @if (isDockOpen) {
                            chevron_forward
                        } @else {
                            chevron_backward
                        }
                    </span>
                    </div>
                }
            </div>
            @if (!environment.visualizationOnly) {
                <div class="collapsible-dock" [class]="{'collapsed': !isDockOpen, 'open': isDockOpen}">
                    <inspection-container [ngClass]="{'hidden': !isDockOpen}"></inspection-container>
                </div>
            }
        </div>
    `,
    styles: [`
        .main-layout {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 0;
        }
        
        .collapsible-dock {
            padding-top: 3em;
            height: 100vh;
            max-width: 50vw;
            min-width: 0;
            overflow: hidden;
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 0;
        }
        
        .collapsed {
            width: 0 !important;
        }
        
        .open {
            width: 40em !important;
        }
        
        .hidden {
            display: none;
        }
    `],
    standalone: false
})
export class DockableLayoutComponent {

    isDockOpen: boolean = false;

    constructor(private stateService: AppStateService) {
        this.stateService.dockOpenState.subscribe(isDockOpen => this.isDockOpen = isDockOpen);
    }

    protected readonly environment = environment;

    protected toggleDock() {
        this.stateService.dockOpenState.next(!this.isDockOpen);
    }
}
