import { Component } from '@angular/core';
import { DiagnosticsState } from "../diagnostics/diagnostics.state";
import { ABOUT_DIALOG_LAYOUT_ID } from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";
import { AppStateService } from "../appstate/appstate.service";

@Component({
    selector: 'about-dialog',
    template: `
        <app-dialog header="About" [(visible)]="dialogVisible" [modal]="false"
                  [resizable]="false" class="pref-dialog" [style]="{'min-width': '24em', 'max-width': '42em'}"
                  [persistLayout]="true" [layoutId]="dialogLayoutId">
            <div class="about-dialog-content">
                @if (diagnostics.versions.distributionVersions.length) {
                    <div class="about-section-title">Distribution</div>
                    <table class="about-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Version</th>
                            </tr>
                        </thead>
                        <tbody>
                            @for (version of diagnostics.versions.distributionVersions; track $index) {
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
                        @if (diagnostics.versions.erdblickVersion.length) {
                            <div class="about-version">{{ diagnostics.versions.erdblickVersion }}</div>
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
/**
 * About dialog for the configured distribution and erdblick version metadata.
 * DiagnosticsState supplies the read-only runtime versions; LayoutService owns
 * the dialog's visibility. The displayed labels are not persisted preferences.
 */
export class AboutComponent {
    readonly dialogLayoutId = ABOUT_DIALOG_LAYOUT_ID;

    constructor(public stateService: AppStateService,
        public readonly diagnostics: DiagnosticsState,
        public readonly layout: LayoutService) { }

    get dialogVisible(): boolean {
        return this.layout.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.layout.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Closes the about dialog. */
    close() {
        this.dialogVisible = false;
    }
}
