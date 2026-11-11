import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, NgZone, OnChanges, OnDestroy } from "@angular/core";
import type { MeterItem } from "primeng/types/metergroup";
import type { FeatureSearchScope } from "./search-definition.model";
import type { FeatureSearchSession } from "./search-session.model";
import type { FeatureSearchAttributeScopeCandidate } from "./search.model";
import {
    DiagnosticsMessage,
    SearchResultFieldValueSummary,
    SearchValueSummariesState,
    SearchValueSummary
} from "./search.model";
import { SearchService } from "./search.service";

const INTERNAL_SEARCH_RESULT_FIELDS = new Set(["$layer", "$name", "$validityCount", "$validityIndex"]);

/** Presents search diagnostics or its compact progress strip without owning summary computation. */
@Component({selector: "search-diagnostics", changeDetection: ChangeDetectionStrategy.OnPush, standalone: false, host: {style: "display:contents"},
    template: `@if (mode === 'progress') {            <div class="feature-search-controls">
                <div class="feature-search-progress-meter" [title]="progressTooltip"
                     role="progressbar" aria-valuemin="0" aria-valuemax="100"
                     [attr.aria-valuenow]="progressDisplayPercent" [attr.aria-valuetext]="progressLabel">
                    <p-metergroup [value]="progressMeterItems"
                                  [min]="0"
                                  [max]="100"
                                  labelPosition="end"
                                  labelOrientation="horizontal">
                    </p-metergroup>
                    <span class="feature-search-progress-label"
                          [style.--feature-search-progress]="progressDisplayPercent + '%'">
                        @if (finishingResults) { <i class="pi pi-spinner pi-spin" aria-hidden="true"></i> }
                        {{ progressLabel }}
                    </span>
                </div>
            </div>
} @else {
                        <div id="searchDiagnosticsPanel">
                            @if (diagnostics.length > 0) {
                                <section class="feature-search-diagnostics-section">
                                    <h3>Messages</h3>
                                    <ul class="feature-search-diagnostics-list">
                                    @for (message of diagnostics; track message) {
                                        <li>
                                            <div>
                                                <span>{{ message.message }}</span>
                                                <div *ngIf="message.query.length > 0">
                                                    <span>Here: </span>
                                                    <code style="width: 100%;"
                                                          [innerHTML]="message.query | highlightRegion: message.location?.offset:message.location?.size:25"></code>
                                                </div>
                                            </div>
                                            <p-button size="small" label="Fix" *ngIf="message.fix"
                                                      (onClick)="onApplyFix(message)"/>
                                        </li>
                                    }
                                    </ul>
                                </section>
                            }

                            <section class="feature-search-diagnostics-section">
                                <h3>Query</h3>
                                <div class="feature-search-query-diagnostics-grid">
                                    <span>Query</span>
                                    <code>{{ session?.definition?.query ?? '' }}</code>
                                    <span>Backend query</span>
                                    <code>{{ session?.schemaAnalysis?.normalizedQuery || session?.definition?.query || '' }}</code>
                                    <span>Scope</span>
                                    <span [title]="featureSearchScopeSummaryTitle">
                                        {{ featureSearchScopeSummary || 'Unknown' }}
                                    </span>
                                    <span>Attribute candidates</span>
                                    <span>{{ session?.schemaAnalysis?.attributeScopeCandidateCount ?? 0 }}</span>
                                    <span>Elapsed</span>
                                    <span>{{ searchTimeElapsed }}</span>
                                    <span>Features</span>
                                    <span>{{ searchTotalFeatureCount }}</span>
                                    <span>Matched</span>
                                    <span>{{ resultCount }}</span>
                                </div>
                            </section>

                            <section class="feature-search-diagnostics-section">
                                <div class="feature-search-values-heading">
                                    <h3>Values</h3>
                                    @if (valueSummaryWaitingForIngress()) {
                                        <span class="feature-search-values-waiting">{{ valueSummaryWaitLabel() }}</span>
                                    } @else if (valueSummaries.status === 'idle') {
                                        <p-button size="small" label="Load" severity="secondary"
                                                  (onClick)="requestDiagnosticsValueSummaries()"/>
                                    }
                                </div>
                                @if (valueSummaries.status === 'loading') {
                                    <div class="feature-search-values-loading">
                                        <p-progress-spinner strokeWidth="10" fill="transparent" animationDuration=".7s"
                                                            [style]="{ width: '1.2em', height: '1.2em', margin: '0' }"/>
                                        <span>Summarizing {{ valueSummaries.processedTiles }} / {{ valueSummaries.totalTiles }} result tiles...</span>
                                    </div>
                                } @else if (valueSummaries.status === 'error') {
                                    <div class="feature-search-values-empty">
                                        Failed to summarize values.
                                        <pre *ngIf="valueSummaries.error">{{ valueSummaries.error }}</pre>
                                    </div>
                                } @else if (valueSummaries.status === 'empty') {
                                    <div class="feature-search-values-empty">No withFields or trace values available.</div>
                                } @else if (valueSummaries.status === 'ready') {
                                    @if (diagnosticsVisibleResultFields().length === 0 && valueSummaries.traces.length === 0) {
                                        <div class="feature-search-values-empty">No user-visible style or trace values available.</div>
                                    } @else {
                                        <div class="feature-search-value-card-grid">
                                            @for (field of diagnosticsVisibleResultFields(); track field.index + ':' + field.expression + ':' + (field.summary.schemaType?.schemaId ?? '') + ':' + (field.summary.schemaType?.typeId ?? '')) {
                                                <article class="feature-search-value-card">
                                                    <header>
                                                        <span>Field</span>
                                                        <code>{{ field.expression }}</code>
                                                    </header>
                                                    <ng-container *ngTemplateOutlet="valueSummaryTemplate; context: {$implicit: field.summary}"/>
                                                </article>
                                            }
                                            @for (trace of valueSummaries.traces; track trace.name) {
                                                <article class="feature-search-value-card">
                                                    <header>
                                                        <span>Trace</span>
                                                        <code>{{ trace.name }}</code>
                                                    </header>
                                                    <div class="feature-search-value-card-meta">
                                                        <span>{{ trace.calls }} calls</span>
                                                        <span>{{ trace.totalus }} &mu;s</span>
                                                    </div>
                                                    <ng-container *ngTemplateOutlet="valueSummaryTemplate; context: {$implicit: trace.summary}"/>
                                                </article>
                                            }
                                        </div>
                                    }
                                }
                            </section>
                        </div>

                        <ng-template #valueSummaryTemplate let-summary>
                            <div class="feature-search-value-summary">
                                <div class="feature-search-value-summary-row">
                                    <span>Samples</span>
                                    <strong>{{ summary.count }}</strong>
                                </div>
                                @if (summary.schemaType) {
                                    <div class="feature-search-value-summary-row" [title]="summary.schemaType.schemaId + ':' + summary.schemaType.typeId">
                                        <span>Type</span>
                                        <strong>{{ summary.schemaType.typeName || 'Qualified value' }}</strong>
                                    </div>
                                }
                                @if (summary.numeric) {
                                    <div class="feature-search-value-summary-row">
                                        <span>Numeric</span>
                                        <strong>{{ numericSummaryLabel(summary) }}</strong>
                                    </div>
                                }
                                <div class="feature-search-value-kind-list">
                                    @for (entry of summaryKindEntries(summary); track entry.label) {
                                        <span>{{ entry.label }} {{ entry.count }}</span>
                                    }
                                </div>
                                @if (summary.histogram.length > 0) {
                                    <div class="feature-search-value-histogram">
                                        @for (bucket of visibleHistogramBuckets(summary); track bucket.value) {
                                            <div>
                                                <span>{{ bucket.value }}</span>
                                                <strong>{{ bucket.count }}</strong>
                                            </div>
                                        }
                                        @if (summary.otherCount > 0 || summary.distinctLimitReached) {
                                            <div>
                                                <span>Other</span>
                                                <strong>{{ summary.otherCount }}{{ summary.distinctLimitReached ? '+' : '' }}</strong>
                                            </div>
                                        }
                                    </div>
                                }
                            </div>
                        </ng-template>
}`})
export class SearchDiagnosticsComponent implements OnChanges, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() session?: Readonly<FeatureSearchSession>;
    @Input() revision = 0;
    @Input() active = false;
    @Input() queryEdited = false;
    @Input() mode: "details" | "progress" = "details";
    @Input() treeIngress = {done: 0, total: 0};
    private destroyed = false;
    get resultCount(): number { return this.session?.results.searchResults.length ?? 0; }

    /** Summary requests remain in the search controller; only display scheduling belongs here. */
    constructor(public searchService: SearchService, private readonly changeDetector: ChangeDetectorRef,
        private readonly ngZone: NgZone) {}

    /** Snapshots presentation values and defers progress publication past the current Angular check. */
    ngOnChanges(): void {
        const session = this.session;
        if (!session || session.id !== this.searchId) return;
        this.diagnostics = session.results.diagnostics;
        this.valueSummaries = session.results.valueSummaries;
        this.searchTimeElapsed = session.timeElapsed;
        this.searchTotalFeatureCount = session.results.totalFeatureCount;
        if (this.queryEdited) this.updateDraftFeatureSearchScopeSummary(session.definition.scope);
        else this.refreshFeatureSearchScopeSummary(session);
        this.scheduleProgressDisplayRefresh(session);
        if (this.mode === "details" && this.active && session.results.complete) this.requestDiagnosticsValueSummaries();
    }

    /** Invalidates deferred display publication when its dialog surface is retired. */
    ngOnDestroy(): void { this.destroyed = true; this.pendingProgressDisplaySession = undefined; }

    diagnostics: Array<DiagnosticsMessage> = [];

    valueSummaries: SearchValueSummariesState = this.emptyValueSummariesState();

    percentDone: number = 0;

    progressMeterItems: MeterItem[] = [];

    totalTiles: number = 0;

    doneTiles: number = 0;

    resultTreeIngressDone: number = 0;

    resultTreeIngressTotal: number = 0;

    progressDisplayPercent = 0;

    finishingResults = false;

    progressLabel = "Preparing search...";

    progressTooltip = "";

    searchTimeElapsed = "0ms";

    searchTotalFeatureCount = 0;

    featureSearchScopeSummary = "";

    featureSearchScopeSummaryTitle = "";

    private progressRunKey = "";
    private progressHighWater = 0;
    private progressWasComplete = false;

    private progressDisplayRefreshQueued = false;

    private pendingProgressDisplaySession?: FeatureSearchSession;

    /** Returns a blank Diagnostics/Values state for sessions without computed summaries yet. */
    private emptyValueSummariesState(): SearchValueSummariesState {
        return {
            status: "idle",
            revision: 0,
            processedTiles: 0,
            totalTiles: 0,
            resultFields: [],
            traces: []
        };
    }

    /** Number shown in the Diagnostics tab badge. */
    protected diagnosticsBadgeCount(): number {
        return this.diagnostics.length;
    }

    /** Starts lazy value-summary loading for the active search session. */
    protected requestDiagnosticsValueSummaries(): void {
        if (this.session) {
            this.searchService.requestValueSummaries(this.session.id);
        }
    }

    /** Returns value-summary fields that represent user-facing style/trace expressions, not internal selectors. */
    protected diagnosticsVisibleResultFields(): SearchResultFieldValueSummary[] {
        if (this.valueSummaries.status !== "ready") {
            return [];
        }
        return this.valueSummaries.resultFields.filter(field =>
            !this.isInternalSearchResultField(field.expression) || this.userStyleRulesReferenceField(field.expression));
    }

    /** Internal attribute-overlay fields are useful for search transport but noisy in the diagnostics UI. */
    private isInternalSearchResultField(expression: string): boolean {
        return INTERNAL_SEARCH_RESULT_FIELDS.has(expression.trim());
    }

    /** Keep an internal field visible if the user explicitly referenced it in a non-generated style rule. */
    private userStyleRulesReferenceField(expression: string): boolean {
        const trimmedExpression = expression.trim();
        return (this.session?.definition.searchStyleRules ?? []).some(rule => {
            if (rule.autoGenerated) {
                return false;
            }
            const colorField = rule.color.mode === "gradient" || rule.color.mode === "categories"
                ? rule.color.field.trim()
                : "";
            const labelField = rule.geometry.length === 1 && rule.geometry[0] === "label"
                ? (rule.labelExpression ?? "").trim()
                : "";
            const filterFields = (rule.filter ?? []).map(filter => filter.field.trim());
            return [colorField, labelField, ...filterFields].includes(trimmedExpression);
        });
    }

    /** Returns whether Values must wait for result-tile ingress before native aggregation can start. */
    protected valueSummaryWaitingForIngress(): boolean {
        return !!this.session && !this.session.results.complete;
    }

    /** Human-readable wait label for deferred value summaries. */
    protected valueSummaryWaitLabel(): string {
        if (this.doneTiles < this.totalTiles) {
            return `Waiting for result tiles: ${this.doneTiles} / ${this.totalTiles} ingested.`;
        }
        return "Waiting for backend search to finish.";
    }

    /** Compact numeric summary label used in value cards. */
    protected numericSummaryLabel(summary: SearchValueSummary): string {
        if (!summary.numeric) {
            return "";
        }
        const numeric = summary.schemaType?.numeric;
        const display = (raw: number) => this.formatSummaryNumber(raw * (numeric?.scale ?? 1) + (numeric?.offset ?? 0));
        return `min ${display(summary.numeric.min)}, `
            + `max ${display(summary.numeric.max)}, `
            + `avg ${display(summary.numeric.average)}${numeric?.unit ? ` ${numeric.unit}` : ""}`;
    }

    /** Returns non-zero kind counters in display order. */
    protected summaryKindEntries(summary: SearchValueSummary): Array<{ label: string; count: number }> {
        return [
            { label: "int", count: summary.kinds.integer },
            { label: "number", count: summary.kinds.number },
            { label: "bool", count: summary.kinds.boolean },
            { label: "string", count: summary.kinds.string },
            { label: "object", count: summary.kinds.object },
            { label: "list", count: summary.kinds.list },
            { label: "blob", count: summary.kinds.blob },
            { label: "bitmask", count: summary.kinds.bitmask },
            { label: "special", count: summary.specials },
            { label: "null", count: summary.nulls },
            { label: "missing", count: summary.missing },
            { label: "unknown", count: summary.kinds.unknown }
        ].filter(entry => entry.count > 0);
    }

    /** Limits per-card histogram rows to keep dense searches readable. */
    protected visibleHistogramBuckets(summary: SearchValueSummary): Array<{ value: string; count: number }> {
        return summary.histogram.slice(0, 8);
    }

    /** Formats summary numbers without losing obvious integer values. */
    private formatSummaryNumber(value: number): string {
        if (!Number.isFinite(value)) {
            return String(value);
        }
        if (Number.isInteger(value)) {
            return String(value);
        }
        return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    }

    /** Converts a done/total pair into a clamped progress percentage. */
    private progressPercent(done: number, total: number): number {
        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
            return 0;
        }
        return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    }

    /**
     * Count each requested tile once its current result rows have been decoded.
     * This covers backend processing and transfer without jumping to almost
     * complete while most results are still in transit. The required tile set
     * is already known; result-row totals keep growing as those tiles arrive.
     * Giving an early, tiny row batch an independent percentage made the old
     * meter jump backwards when the next large batch arrived.
     */
    private refreshProgressDisplay(session: FeatureSearchSession): void {
        this.finishingResults = false;
        // Disabled searches are not prepared on restore. Their saved settings
        // remain inspectable, without suggesting that background work is running.
        if (!session.definition.enabled) {
            this.progressLabel = "Search disabled";
            this.progressTooltip = "Enable this search to run it. Its saved settings remain available below.";
            this.progressMeterItems = [];
            this.progressDisplayPercent = 0;
            return;
        }
        if (session.preparation?.status !== "ready") {
            const status = session.preparation?.status;
            this.progressLabel = status === "needs-choice" ? "Choose an interpretation"
                : status === "waiting-for-schema" ? "Waiting for schema"
                : status === "invalid" ? "Preparation failed" : "Preparing search";
            this.progressTooltip = session.preparation?.error ?? "Scope and initial visualization are resolved before searching.";
            this.progressMeterItems = [];
            this.progressDisplayPercent = 0;
            return;
        }
        this.totalTiles = session.results.resultTileIngressTotal;
        this.doneTiles = session.results.resultTileIngressDone;
        this.percentDone = this.progressPercent(this.doneTiles, this.totalTiles);
        this.resultTreeIngressTotal = session.results.searchResults.length;
        this.resultTreeIngressDone = Math.min(this.treeIngress.done, this.resultTreeIngressTotal);
        const treePending = this.resultTreeIngressDone < this.resultTreeIngressTotal;
        const complete = !session.paused && session.results.complete && !treePending;
        const runKey = JSON.stringify([session.id, session.runId, session.refresh, session.startTime]);
        if (runKey !== this.progressRunKey || (this.progressWasComplete && !session.results.complete)) {
            this.progressRunKey = runKey;
            this.progressHighWater = 0;
        }
        // Coverage can grow during auto-update. Preserve the progress already
        // shown within this run; a rerun or renewed coverage after completion
        // starts a fresh meter. Reserve 100% for finalization.
        this.progressHighWater = Math.max(
            this.progressHighWater,
            complete ? 100 : Math.min(99, this.percentDone)
        );
        this.progressDisplayPercent = this.progressHighWater;
        this.progressWasComplete = !session.paused && session.results.complete;
        const tilesReady = this.totalTiles > 0 && this.doneTiles >= this.totalTiles;
        this.finishingResults = !complete && tilesReady && !session.paused;
        // Use the stable percentage in the label too. Coverage changes can
        // alter the raw counts; their exact values stay in the tooltip.
        if (session.paused) {
            this.progressLabel = `Paused, ${this.progressDisplayPercent}%`;
        } else if (complete) {
            this.progressLabel = `Complete, ${this.doneTiles}/${this.totalTiles} tiles`;
        } else if (tilesReady) {
            this.progressLabel = "Organizing results…";
        } else {
            this.progressLabel = `Searching, ${this.progressDisplayPercent}%`;
        }
        this.progressMeterItems = [{
            label: this.progressLabel,
            value: this.progressDisplayPercent,
            color: "var(--p-primary-color)"
        }];
        this.progressTooltip = [
            `Received and decoded: ${this.doneTiles} / ${this.totalTiles} tiles`,
            `Result tree: ${this.resultTreeIngressDone} / ${this.resultTreeIngressTotal} entries`
        ].join("\n");
    }

    /**
     * Publishes all template-visible progress fields after the current Angular check.
     *
     * Search ingress and result-tree assembly can both request a refresh during one
     * turn. Coalescing here keeps the meter, label, and tooltip on one session
     * snapshot and prevents a late child lifecycle hook from changing one of these
     * bindings between Angular's check and check-no-changes passes.
     *
     * Streaming search results must not check every open panel on every frame.
     * Like the coordinate HUD, check only this component. markForCheck would
     * also mark its ancestors and schedule an application pass, including with
     * Angular 21's default zoneless scheduling.
     * OnPush also keeps idle searches out of checks triggered elsewhere in the UI;
     * user events and the catalog subscriptions still notify Angular normally.
     */
    private scheduleProgressDisplayRefresh(session: FeatureSearchSession): void {
        this.pendingProgressDisplaySession = session;
        if (this.progressDisplayRefreshQueued) {
            return;
        }
        this.progressDisplayRefreshQueued = true;
        this.ngZone.runOutsideAngular(() => queueMicrotask(() => {
            this.progressDisplayRefreshQueued = false;
            const pendingSession = this.pendingProgressDisplaySession;
            this.pendingProgressDisplaySession = undefined;
            if (this.destroyed || !pendingSession || pendingSession !== this.session) {
                return;
            }
            this.refreshProgressDisplay(pendingSession);
            this.changeDetector.detectChanges();
        }));
    }

    /** Refreshes the compact scope label from the same schema metadata used by the style field picker. */
    private refreshFeatureSearchScopeSummary(session: FeatureSearchSession): void {
        const analysis = session.schemaAnalysis;
        if (new Set(session.preparation?.branches.map(branch => branch.scope)).size > 1) {
            this.featureSearchScopeSummary = "Mixed feature and attribute contexts";
            this.featureSearchScopeSummaryTitle = "Each selected interpretation uses its own source and evaluation context.";
            return;
        }
        if (analysis.status === "pending") {
            this.featureSearchScopeSummary = "Auto: resolving scope...";
            this.featureSearchScopeSummaryTitle = "Schema analysis is running in the background.";
            return;
        }
        if (analysis.rewriteSuppressed) {
            const scopeLabel = analysis.concreteScope === "attribute"
                ? "attribute scope"
                : "feature scope";
            this.featureSearchScopeSummary = session.definition.scope === "auto"
                ? `Auto: ${scopeLabel}, generic query`
                : `${scopeLabel[0].toUpperCase()}${scopeLabel.slice(1)}, generic query`;
            this.featureSearchScopeSummaryTitle = analysis.rewriteSuppressionReason
                || "Schema analysis found too many attribute contexts for a specific guarded rewrite.";
            return;
        }
        if (analysis.attributeScopes.length > 0) {
            this.featureSearchScopeSummary = this.attributeScopeSummaryLabel(
                session.definition.scope,
                analysis.attributeScopes
            );
            this.featureSearchScopeSummaryTitle = this.attributeScopeSummaryTitle(analysis.attributeScopes);
            return;
        }
        if (analysis.concreteScope === "attribute") {
            this.featureSearchScopeSummary = session.definition.scope === "auto"
                ? "Auto: attribute scope"
                : "Attribute scope";
            this.featureSearchScopeSummaryTitle =
                "Search runs over attribute-level fields; no narrower attribute set was inferred.";
            return;
        }
        this.featureSearchScopeSummary = session.definition.scope === "auto"
            ? "Auto: feature scope"
            : "Feature scope";
        this.featureSearchScopeSummaryTitle = analysis.error
            ? analysis.error
            : "Search runs over feature-level fields.";
    }

    /** Updates the scope label for an edited query before it has been submitted for schema analysis. */
    private updateDraftFeatureSearchScopeSummary(scope: FeatureSearchScope): void {
        if (scope === "feature") {
            this.featureSearchScopeSummary = "Feature scope";
            this.featureSearchScopeSummaryTitle = "Search runs over feature-level fields.";
            return;
        }
        if (scope === "attribute") {
            this.featureSearchScopeSummary = "Attribute scope";
            this.featureSearchScopeSummaryTitle = "Search will run over attribute-level fields.";
            return;
        }
        this.featureSearchScopeSummary = "Auto: pending";
        this.featureSearchScopeSummaryTitle = "Auto scope will be resolved when the edited query is run.";
    }

    /** Builds the user-facing summary for an inferred attribute scope. */
    private attributeScopeSummaryLabel(
        scope: FeatureSearchScope,
        attributeScopes: FeatureSearchAttributeScopeCandidate[]
    ): string {
        const representative = attributeScopes[0];
        const prefix = scope === "auto" ? "Auto: attribute" : "Attribute";
        const attributeNames = this.uniqueAttributeScopeNames(attributeScopes);
        if (attributeNames.length > 1) {
            const visibleNames = attributeNames.slice(0, 3).join(", ");
            const remaining = attributeNames.length > 3 ? `, +${attributeNames.length - 3}` : "";
            return `${prefix}s: ${visibleNames}${remaining} (${attributeScopes.length} scopes)`;
        }

        const attributeName = this.attributeScopeDisplayName(representative);
        const contextSuffix = attributeScopes.length > 1
            ? ` across ${attributeScopes.length} layers`
            : "";
        return `${prefix}: ${attributeName}${contextSuffix}`;
    }

    /** Builds the tooltip with the concrete map/layer contexts behind an inferred attribute scope. */
    private attributeScopeSummaryTitle(attributeScopes: FeatureSearchAttributeScopeCandidate[]): string {
        return attributeScopes
            .map(scope => {
                const featureType = scope.featureType ? `, feature ${scope.featureType}` : "";
                return `${this.attributeScopeDisplayName(scope)} in ${scope.mapId}/${scope.layerId}${featureType}`;
            })
            .join("\n");
    }

    /** Formats the attribute and attribute-layer names without inventing display aliases. */
    private attributeScopeDisplayName(scope: FeatureSearchAttributeScopeCandidate): string {
        return scope.attrLayerName
            ? `${scope.attrName} (${scope.attrLayerName})`
            : scope.attrName;
    }

    /** Returns sorted distinct attribute names inferred for one query. */
    private uniqueAttributeScopeNames(attributeScopes: FeatureSearchAttributeScopeCandidate[]): string[] {
        return Array.from(new Set(attributeScopes.map(scope => scope.attrName).filter(Boolean))).sort();
    }

    /**
     * Pushes a suggested query fix back into the omnibox workflow.
     */
    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchService.fixedDiagnosticsSearchQuery.next(message.fix);
        }
    }
}
