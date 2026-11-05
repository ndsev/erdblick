import { Component } from "@angular/core";
import { MapDataService } from "./mapdata.service";
import { LEGAL_INFO_DIALOG_LAYOUT_ID } from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";
import { AppStateService } from "../appstate/appstate.service";

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
                            <th>Map Name</th>
                            <th>Legal Information</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let info of aggregatedLegalInfo">
                            <td>{{ info.mapName }}</td>
                            <td>{{ info.entry }}</td>
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
 * Display the legal and copyright notices supplied by the loaded maps.
 * MapDataService owns their aggregation and publishes changes as sources load;
 * this dialog formats those notices beside the other datasource-facing UI.
 */
export class LegalInfoDialogComponent {
    readonly dialogLayoutId = LEGAL_INFO_DIALOG_LAYOUT_ID;
    public aggregatedLegalInfo: { mapName: string, entry: string }[] = [];

    constructor(private mapService: MapDataService,
        public stateService: AppStateService,
        public readonly layout: LayoutService) {
        this.mapService.legalInformationUpdated.subscribe(_ => {
            this.aggregatedLegalInfo = [];
            this.mapService.legalInformationPerMap.forEach((entries, mapName) => {
                if (entries.size) {
                    this.aggregatedLegalInfo.push({
                        mapName: mapName,
                        entry: Array.from(entries).join('\n\n')
                    })
                }
            });
        });
    }

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
