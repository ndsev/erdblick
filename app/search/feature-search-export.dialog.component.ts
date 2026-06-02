import {Component, OnDestroy, ViewChild} from "@angular/core";
import {Subscription} from "rxjs";
import {FeatureSearchExportDialogRequest, FeatureSearchService} from "./feature.search.service";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppStateService, FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID} from "../shared/appstate.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {InfoMessageService} from "../shared/info.service";
import {
    featureSearchExportFilename,
    featureSearchExportPayload,
    featureSearchJsonReplacer,
    type FeatureSearchExportSelection
} from "./feature-search-export.util";

interface FeatureSearchExportOptions extends FeatureSearchExportSelection {
    closeAfterExport: boolean;
}

@Component({
    selector: "feature-search-export-dialog",
    template: `
        <app-dialog #dialog header="Export Feature Search" class="feature-search-export-dialog" [(visible)]="dialogVisible"
                    [modal]="false" [persistLayout]="true" [layoutId]="layoutId" (onShow)="onDialogShow()">
            <div class="feature-search-export-content">
                <div class="feature-search-export-section">
                    <div class="feature-search-export-label">Include</div>
                    <div class="feature-search-export-options">
                        <p-checkbox inputId="feature-search-export-configuration"
                                    [(ngModel)]="exportOptions.includeConfiguration"
                                    [binary]="true">
                        </p-checkbox>
                        <label for="feature-search-export-configuration">Search Configuration</label>
                        <p-checkbox inputId="feature-search-export-results"
                                    [(ngModel)]="exportOptions.includeResults"
                                    [binary]="true">
                        </p-checkbox>
                        <label for="feature-search-export-results">Search Results</label>
                    </div>
                </div>

                <div class="feature-search-export-actions">
                    <p-button label="Export"
                              [disabled]="!canExport || exporting"
                              (click)="export()">
                    </p-button>
                </div>
            </div>
        </app-dialog>
    `,
    styles: [``],
    standalone: false
})
/** Dialog that configures and launches feature-search JSON exports. */
export class FeatureSearchExportDialogComponent implements OnDestroy {
    readonly layoutId = FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID;
    @ViewChild('dialog') dialog?: AppDialogComponent;
    exporting = false;
    exportOptions: FeatureSearchExportOptions = this.defaultExportOptions();
    request: FeatureSearchExportDialogRequest | null = null;

    private readonly subscription: Subscription;

    constructor(public readonly searchService: FeatureSearchService,
                public readonly stateService: AppStateService,
                private readonly dialogStack: DialogStackService,
                private readonly infoMessageService: InfoMessageService) {
        this.subscription = this.searchService.exportDialogRequest.subscribe(request => {
            this.request = request;
            this.exportOptions = request
                ? {
                    includeConfiguration: request.includeConfiguration,
                    includeResults: request.includeResults,
                    closeAfterExport: request.closeAfterExport
                }
                : this.defaultExportOptions();
        });
    }

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.layoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.layoutId, visible);
        if (!visible) {
            this.searchService.clearExportDialogRequest();
        }
    }

    /** Releases the export-request subscription. */
    ngOnDestroy(): void {
        this.subscription.unsubscribe();
    }

    /** Promotes the export dialog above other overlays. */
    onDialogShow(): void {
        this.dialogStack.bringToFront(this.dialog);
    }

    /** Returns whether there is an active search and at least one category selected. */
    get canExport(): boolean {
        return !!this.session
            && (this.exportOptions.includeConfiguration || this.exportOptions.includeResults);
    }

    /** Builds and downloads the selected feature-search JSON payload. */
    export(): void {
        const request = this.request;
        const session = this.session;
        if (!request || !session || !this.canExport || this.exporting) {
            return;
        }

        this.exporting = true;
        try {
            const selection = this.currentSelection();
            const payload = featureSearchExportPayload(
                session.definition,
                session.searchResults,
                request.grouping,
                request.filterValue,
                selection
            );
            if (!payload) {
                return;
            }
            this.downloadJsonFile(featureSearchExportFilename(session.id, selection), payload);
            this.infoMessageService.showSuccess("Feature search JSON export started");
            if (this.exportOptions.closeAfterExport) {
                this.searchService.closeSearch(session.id);
                this.dialogVisible = false;
            }
        } finally {
            this.exporting = false;
        }
    }

    private get session() {
        return this.request ? this.searchService.getSession(this.request.searchId) : undefined;
    }

    private currentSelection(): FeatureSearchExportSelection {
        return {
            includeConfiguration: this.exportOptions.includeConfiguration,
            includeResults: this.exportOptions.includeResults
        };
    }

    private defaultExportOptions(): FeatureSearchExportOptions {
        return {
            includeConfiguration: true,
            includeResults: true,
            closeAfterExport: false
        };
    }

    private downloadJsonFile(filename: string, payload: unknown): void {
        const source = JSON.stringify(payload, featureSearchJsonReplacer, 2) ?? "null";
        const blob = new Blob([source], {type: "application/json;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}
