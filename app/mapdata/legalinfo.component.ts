import { Component } from "@angular/core";
import { LegalInfoService } from "./legalinfo.service";
import { LEGAL_INFO_DIALOG_LAYOUT_ID } from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";

@Component({
    selector: 'legal-dialog',
    template: `
        <app-dialog header="Copyright and Legal Information" [(visible)]="dialogVisible" [modal]="false"
                  [style]="{'min-height': '10em', 'min-width': '40em'}"
                  [persistLayout]="false" [layoutId]="dialogLayoutId">
            <div class="stats-content">
                <table class="stats-table">
                    <thead>
                        <tr>
                            <th>Source</th>
                            <th>Legal Information</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let info of legalInfo.entries$ | async">
                            <td>{{ info.source }}</td>
                            <td>
                                @for (notice of info.notices; track $index) {
                                    <p>{{ notice }}</p>
                                }
                            </td>
                        </tr>
                    </tbody>
                </table>
                <p-button label="Close" icon="pi pi-times" (click)="close()"></p-button>
            </div>
        </app-dialog>
    `,
    standalone: false
})
/**
 * Display complete map-data and background-imagery notices with their sources.
 * The vertical attribution shortcut uses the same reactive collection.
 */
export class LegalInfoDialogComponent {
    readonly dialogLayoutId = LEGAL_INFO_DIALOG_LAYOUT_ID;

    constructor(
        public readonly legalInfo: LegalInfoService,
        public readonly layout: LayoutService
    ) {}

    get dialogVisible(): boolean {
        return this.layout.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.layout.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Closes the legal-information dialog. */
    close() {
        this.dialogVisible = false;
    }
}
