import { Component } from "@angular/core";
import { MapService } from "../mapdata/map.service";
import { AppStateService } from "../shared/appstate.service";

@Component({
    selector: 'legal-dialog',
    template: `
        <p-dialog header="Copyright and Legal Information" [(visible)]="stateService.legalInfoDialogVisible" [modal]="false"
                  [style]="{'min-height': '10em', 'min-width': '40em'}">
            <div class="dialog-content">
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
                <button pButton type="button" label="Close" icon="pi pi-cross" (click)="close()"></button>
            </div>
        </p-dialog>
    `,
    styles: [
        `
            .dialog-content {
                display: flex;
                flex-direction: column;
                gap: 1em;
            }
            .stats-table {
                width: 100%;
                border-collapse: collapse;
            }
            .stats-table th, .stats-table td {
                border: 1px solid #ccc;
                padding: 0.5em;
                text-align: left;
            }
            .stats-table th {
                background-color: #f9f9f9;
                font-weight: bold;
            }
        `
    ],
    standalone: false
})
export class LegalInfoDialogComponent {
    public aggregatedLegalInfo: { mapName: string, entry: string }[] = [];

    constructor(private mapService: MapService,
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

    close() {
        this.stateService.legalInfoDialogVisible = false;
    }
}

