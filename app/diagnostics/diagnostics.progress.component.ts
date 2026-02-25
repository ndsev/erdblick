import {Component, Input} from '@angular/core';
import {LoadingStatBubbles, ProgressCounter, TilePipelineProgress} from './diagnostics.model';
import {MapDataService} from '../mapdata/map.service';

interface ProgressBar {
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
                @for (bar of progressBars; track bar.key) {
                    <div class="diagnostics-progress-item">
                        <span class="diagnostics-stage-label">{{ bar.label }}</span>
                        <div class="diagnostics-stage-bar" [style.--diagnostics-progress]="progressPercent(bar.counter) + '%'">
                            <p-progressBar [value]="progressPercent(bar.counter)" [dt]="bar.color" [showValue]="false"></p-progressBar>
                            <span class="diagnostics-stage-bar-value">
                                {{ bar.counter.done }} / {{ bar.counter.total }}
                            </span>
                        </div>
                    </div>
                }
                <div class="diagnostics-loading-bubbles">
                    <span class="diagnostics-loading-bubble">{{ formatThroughput(bubbles.downstreamBytesPerSecond) }}</span>
                    <span class="diagnostics-loading-bubble">
                        {{ formatCompressionBubble(
                            bubbles.pullCompressionRatioPct,
                            bubbles.pullCompressionCoveragePct,
                            bubbles.pullCompressedBytesKnown,
                            bubbles.pullUncompressedBytes
                        ) }}
                    </span>
                    <span class="diagnostics-loading-bubble">{{ formatInt(bubbles.features) }} Feats.</span>
                    <span class="diagnostics-loading-bubble">{{ formatInt(bubbles.vertices) }} Verts.</span>
                    <span class="diagnostics-loading-bubble">{{ formatInt(bubbles.parseQueueSize) }} ParseQ</span>
                    <span class="diagnostics-loading-bubble">{{ formatInt(bubbles.renderQueueSize) }} RenderQ</span>
                    <span class="diagnostics-loading-bubble">{{ formatSeconds(bubbles.renderSeconds) }}</span>
                </div>
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

    get progressBars(): ProgressBar[] {
        const stageCounters = this.progress?.stages ?? [];
        const stageBars = stageCounters.map((counter, stage) => ({
            key: `stage-${stage}`,
            label: `Stage ${stage} Received`,
            counter,
            color: {value: {background: '{cyan.500}'}}
        }));
        return [
            {
            key: 'backend',
            label: 'Backend',
            counter: this.progress?.backend ?? {done: 0, total: 0},
            color: {value: {background: '{blue.500}'}}
        },
        ...stageBars,
        {
            key: 'rendered',
            label: 'Rendered',
            counter: this.progress?.rendered ?? {done: 0, total: 0},
            color: {value: {background: '{emerald.500}'}}
        }
        ];
    }

    get bubbles(): LoadingStatBubbles {
        return this.progress?.bubbles ?? {
            downstreamBytesPerSecond: 0,
            pullResponses: 0,
            pullGzipResponses: 0,
            pullUncompressedBytes: 0,
            pullCompressedBytesKnown: 0,
            pullCompressionRatioPct: null,
            pullCompressionCoveragePct: 0,
            features: 0,
            vertices: 0,
            parseQueueSize: 0,
            renderQueueSize: 0,
            renderSeconds: 0,
        };
    }

    togglePause() {
        this.mapService.toggleTilePipelinePause();
    }

    get isProgressComplete(): boolean {
        return this.progressBars.every(bar => this.progressPercent(bar.counter) === 100);
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

    formatInt(value: number): string {
        return Math.max(0, Math.floor(value || 0)).toLocaleString();
    }

    formatThroughput(bytesPerSecond: number): string {
        const mbPerSecond = Math.max(0, bytesPerSecond || 0) / (1024 * 1024);
        return `${mbPerSecond.toFixed(2)} MB/s`;
    }

    formatCompressionBubble(
        ratioPct: number | null,
        coveragePct: number,
        compressedKnownBytes: number,
        uncompressedBytes: number): string {
        const hasData = (compressedKnownBytes || 0) > 0 && (uncompressedBytes || 0) > 0;
        if (!hasData || ratioPct === null || !Number.isFinite(ratioPct)) {
            return 'Cmp n/a';
        }
        const clampedRatio = Math.max(0, Math.min(100, ratioPct));
        const clampedCoverage = Math.max(0, Math.min(100, coveragePct || 0));
        const compressedMb = Math.max(0, compressedKnownBytes) / (1024 * 1024);
        return `Cmp ${clampedRatio.toFixed(1)}% @ ${clampedCoverage.toFixed(0)}% (${compressedMb.toFixed(1)} MB)`;
    }

    formatSeconds(seconds: number): string {
        const safe = Math.max(0, seconds || 0);
        return `${safe.toFixed(1)} s`;
    }
}
