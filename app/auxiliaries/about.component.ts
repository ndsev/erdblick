import {AppStore} from "../shared/app.store";
import {Component, inject} from "@angular/core";
import {AppConfigService} from "../shared/app-config.service";
import {ABOUT_DIALOG_LAYOUT_ID} from "../shared/app-layout.model";

import {AppStateService} from "../shared/appstate.service";

@Component({
    selector: "about-dialog",
    template: `
        <app-dialog
            header="About"
            [visible]="store.isDialogOpen(dialogLayoutId)" (visibleChange)="store.setDialogOpen(dialogLayoutId, $event)"
            [modal]="false"
            [resizable]="false"
            class="pref-dialog"
            [style]="{'min-width': '24em', 'max-width': '42em'}"
            [persistLayout]="true"
            [layoutId]="dialogLayoutId"
        >
            <div class="about-dialog-content">
                @if (store.config.distributionVersions().length) {
                    <div class="about-section-title">Distribution</div>
                    <table class="about-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Version</th>
                            </tr>
                        </thead>
                        <tbody>
                            @for (version of store.config.distributionVersions(); track $index) {
                                <tr>
                                    <td>{{ version.name }}</td>
                                    <td>
                                        {{ version.tag }}
                                        @if (version.whatsnew !== undefined) {
                                            <br /><a [href]="version.whatsnew">What's new</a>
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                } @else {
                    <div class="about-summary">
                        <div class="about-title">Erdblick</div>
                        @if (store.config.erdblickVersion().length) {
                            <div class="about-version">{{ store.config.erdblickVersion() }}</div>
                        } @else {
                            <div class="about-version">Version information unavailable.</div>
                        }
                    </div>
                }
                <div class="about-actions">
                    <p-button type="button" label="Close" icon="pi pi-times" (click)="close()"></p-button>
                </div>
            </div>
        </app-dialog>
    `,
    standalone: false
})
/** About dialog that shows either packaged distribution versions or the raw erdblick version. */
export class AboutComponent {
    readonly store = inject(AppStore);
    readonly configService = inject(AppConfigService);
    readonly dialogLayoutId = ABOUT_DIALOG_LAYOUT_ID;

    constructor(public stateService: AppStateService) {}





    /** Closes the about dialog. */
    close() {
        this.store.setDialogOpen(this.dialogLayoutId, false);
    }
}
