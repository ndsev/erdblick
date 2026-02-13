import {Component, ViewChild} from '@angular/core';
import {combineLatest, map, scan} from 'rxjs';
import {Popover} from 'primeng/popover';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {DiagnosticsSnapshot, ProgressCounter} from './diagnostics.model';

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
                                <span class="diagnostics-label">Backend</span>
                                <span>{{ snapshot.backend.connected ? 'connected' : 'disconnected' }}</span>
                            </div>
                            <diagnostics-progress [progress]="snapshot.progress"></diagnostics-progress>
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

    private shouldShowSpinner(snapshot: DiagnosticsSnapshot): boolean {
        return !this.isCounterComplete(snapshot.progress.rendered);
    }

    private isCounterComplete(counter: ProgressCounter): boolean {
        return !counter.total || counter.done >= counter.total;
    }
}
