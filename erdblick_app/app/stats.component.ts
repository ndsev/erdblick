import {Component} from "@angular/core";
import {MapService} from "./map.service";

@Component({
    selector: 'stats-dialog',
    template: `
        <p-dialog header="Viewport Statistics" [(visible)]="mapService.statsDialogVisible" [modal]="false"
                  [style]="{'min-height': '20em', 'min-width': '40em'}">
            <div class="dialog-content">
                <p-multiSelect
                        [options]="availableMapLayers"
                        [(ngModel)]="selectedMapLayers"
                        (ngModelChange)="update()"
                        optionLabel="label"
                        placeholder="Select Map Layers"
                        [showHeader]="false"
                        [style]="{'width': '100%'}">
                </p-multiSelect>
                <p-checkbox label="Consider Empty Tiles" [(ngModel)]="considerEmptyTiles" [binary]="true" (ngModelChange)="update()"></p-checkbox>
                <table class="stats-table">
                    <thead>
                    <tr>
                        <th>Statistic</th>
                        <th>Peak Value</th>
                        <th>Average Value</th>
                    </tr>
                    </thead>
                    <tbody>
                    <tr *ngFor="let stat of aggregatedStats">
                        <td>{{ stat.name }}</td>
                        <td>{{ stat.peak | number: '1.2-2' }}</td>
                        <td>{{ stat.average | number: '1.2-2' }}</td>
                    </tr>
                    </tbody>
                </table>
                <button pButton type="button" label="Update" icon="pi pi-refresh" (click)="update()"></button>
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
    ]
})
export class StatsDialogComponent {
    public aggregatedStats: { name: string, peak: number, average: number }[] = [];
    public availableMapLayers: { label: string }[] = [];
    public selectedMapLayers: { label: string }[] = [];
    public considerEmptyTiles: boolean = false;

    constructor(public mapService: MapService) {
        this.update();
    }

    update(): void {
        // Rescan available map layers
        const mapLayersSet: Set<string> = new Set();
        this.mapService.loadedTileLayers.forEach(tile => {
            mapLayersSet.add(`${tile.mapName} - ${tile.layerName}`);
        });
        const newAvailableMapLayers = Array.from(mapLayersSet).map(layer => ({ label: layer }));
        if (JSON.stringify(newAvailableMapLayers) !== JSON.stringify(this.availableMapLayers)) {
            this.availableMapLayers = newAvailableMapLayers;
            if (!this.selectedMapLayers.length) {
                this.selectedMapLayers = newAvailableMapLayers;
            }
            else {
                this.selectedMapLayers = this.selectedMapLayers.filter(sel => this.availableMapLayers.findIndex(entry => entry.label == sel.label) >= 0);
            }
        }
        const statsAccumulator: Map<string, number[]> = new Map();

        // Accumulate statistics from all tiles
        this.mapService.loadedTileLayers.forEach(tile => {
            if (!this.considerEmptyTiles && tile.numFeatures <= 0) {
                return;
            }
            if (this.selectedMapLayers.findIndex(entry => entry.label == `${tile.mapName} - ${tile.layerName}`) < 0) {
                return;
            }
            const stats = tile.stats;
            for (let [key, value] of stats.entries()) {
                if (!statsAccumulator.has(key)) {
                    statsAccumulator.set(key, []);
                }
                statsAccumulator.set(key, statsAccumulator.get(key)!.concat(value));
            }
        });

        // Calculate peak and average for each statistic
        this.aggregatedStats = Array.from(statsAccumulator.entries()).map(([statKey, values]) => {
            const peak = Math.max(...values);
            const average = values.reduce((sum, val) => sum + val, 0) / values.length;
            return { name: statKey, peak, average };
        });
    }
}