import {Component} from '@angular/core';
import {ABOUT_DIALOG_LAYOUT_ID, AppStateService} from '../shared/appstate.service';

@Component({
    selector: 'about-dialog',
    template: `
        <app-dialog header="About" [(visible)]="dialogVisible" [modal]="false"
                  [resizable]="false" class="pref-dialog" [style]="{'min-width': '24em', 'max-width': '42em'}"
                  [persistLayout]="true" [layoutId]="dialogLayoutId">
            <div class="about-dialog-content">
                @if (stateService.distributionVersions.getValue().length) {
                    <div class="about-section-title">Distribution</div>
                    <table class="about-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Version</th>
                            </tr>
                        </thead>
                        <tbody>
                            @for (version of stateService.distributionVersions.getValue(); track $index) {
                                <tr>
                                    <td>{{ version.name }}</td>
                                    <td>
                                        {{ version.tag }}
                                        @if (version.whatsnew !== undefined) {
                                            <br><a [href]="version.whatsnew">What's new</a>
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                } @else {
                    <div class="about-summary">
                        <div class="about-title">Erdblick</div>
                        @if (stateService.erdblickVersion.getValue().length) {
                            <div class="about-version">{{ stateService.erdblickVersion.getValue() }}</div>
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
    readonly dialogLayoutId = ABOUT_DIALOG_LAYOUT_ID;

    constructor(public stateService: AppStateService) {}

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Closes the about dialog. */
    close() {
        this.dialogVisible = false;
    }
}
