import {Component, Input} from '@angular/core';
import {ProgressCounter, TilePipelineProgress} from './diagnostics.model';
import {MapDataService} from '../mapdata/map.service';

interface ProgressStage {
    key: string;
    label: string;
    counter: ProgressCounter;
    color?: Record<string, any>;
}

@Component({
    selector: 'diagnostics-progress',
    template: `
        <div class="diagnostics-progress">
            <div class="diagnostics-progress-list">
                @for (stage of progressStages; track stage.key) {
                    <div class="diagnostics-progress-item">
                        <span class="diagnostics-stage-label">{{ stage.label }}</span>
                        <div class="diagnostics-stage-bar" [style.--diagnostics-progress]="progressPercent(stage.counter) + '%'">
                            <p-progressBar [value]="progressPercent(stage.counter)" [dt]="stage.color" [showValue]="false"></p-progressBar>
                            <span class="diagnostics-stage-bar-value">
                                {{ stage.counter.done }} / {{ stage.counter.total }}
                            </span>
                        </div>
                    </div>
                }
            </div>
            <div class="diagnostics-progress-actions">
                @if (paused$ | async) {
                    <p-button size="small" label="" icon="pi pi-play" pTooltip="Resume tile requesting/loading/rendering"
                            tooltipPosition="top" (click)="togglePause()">
                    </p-button>
                } @else {
                    <p-button size="small" label="" icon="pi pi-pause" pTooltip="Pause tile requesting/loading/rendering" 
                              tooltipPosition="top" [disabled]="isProgressComplete" (click)="togglePause()">
                    </p-button>
                }
            </div>
        </div>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsProgressComponent {
    @Input({required: true}) progress!: TilePipelineProgress;
    readonly paused$ = this.mapService.tilePipelinePaused$;

    constructor(private readonly mapService: MapDataService) {}

    get progressStages(): ProgressStage[] {
        const stageCounters = this.progress?.stages ?? [];
        const stages = stageCounters.map((counter, index) => ({
            key: `stage-${index}`,
            label: `Stage ${index} Received`,
            counter,
            color: {value: {background: '{blue.500}'}}
        }));
        stages.push({
            key: 'rendered',
            label: 'Rendered',
            counter: this.progress?.rendered ?? {done: 0, total: 0},
            color: {value: {background: '{emerald.500}'}}
        });
        return stages;
    }

    togglePause() {
        this.mapService.toggleTilePipelinePause();
    }

    get isProgressComplete(): boolean {
        return this.progressStages.every(stage => this.progressPercent(stage.counter) === 100);
    }

    progressPercent(counter: ProgressCounter): number {
        if (!counter.total) {
            return 0;
        }
        if (counter.done >= counter.total) {
            return 100;
        }
        const percent = Math.floor((counter.done / counter.total) * 100);
        return Math.max(0, Math.min(99, percent));
    }
}
