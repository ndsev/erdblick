import {Component} from '@angular/core';
import {AppStateService} from '../shared/appstate.service';

@Component({
    selector: 'about-dialog',
    template: `
        <app-dialog header="About" [(visible)]="stateService.aboutDialogVisible" [modal]="false"
                  [resizable]="false" class="pref-dialog" [style]="{'min-width': '24em', 'max-width': '42em'}"
                  [persistLayout]="true" [layoutId]="'about-dialog'">
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
    styles: [
        `
            .about-dialog-content {
                display: flex;
                flex-direction: column;
                gap: 1em;
            }

            .about-summary {
                display: flex;
                flex-direction: column;
                gap: 0.25em;
            }

            .about-title {
                font-size: 1.1em;
                font-weight: 600;
            }

            .about-version {
                color: var(--p-content-color);
                font-size: 0.95em;
            }

            .about-section-title {
                font-weight: 600;
            }

            .about-muted {
                color: var(--p-surface-500);
            }

            .about-table {
                width: 100%;
                border-collapse: collapse;
            }

            .about-table th, .about-table td {
                border: 1px solid var(--p-content-border-color);
                padding: 0.5em;
                text-align: left;
            }

            .about-table th {
                background-color: var(--p-highlight-background);
                color: var(--p-content-color);
                font-weight: bold;
            }

            .about-actions {
                display: flex;
                justify-content: flex-end;
            }
        `
    ],
    standalone: false
})
export class AboutComponent {
    constructor(public stateService: AppStateService) {}

    close() {
        this.stateService.aboutDialogVisible = false;
    }
}
