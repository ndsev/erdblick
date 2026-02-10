import {Component, ViewChild} from '@angular/core';
import {combineLatest, map, scan} from 'rxjs';
import {Popover} from 'primeng/popover';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {DiagnosticsSnapshot, ProgressCounter, TilePipelineProgress} from './diagnostics.model';

interface ProgressStage {
    key: keyof TilePipelineProgress;
    label: string;
}

@Component({
    selector: 'diagnostics-indicator',
    template: `
        <div class="diagnostics-indicator">
            <button class="diagnostics-indicator-button" type="button" (click)="togglePopover($event)" pTooltip="Open progress statistics" tooltipPosition="left">
                @if (showSpinner$ | async) {
                    <p-progress-spinner strokeWidth="8" fill="transparent" animationDuration=".5s" [style]="{ width: '1.75em', height: '1.75em' }" />
                } @else {
                    <i class="pi pi-circle-fill" [class.disconnected]="!(backendConnected$ | async)"></i>
                }
            </button>
            @if (hasError$ | async) {
                <button class="diagnostics-indicator-badge" type="button" (click)="openErrors($event)" pTooltip="Open error log" tooltipPosition="left">
                    <span class="material-symbols-outlined">error</span>
                </button>
            }
            <p-popover #popover class="diagnostics-popover" [baseZIndex]="30000" appendTo="diagnostics-indicator">
                <ng-template pTemplate="content">
                    @if (snapshot$ | async; as snapshot) {
                        <div class="diagnostics-popover-content">
                            <div class="diagnostics-popover-row">
                                <span class="diagnostics-label">Tiles</span>
                                <span>{{ snapshot.tiles.loaded }} / {{ snapshot.tiles.expected }}</span>
                                <span class="diagnostics-muted">cached n/a</span>
                                @if (snapshot.tiles.errors > 0) {
                                    <span class="diagnostics-error">errors {{ snapshot.tiles.errors }}</span>
                                }
                            </div>
                            <div class="diagnostics-popover-row">
                                <span class="diagnostics-label">Visualizations</span>
                                <span>{{ visualizationSummary(snapshot) }}</span>
                                <span class="diagnostics-muted">{{ queueSummary(snapshot.visualizations.queue) }}</span>
                            </div>
                            <div class="diagnostics-popover-row">
                                <span class="diagnostics-label">Backend</span>
                                <span>{{ snapshot.backend.connected ? 'connected' : 'disconnected' }}</span>
                            </div>
                            <div class="diagnostics-progress-list">
                                @for (stage of progressStages; track stage.key) {
                                    <div class="diagnostics-progress-item">
                                        <span class="diagnostics-stage-label">{{ stage.label }}</span>
                                        <p-progressBar [value]="progressPercent(snapshot.progress[stage.key])" [showValue]="false"></p-progressBar>
                                        <span class="diagnostics-stage-count">{{ snapshot.progress[stage.key].done }} / {{ snapshot.progress[stage.key].total }}</span>
                                    </div>
                                }
                            </div>
                            <div class="diagnostics-popover-actions">
                                <div class="open-actions">
                                    <p-button size="small" label="Open Statistics" (click)="openPerformance()" />
                                    <p-button size="small" label="Open Log" (click)="openLog()" />
                                </div>
                                <p-button size="small" label="Export" (click)="openExport()" />
                            </div>
                        </div>
                    }
                </ng-template>
            </p-popover>
        </div>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsIndicatorComponent {
    @ViewChild('popover') popover?: Popover;

    readonly snapshot$ = this.diagnostics.snapshot$;
    readonly showSpinner$ = this.snapshot$.pipe(
        map(snapshot => this.shouldShowSpinner(snapshot))
    );
    readonly backendConnected$ = this.snapshot$.pipe(
        map(snapshot => snapshot.backend.connected)
    );
    readonly hasError$ = combineLatest([this.snapshot$, this.diagnostics.logs$]).pipe(
        map(([snapshot, logs]) => snapshot.tiles.errors > 0 || logs.some(entry => entry.level === 'error')),
        scan((hasSeenError, hasError) => hasSeenError || hasError, false)
    );

    readonly progressStages: ProgressStage[] = [
        {key: 'requested', label: 'Requested'},
        {key: 'fetched', label: 'Fetched'},
        {key: 'converted', label: 'Converted'},
        {key: 'received', label: 'Received'},
        {key: 'rendered', label: 'Rendered'}
    ];

    constructor(private readonly diagnostics: DiagnosticsFacadeService) {}

    togglePopover(event: MouseEvent) {
        this.popover?.toggle(event);
    }

    openPerformance() {
        this.diagnostics.openPerformanceDialog();
        this.popover?.hide();
    }

    openLog() {
        this.diagnostics.openLogDialog();
        this.popover?.hide();
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: true,
            includePerformance: true,
            includeLogs: true
        });
        this.popover?.hide();
    }

    openErrors(event: MouseEvent) {
        event.stopPropagation();
        this.diagnostics.openLogDialog(true);
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

    private shouldShowSpinner(snapshot: DiagnosticsSnapshot): boolean {
        const receivingDone = this.isCounterComplete(snapshot.progress.received);
        return !receivingDone || snapshot.visualizations.queue > 0;
    }

    visualizationSummary(snapshot: DiagnosticsSnapshot): string {
        const tileCount = snapshot.visualizations.tilesWithFeatures;
        const featureCount = snapshot.visualizations.features;
        return `${tileCount} ${this.pluralize(tileCount, 'tile')} (${featureCount} ${this.pluralize(featureCount, 'feature')})`;
    }

    queueSummary(queueCount: number): string {
        return `queue ${queueCount} ${this.pluralize(queueCount, 'tile')}`;
    }

    private pluralize(count: number, singular: string): string {
        return count === 1 ? singular : `${singular}s`;
    }

    private isCounterComplete(counter: ProgressCounter): boolean {
        return !counter.total || counter.done >= counter.total;
    }
}
