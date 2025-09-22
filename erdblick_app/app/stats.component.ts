import { Component } from "@angular/core";
import { MapService } from "./map.service";
import { debounceTime } from "rxjs";
import { ClipboardService } from "./clipboard.service";

@Component({
    selector: 'stats-dialog',
    template: `
        <p-dialog header="Viewport Statistics" [(visible)]="mapService.statsDialogVisible" [modal]="false"
                  [style]="{'min-height': '20em', 'min-width': '40em', 'width': '40em'}">
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
                <div style="display: inline-block; cursor: pointer" (click)="considerEmptyTiles = !considerEmptyTiles">
                    <p-checkbox inputId="stat-empty-tiles" [(ngModel)]="considerEmptyTiles" [binary]="true" (ngModelChange)="update()"/>
                    <label for="stat-empty-tiles" style="margin-left: 0.5em; cursor: pointer">Consider Empty Tiles</label>
                </div>
                <div>Total number of considered tile layers: {{ consideredTilesCount }}</div>
                <table class="stats-table">
                    <thead>
                        <tr>
                            <th>Statistic</th>
                            <th>Peak Value</th>
                            <th>Sum Value</th>
                            <th>Average Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let stat of aggregatedStats">
                            <td>{{ stat.name }}</td>
                            <td>
                                {{ stat.peak | number: '1.2-2' }}
                                <i class="pi pi-info-circle" (click)="clipboardService.copyToClipboard(getTileIdWithPeak(stat.name))" [pTooltip]="getTileIdWithPeak(stat.name)" tooltipPosition="top"></i>
                            </td>
                            <td>{{ stat.sum | number: '1.2-2' }}</td>
                            <td>{{ stat.average | number: '1.2-2' }}</td>
                        </tr>
                    </tbody>
                </table>
                <button pButton type="button" [label]="needsUpdate ? 'Will update once tiles finished loading. Click to update now.' : 'Up to date.'" icon="pi pi-refresh" (click)="update()"></button>
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
                border: 1px solid var(--p-content-border-color);
                padding: 0.5em;
                text-align: left;
            }
            .stats-table th {
                background-color: var(--p-highlight-background);
                color: var(--p-content-color);
                font-weight: bold;
            }
        `
    ],
    standalone: false
})
export class StatsDialogComponent {
    public aggregatedStats: { name: string, peak: number, average: number, sum: number }[] = [];
    public availableMapLayers: { label: string }[] = [];
    public selectedMapLayers: { label: string }[] = [];
    public considerEmptyTiles: boolean = false;
    public consideredTilesCount: number = 0;
    public needsUpdate: boolean = false;

    constructor(public mapService: MapService, public clipboardService: ClipboardService) {
        this.update();
        this.mapService.statsDialogNeedsUpdate.subscribe(_ => this.needsUpdate = true);
        this.mapService.statsDialogNeedsUpdate.pipe(debounceTime(1000)).subscribe(_ => this.update());
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
        this.consideredTilesCount = 0;
        this.mapService.loadedTileLayers.forEach(tile => {
            if (!this.considerEmptyTiles && tile.numFeatures <= 0) {
                return;
            }
            if (this.selectedMapLayers.findIndex(entry => entry.label == `${tile.mapName} - ${tile.layerName}`) < 0) {
                return;
            }
            this.consideredTilesCount++;
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
            const sum = values.reduce((sum, val) => sum + val, 0);
            const average = sum / values.length;
            return { name: statKey, peak, average, sum };
        }).sort((a, b) => a.name.localeCompare(b.name));

        this.needsUpdate = false;
    }

    getTileIdWithPeak(statName: string): string {
        let peakValue = -Infinity;
        let peakTileId = '';
        this.mapService.loadedTileLayers.forEach(tile => {
            if (!this.considerEmptyTiles && tile.numFeatures <= 0) {
                return;
            }
            if (this.selectedMapLayers.findIndex(entry => entry.label == `${tile.mapName} - ${tile.layerName}`) < 0) {
                return;
            }
            const stats = tile.stats;
            if (stats.has(statName) && stats.get(statName)?.some(v => v > peakValue)) {
                peakValue = Math.max(...stats.get(statName)!);
                peakTileId = String(tile.tileId);
            }
        });
        return peakTileId;
    }
}

