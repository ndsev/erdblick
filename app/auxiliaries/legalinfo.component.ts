import { Component } from "@angular/core";
import { MapDataService } from "../mapdata/map.service";
import { AppStateService, LEGAL_INFO_DIALOG_LAYOUT_ID } from "../shared/appstate.service";

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
    styles: [``],
    standalone: false
})
/** Dialog that aggregates map-level legal and copyright notices. */
export class LegalInfoDialogComponent {
    readonly dialogLayoutId = LEGAL_INFO_DIALOG_LAYOUT_ID;
    public aggregatedLegalInfo: { mapName: string, entry: string }[] = [];

    constructor(private mapService: MapDataService,
                public stateService: AppStateService) {
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
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Closes the legal-information dialog. */
    close() {
        this.dialogVisible = false;
    }
}
