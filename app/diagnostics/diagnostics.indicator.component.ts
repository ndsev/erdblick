import {Component, ViewChild} from '@angular/core';
import {combineLatest, map} from 'rxjs';
import {Popover} from 'primeng/popover';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {ProgressCounter, TilePipelineProgress} from './diagnostics.model';

interface ProgressStage {
    key: keyof TilePipelineProgress;
    label: string;
}

@Component({
    selector: 'diagnostics-indicator',
    template: `
        <div class="diagnostics-indicator">
            <button class="diagnostics-indicator-button" type="button" (click)="togglePopover($event)">
                @if ((progressRatio$ | async) ?? 0 < 1) {
                    <p-progress-spinner strokeWidth="8" fill="transparent" animationDuration=".5s" [style]="{ width: '1.75em', height: '1.75em' }" />
                } @else {
                    <i class="pi pi-circle-fill" style="color: green; font-size: 1.75em"></i>
                }
            </button>
            @if (hasError$ | async) {
                <button class="diagnostics-indicator-badge" type="button" (click)="openErrors($event)" pTooltip="Open error log" tooltipPosition="bottom">
                    <span class="material-symbols-outlined">error</span>
                </button>
            }
            <p-popover #popover class="diagnostics-popover" [baseZIndex]="30000">
                <ng-template pTemplate="content">
                    @if (snapshot$ | async; as snapshot) {
                        <div class="diagnostics-popover-content">
                            <div class="diagnostics-popover-row">
                                <span class="diagnostics-label">Tiles</span>
                                <span>{{ snapshot.tiles.loaded }} / {{ snapshot.tiles.expected }}</span>
                                <span class="diagnostics-muted">cached {{ snapshot.tiles.cached }}</span>
                                @if (snapshot.tiles.errors > 0) {
                                    <span class="diagnostics-error">errors {{ snapshot.tiles.errors }}</span>
                                }
                            </div>
                            <div class="diagnostics-popover-row">
                                <span class="diagnostics-label">Visualizations</span>
                                <span>{{ snapshot.visualizations.present }} present</span>
                                <span class="diagnostics-muted">queue {{ snapshot.visualizations.queue }}</span>
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
                                <p-button size="small" label="Open Progress" (click)="openProgress()" />
                                <p-button size="small" label="Open Performance" (click)="openPerformance()" />
                                <p-button size="small" label="Open Log" (click)="openLog()" />
                                <p-button size="small" label="Export…" (click)="openExport()" />
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
    readonly progressRatio$ = this.snapshot$.pipe(
        map(snapshot => this.progressRatio(snapshot.progress.rendered))
    );
    readonly hasError$ = combineLatest([this.snapshot$, this.diagnostics.logs$]).pipe(
        map(([snapshot, logs]) => {
            if (snapshot.tiles.errors > 0) {
                return true;
            }
            const cutoff = Date.now() - 60_000;
            return logs.some(entry => entry.level === 'error' && entry.at >= cutoff);
        })
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

    openProgress() {
        this.diagnostics.openProgressDialog();
        this.popover?.hide();
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
        return Math.round((counter.done / counter.total) * 100);
    }

    private progressRatio(counter: ProgressCounter): number {
        if (!counter.total) {
            return 0;
        }
        return counter.done / counter.total;
    }
}
