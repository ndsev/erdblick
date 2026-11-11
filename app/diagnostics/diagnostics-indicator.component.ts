import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    NgZone,
    OnDestroy,
    ViewChild
} from '@angular/core';
import {combineLatest, Subscription} from 'rxjs';
import {Popover} from 'primeng/popover';
import {DiagnosticsFacadeService} from './diagnostics-facade.service';
import {DiagnosticsSnapshot} from './diagnostics.model';
import {MapTileStreamService} from '../mapdata/map-tile-stream.service';

@Component({
    selector: 'diagnostics-indicator',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="diagnostics-indicator">
            <button class="diagnostics-indicator-button" type="button" (click)="togglePopover($event)"
                    data-testid="diagnostics-status" [attr.data-severity]="statusSeverity"
                    [pTooltip]="statusTooltip" [attr.aria-label]="statusTooltip" tooltipPosition="left">
                @if (showSpinner) {
                    <p-progress-spinner strokeWidth="8" fill="transparent" animationDuration=".5s"
                                        [style]="{ width: '1.75em', height: '1.75em' }"
                                        [class.diagnostics-spinner-paused]="paused" />
                } @else {
                    <i class="pi pi-circle-fill" [class.disconnected]="statusSeverity === 'danger'"
                       [class.degraded]="statusSeverity === 'warn'"></i>
                }
            </button>
            @if (hasError) {
                <button class="diagnostics-indicator-badge" type="button" (click)="openErrors($event)" pTooltip="Open error log" tooltipPosition="left">
                    <span class="material-symbols-outlined">error</span>
                </button>
            }
            <p-popover #popover class="diagnostics-popover" [baseZIndex]="30000" appendTo="diagnostics-indicator">
                <ng-template pTemplate="content">
                    <div class="diagnostics-popover-content">
                        <div class="diagnostics-popover-row">
                            <span class="diagnostics-label">Tiles</span>
                            <span>{{ snapshot.tiles.loaded }} / {{ snapshot.tiles.expected }}</span>
                            @if (snapshot.tiles.errors > 0) {
                                <span class="diagnostics-error">errors {{ snapshot.tiles.errors }}</span>
                            }
                        </div>
                        <div class="diagnostics-popover-row">
                            <span class="diagnostics-label">Backend</span>
                            <span>{{ snapshot.backend.connected ? 'connected' : 'disconnected' }}</span>
                        </div>
                        @if (snapshot.recovery; as recovery) {
                            @if (recovery.failedSourceCount > 0) {
                                <div class="diagnostics-popover-row" data-testid="diagnostics-unavailable-sources">
                                    <p-badge [value]="recovery.failedSourceCount" severity="warn" />
                                    <span>Datasource{{ recovery.failedSourceCount === 1 ? '' : 's' }} unavailable</span>
                                    <span class="material-symbols-outlined diagnostics-help" tabindex="0" role="img"
                                          [attr.aria-label]="recovery.message" data-testid="diagnostics-unavailable-sources-help"
                                          [pTooltip]="recovery.message" tooltipPosition="top" tooltipEvent="both"
                                          tooltipStyleClass="diagnostics-source-tooltip">help</span>
                                </div>
                            } @else if (recovery.failed || recovery.retrying) {
                                <div class="diagnostics-popover-row">
                                    <span class="diagnostics-label">Recovery</span>
                                    <span>{{ recovery.retrying ? 'Retrying' : 'No automatic retry active' }}</span>
                                </div>
                                <div class="diagnostics-popover-row">{{ recovery.message }}</div>
                            }
                        }
                        <diagnostics-progress [progress]="snapshot.progress"></diagnostics-progress>
                        <div class="diagnostics-popover-actions">
                            <div class="open-actions">
                                <p-button size="small" label="Open Statistics" (click)="openPerformance()" />
                                <p-button size="small" label="Open Log" (click)="openLog()" />
                            </div>
                            <p-button size="small" label="Export" (click)="openExport()" />
                        </div>
                    </div>
                </ng-template>
            </p-popover>
        </div>
    `,
    standalone: false
})
/** Compact diagnostics entry point shown in the main UI chrome. */
export class DiagnosticsIndicatorComponent implements AfterViewInit, OnDestroy {
    @ViewChild('popover') popover?: Popover;

    protected snapshot: DiagnosticsSnapshot;
    protected paused: boolean;
    protected showSpinner: boolean;
    protected hasError: boolean;
    private readonly subscriptions = new Subscription();
    private viewInitialized = false;

    constructor(private readonly diagnostics: DiagnosticsFacadeService,
                private readonly mapService: MapTileStreamService,
                private readonly changeDetector: ChangeDetectorRef,
                private readonly ngZone: NgZone) {
        this.snapshot = diagnostics.snapshot$.getValue();
        this.paused = mapService.tilePipelinePaused;
        this.showSpinner = this.shouldShowSpinner(this.snapshot);
        this.hasError = this.snapshot.tiles.errors > 0 ||
            diagnostics.logs$.getValue().some(entry => entry.level === 'error');

        // AsyncPipe marks its ancestors and schedules an application-wide tick.
        // Keep the always-mounted indicator subscription outside Angular and
        // explicitly check only its small local view when diagnostics change.
        this.ngZone.runOutsideAngular(() => {
            this.subscriptions.add(combineLatest([
                diagnostics.snapshot$,
                mapService.tilePipelinePaused$,
                diagnostics.logs$
            ]).subscribe(([snapshot, paused, logs]) => {
                this.snapshot = snapshot;
                this.paused = paused;
                this.showSpinner = this.shouldShowSpinner(snapshot);
                this.hasError = this.hasError || snapshot.tiles.errors > 0 ||
                    logs.some(entry => entry.level === 'error');
                if (this.viewInitialized) {
                    this.changeDetector.detectChanges();
                }
            }));
        });
    }

    /** Enables local checks only after Angular has completed the initial render. */
    ngAfterViewInit(): void {
        this.viewInitialized = true;
    }

    /** Releases the manually managed diagnostics subscriptions. */
    ngOnDestroy(): void {
        this.viewInitialized = false;
        this.subscriptions.unsubscribe();
    }

    /** Toggles the diagnostics popover. */
    togglePopover(event: MouseEvent) {
        this.popover?.toggle(event);
    }

    /** Opens the full performance dialog and closes the popover. */
    openPerformance() {
        this.diagnostics.openPerformanceDialog();
        this.popover?.hide();
    }

    /** Opens the diagnostics log and closes the popover. */
    openLog() {
        this.diagnostics.openLogDialog();
        this.popover?.hide();
    }

    /** Opens the export dialog with all sections enabled and closes the popover. */
    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: true,
            includePerformance: true,
            includeLogs: true
        });
        this.popover?.hide();
    }

    /** Opens the diagnostics log prefiltered to errors without toggling the popover button itself. */
    openErrors(event: MouseEvent) {
        event.stopPropagation();
        this.diagnostics.openLogDialog(true);
    }

    /** Describes current recovery without conflating it with the persistent error-log badge. */
    protected get statusTooltip(): string {
        const recovery = this.snapshot.recovery;
        const count = recovery?.failedSourceCount ?? 0;
        const status = this.statusSeverity === 'danger'
            ? recovery?.backendRetrying ? "Reconnecting to the backend…" : "Backend connection unavailable."
            : count > 0 ? count === recovery?.sourceCount
                ? "Backend connected. No datasource available."
                : `Backend connected. ${count} datasource${count === 1 ? '' : 's'} unavailable.`
            : recovery?.catalogFailed ? "Backend connected. Datasource metadata needs attention."
            : this.showSpinner ? "Loading map data…" : "Connected.";
        return `${status} ${this.snapshot.recovery?.message || "Open progress statistics."}`;
    }

    /** Backend failure takes precedence over degradation within a reachable backend. */
    protected get statusSeverity(): 'success' | 'warn' | 'danger' {
        if (!this.snapshot.backend.connected || this.snapshot.recovery?.backendFailed) return 'danger';
        return this.snapshot.recovery?.failed ? 'warn' : 'success';
    }

    /** Pending counters alone cannot prove loading: they can remain incomplete throughout an outage. */
    private shouldShowSpinner(snapshot: DiagnosticsSnapshot): boolean {
        return snapshot.backend.connected && !snapshot.recovery?.backendFailed && snapshot.loading === true;
    }
}
