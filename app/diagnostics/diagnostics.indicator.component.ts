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
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {DiagnosticsSnapshot, ProgressCounter} from './diagnostics.model';
import {MapTileStreamService} from '../mapdata/map-tile-stream.service';

@Component({
    selector: 'diagnostics-indicator',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="diagnostics-indicator">
            <button class="diagnostics-indicator-button" type="button" (click)="togglePopover($event)" pTooltip="Open progress statistics" tooltipPosition="left">
                @if (showSpinner) {
                    <p-progress-spinner strokeWidth="8" fill="transparent" animationDuration=".5s"
                                        [style]="{ width: '1.75em', height: '1.75em' }"
                                        [class]="paused ? 'diagnostics-spinner-paused' : ''" />
                } @else {
                    <i class="pi pi-circle-fill" [class.disconnected]="!snapshot.backend.connected"></i>
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

    /** Shows the spinner while backend or rendering progress is still incomplete. */
    private shouldShowSpinner(snapshot: DiagnosticsSnapshot): boolean {
        return !this.isCounterComplete(snapshot.progress.backend)
            || !this.isCounterComplete(snapshot.progress.rendered);
    }

    /** Treats counters with no total as already complete to avoid spinner lockup. */
    private isCounterComplete(counter: ProgressCounter): boolean {
        return !counter.total || counter.done >= counter.total;
    }
}
