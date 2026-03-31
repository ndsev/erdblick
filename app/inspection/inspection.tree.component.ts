import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    ViewChild,
    input,
    OnDestroy,
    effect,
    output
} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {TreeTable} from "primeng/treetable";
import {toObservable} from "@angular/core/rxjs-interop";
import {Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {Menu} from "primeng/menu";
import {ClipboardService} from "../shared/clipboard.service";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";
import {Popover} from "primeng/popover";
import {JumpTargetService} from "../search/jump.service";

export interface Column {
    key: string,
    header: string,
    width: string,
    transform: (colKey: string, rowData: any) => any
}

export class FeatureFilterOptions {
    filterByKeys: boolean = true;
    filterByValues: boolean = true;
    filterOnlyFeatureIds: boolean = false;
    filterGeometryEntries: boolean = false;
}

@Component({
    selector: 'inspection-tree',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <p-treeTable #tt class="inspection-tree-table" scrollHeight="flex" filterMode="strict"
                     [value]="data"
                     [autoLayout]="true"
                     [scrollable]="true"
                     [resizableColumns]="true"
                     [rowHover]="true"
                     [virtualScroll]="true"
                     [virtualScrollItemSize]="'1.5em'"
                     [tableStyle]="{'min-height': '1px', 'padding': '0px'}"
                     [globalFilterFields]="filterFields">
            <ng-template pTemplate="caption">
                @if (showFilter()) {
                    <div class="filter-container">
                        <p-iconfield class="input-container">
                            @if (filterOptions()) {
                                <p-inputicon (click)="filterPanel.toggle($event)" styleClass="pi pi-filter"
                                             style="cursor: pointer"/>
                            }
                            <input class="filter-input" type="text" pInputText placeholder="Filter inspection tree"
                                   [(ngModel)]="filterString"
                                   (ngModelChange)="onFilterInput($event)"
                                   (input)="onFilterInput($any($event.target).value)"/>
                            @if (filterString) {
                                <i (click)="clearFilter()" class="pi pi-times clear-icon" style="cursor: pointer"></i>
                            }
                        </p-iconfield>
                    </div>
                }
            </ng-template>

            <ng-template pTemplate="colgroup">
                <colgroup>
                    @for (col of columns(); track col.key) {
                        <col [style.width]="col.width"/>
                    }
                </colgroup>
            </ng-template>

            <ng-template pTemplate="header">
                <tr>
                    @for (col of columns(); track col.key) {
                        <th ttResizableColumn>
                            {{ col.header }}
                        </th>
                    }
                </tr>
            </ng-template>

            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                @if (rowData) {
                    <tr [ttRow]="rowNode"
                        (click)="onRowClick($event, rowNode)"
                        (mouseenter)="onRowHover(rowData)"
                        (mouseleave)="onRowHoverExit(rowData)"
                        [ngClass]="getRowClasses(rowData)">
                        @for (col of columns(); track $index) {
                            <td [class]="getStyleClassByType(rowData)" style="white-space: nowrap;"
                                pTooltip="{{rowData[col.key]}}" tooltipPosition="left" [tooltipOptions]="tooltipOptions">
                                <div [class.inspection-first-cell-content]="$index === 0"
                                     style="display: flex; flex-direction: row; gap: 0.25em;">
                                    @if ($index === 0) {
                                        @if (shouldShowRowActions(rowNode, rowData)) {
                                            <button type="button"
                                                    class="inspection-row-actions"
                                                    (click)="onRowActionsClick($event, rowData)"
                                                    pTooltip="Row actions"
                                                    tooltipPosition="top">...</button>
                                        }
                                        <span class="inspection-row-toggle" (click)="$event.stopPropagation()">
                                            <p-treeTableToggler [rowNode]="rowNode"/>
                                        </span>
                                    }
                                    @if (col.key === "value" && isFeatureIdValueRow(rowData)) {
                                        <a href=""
                                           (click)="onFeatureIdLinkClick($event, rowData)"
                                           (mouseenter)="onNodeValueHover(rowData, col.key)"
                                           (mouseleave)="onNodeValueHoverExit(rowData, col.key)"
                                           style="cursor: pointer"
                                           [class.inspection-feature-id-pill]="isHoveredFeatureIdValue(rowData, col.key)"
                                           [style.overflow]="filterFields.indexOf(col.key) !== -1 ? 'hidden' : null"
                                           [style.white-space]="filterFields.indexOf(col.key) !== -1 ? 'nowrap' : null"
                                           [style.text-overflow]="filterFields.indexOf(col.key) !== -1 ? 'ellipsis' : null"
                                           [innerHTML]="filterFields.indexOf(col.key) !== -1 ? (col.transform(col.key, rowData) | highlight: filterString) : col.transform(col.key, rowData)">
                                        </a>
                                    } @else {
                                        <span (click)="onNodeClick($event, rowData, col.key)"
                                              (mouseenter)="onNodeValueHover(rowData, col.key)"
                                              (mouseleave)="onNodeValueHoverExit(rowData, col.key)"
                                              style="cursor: pointer"
                                              [class.inspection-feature-id-pill]="isHoveredFeatureIdValue(rowData, col.key)"
                                              [style.overflow]="filterFields.indexOf(col.key) !== -1 ? 'hidden' : null"
                                              [style.white-space]="filterFields.indexOf(col.key) !== -1 ? 'nowrap' : null"
                                              [style.text-overflow]="filterFields.indexOf(col.key) !== -1 ? 'ellipsis' : null"
                                              [innerHTML]="filterFields.indexOf(col.key) !== -1 ? (col.transform(col.key, rowData) | highlight: filterString) : col.transform(col.key, rowData)">
                                        </span>
                                    }
                                    @if (rowData.hasOwnProperty("stageLabelBubble") && $index === 0) {
                                        <span class="inspection-stage-label-badge">{{rowData["stageLabelBubble"]}}</span>
                                    }
                                    @if (rowData.hasOwnProperty("info") && $index !== 0) {
                                        <span>
                                            <i class="pi pi-info-circle" pTooltip="{{rowData['info']}}" tooltipPosition="top"></i>
                                        </span>
                                    }
                                    @if (enableSourceDataNavigation() &&
                                    rowData.hasOwnProperty("sourceDataReferences") &&
                                    rowData["sourceDataReferences"].length > 0 &&
                                    $index === 0) {
                                        <p-buttonGroup class="source-data-ref-container">
                                            @for (item of rowData["sourceDataReferences"]; track $index) {
                                                <p-button class="source-data-button"
                                                          (click)="showSourceData($event, item)"
                                                          severity="secondary"
                                                          label="{{ item.qualifier.substring(0, 1).toUpperCase() }}"
                                                          pTooltip="Go to {{item.qualifier?.trim()}} source data."
                                                          [tooltipOptions]="{appendTo: 'body'}"
                                                          tooltipPosition="bottom" />
                                            }
                                        </p-buttonGroup>
                                    }
                                </div>
                            </td>
                        }
                    </tr>
                }
            </ng-template>

            <ng-template pTemplate="emptymessage">
                <tr>
                    <td [attr.colspan]="columns().length">No entries found.</td>
                </tr>
            </ng-template>
        </p-treeTable>
        <p-menu #geoJsonMenu [popup]="true" [model]="geoJsonMenuItems" appendTo="body" [baseZIndex]="30000"></p-menu>
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="30000" appendTo="body"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-popover *ngIf="filterOptions() !== undefined" #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap"
                 style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <p-checkbox [(ngModel)]="filterOptions()!.filterByKeys" (ngModelChange)="filterTree(filterString)"
                            inputId="fbk" [binary]="true"/>
                <label for="fbk" style="margin-left: 0.5em; cursor: pointer">Filter by Keys</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterByValues" (ngModelChange)="filterTree(filterString)"
                            inputId="fbv" [binary]="true"/>
                <label for="fbv" style="margin-left: 0.5em; cursor: pointer">Filter by Values</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterOnlyFeatureIds"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="fofids" [binary]="true"/>
                <label for="fofids" style="margin-left: 0.5em; cursor: pointer">Filter only FeatureIDs</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterGeometryEntries"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="ige" [binary]="true"/>
                <label for="ige" style="margin-left: 0.5em; cursor: pointer">Include Geometry Entries</label>
            </div>
        </p-popover>
    `,
    standalone: false
})
export class InspectionTreeComponent implements AfterViewInit, OnDestroy {
    private static readonly DOCK_RESIZE_PAUSE_START_EVENT = "erdblick-dock-resize-start";
    private static readonly DOCK_RESIZE_PAUSE_END_EVENT = "erdblick-dock-resize-end";
    private activeSoftHoverGroupId?: string;
    private activeStrongHoverGroupId?: string;
    private activeFeatureIdNodeId?: string;

    @ViewChild('tt') table!: TreeTable;
    @ViewChild('filterPanel') filterPanel!: Popover;

    data: TreeTableNode[] = [];
    treeData = input.required<TreeTableNode[]>();
    columns = input.required<Column[]>();
    panelId = input.required<number>();
    firstHighlightedItemIndex = input<number>();
    firstHighlightedItemIndex$ = toObservable(this.firstHighlightedItemIndex);
    subscriptions: Subscription[] = [];
    filterOptions = input<FeatureFilterOptions>();
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);
    geoJson = input<string>();
    enableSourceDataNavigation = input<boolean>(true);

    filterFields: string[] = [
        "key",
        "value"
    ];
    tooltipOptions = {
        showDelay: 1000,
        autoHide: false
    };
    filterString = "";
    private suppressFilterEmit = false;
    private lastEmittedFilterText = "";
    private frozen = false;
    private manualFreezeRequested = false;
    private dockFreezeRequested = false;
    private pendingScrollerRecalcWhileFrozen = false;
    private destroyed = false;
    private resizeObserver?: ResizeObserver;
    private scrollerRecalcFrame?: number;
    private readonly onWindowResize = () => this.scheduleScrollerRecalc();
    private readonly onDockResizePauseStart = () => {
        this.dockFreezeRequested = true;
        this.applyFreezeState();
    };
    private readonly onDockResizePauseEnd = () => {
        this.dockFreezeRequested = false;
        this.applyFreezeState();
    };

    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;
    @ViewChild('geoJsonMenu') geoJsonMenu!: Menu;
    geoJsonMenuItems: MenuItem[] = [];

    constructor(private cdr: ChangeDetectorRef,
                private clipboardService: ClipboardService,
                public mapService: MapDataService,
                private jumpService: JumpTargetService,
                private stateService: AppStateService,
                private messageService: InfoMessageService) {
        effect(() => {
            this.data = this.treeData();
            if (this.isFeatureInspectionTree(this.data)) {
                this.expandTreeNodes(this.data);
            }

            this.refreshLayout();
            this.cdr.markForCheck();
        });
        effect(() => {
            const sharedFilter = this.filterText();
            if (sharedFilter === undefined || sharedFilter === this.filterString) {
                return;
            }
            this.suppressFilterEmit = true;
            this.filterString = sharedFilter;
            this.filterTree(sharedFilter);
            this.lastEmittedFilterText = sharedFilter;
            this.suppressFilterEmit = false;
            this.cdr.markForCheck();
        });
        this.subscriptions.push(this.firstHighlightedItemIndex$.subscribe(index => {
            setTimeout(() => this.table?.scrollToVirtualIndex(index ?? 0), 5);
        }));
    }

    ngAfterViewInit() {
        this.scheduleScrollerRecalc();
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (hostElement && typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => this.scheduleScrollerRecalc());
            this.resizeObserver.observe(hostElement);
            const container = hostElement.closest(".resizable-container");
            if (container instanceof HTMLElement) {
                this.resizeObserver.observe(container);
            }
        }
        if (typeof window !== "undefined") {
            window.addEventListener("resize", this.onWindowResize);
            window.addEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_START_EVENT, this.onDockResizePauseStart);
            window.addEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_END_EVENT, this.onDockResizePauseEnd);
        }
    }

    ngOnDestroy() {
        this.unfreeze();
        this.destroyed = true;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        if (typeof window !== "undefined") {
            window.removeEventListener("resize", this.onWindowResize);
            window.removeEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_START_EVENT, this.onDockResizePauseStart);
            window.removeEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_END_EVENT, this.onDockResizePauseEnd);
        }
        if (this.scrollerRecalcFrame !== undefined) {
            window.cancelAnimationFrame(this.scrollerRecalcFrame);
            this.scrollerRecalcFrame = undefined;
        }
        this.subscriptions.forEach(s => s.unsubscribe());
    }

    freeze(): void {
        if (this.destroyed) {
            return;
        }
        this.manualFreezeRequested = true;
        this.applyFreezeState();
    }

    unfreeze(): void {
        if (this.destroyed) {
            return;
        }
        this.manualFreezeRequested = false;
        this.applyFreezeState();
    }

    private shouldStayFrozen(): boolean {
        return this.manualFreezeRequested || this.dockFreezeRequested;
    }

    private applyFreezeState(): void {
        const shouldFreeze = this.shouldStayFrozen();
        if (shouldFreeze) {
            if (!this.frozen) {
                this.frozen = true;
                this.cdr.detach();
            }
            return;
        }

        if (!this.frozen) {
            return;
        }

        this.frozen = false;
        this.cdr.reattach();
        this.cdr.detectChanges();
        const hadPendingRecalc = this.pendingScrollerRecalcWhileFrozen;
        this.pendingScrollerRecalcWhileFrozen = false;
        if (hadPendingRecalc) {
            this.scheduleScrollerRecalc();
            return;
        }
        this.scheduleScrollerRecalc();
    }

    private scheduleScrollerRecalc() {
        if (this.destroyed || typeof window === "undefined") {
            return;
        }
        if (this.frozen) {
            this.pendingScrollerRecalcWhileFrozen = true;
            return;
        }
        if (this.scrollerRecalcFrame !== undefined) {
            window.cancelAnimationFrame(this.scrollerRecalcFrame);
        }
        this.scrollerRecalcFrame = window.requestAnimationFrame(() => {
            this.scrollerRecalcFrame = undefined;
            this.recalculateScrollerGeometry();
        });
    }

    refreshLayout(): void {
        this.scheduleScrollerRecalc();
    }

    private recalculateScrollerGeometry(): void {
        if (this.destroyed || this.frozen) {
            this.pendingScrollerRecalcWhileFrozen = true;
            return;
        }
        const scroller = (this.table as any)?.scrollableViewChild?.scroller;
        if (!scroller) {
            return;
        }

        scroller.setSpacerSize?.();
        scroller.setSize?.();
        scroller.calculateOptions?.();
        scroller.setContentPosition?.();
        this.cdr.detectChanges();
    }

    measurePreferredContentHeightEm(): number | undefined {
        if (typeof window === "undefined") {
            return undefined;
        }
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (!hostElement) {
            return undefined;
        }

        const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
            return undefined;
        }

        const filterHeightPx = hostElement.querySelector<HTMLElement>('.p-treetable-header')
            ?.getBoundingClientRect().height ?? 0;
        const headerHeightPx = hostElement.querySelector<HTMLElement>('.p-treetable-thead')
            ?.getBoundingClientRect().height ?? 0;

        let contentHeightPx = hostElement.querySelector<HTMLElement>('.p-virtualscroller-spacer')
            ?.getBoundingClientRect().height ?? 0;
        if (!contentHeightPx) {
            contentHeightPx = Array
                .from(hostElement.querySelectorAll<HTMLElement>('.p-treetable-tbody > tr'))
                .reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
        }
        if (!contentHeightPx) {
            return undefined;
        }

        const borderCompensationPx = 2;
        const totalHeightPx = filterHeightPx + headerHeightPx + contentHeightPx + borderCompensationPx;
        return totalHeightPx / rootFontSize;
    }

    clearFilter() {
        this.filterString = "";
        this.table.filterGlobal("" , 'contains');
        this.data = this.treeData();
        this.emitFilterChange("");
    }

    onKeydown(event: any) {
        event.stopPropagation();

        if (event.key === 'Escape') {
            this.clearFilter();
        }
    }

    onRowClick(event: MouseEvent, rowNode: any) {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".inspection-row-actions") || target?.closest(".p-treetable-toggler") || target?.closest("a")) {
            return;
        }
        const node: TreeNode = rowNode.node;
        node.expanded = !node.expanded;
        this.data = [...this.data];
    }

    onNodeClick(event: MouseEvent, rowData: any, colKey: string) {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            event.stopPropagation();
            return;
        }

        if (colKey === "value" && this.isFeatureIdValueRow(rowData)) {
            this.onValueClick(event, rowData);
        }
    }

    onRowActionsClick(event: MouseEvent, rowData: any) {
        this.inspectionMenu.toggle(event);
        event.stopPropagation();
        const key = rowData["key"];
        const value = rowData["value"];
        this.inspectionMenuItems = [
            {
                label: 'Copy Key/Value',
                command: () => {
                    this.copyToClipboard(`{${key}: ${value}}`);
                }
            },
            {
                label: 'Open NDS.Live Docs',
                command: () => {
                    window.open(`https://doc.nds.live/search?q=${key}`, "_blank");
                }
            }
        ];
        if (rowData.hasOwnProperty("geoJsonPath")) {
            const path = rowData["geoJsonPath"];
            this.inspectionMenuItems.push({
                label: 'Copy GeoJson Path',
                command: () => {
                    this.copyToClipboard(path);
                }
            });
        }
    }

    onValueClick(event: any, rowData: any) {
        event.stopPropagation();
        this.jumpService.highlightByJumpTargetFilter(
            rowData["mapId"],
            rowData["value"]).then();
    }

    onFeatureIdLinkClick(event: MouseEvent, rowData: any) {
        event.preventDefault();
        this.onValueClick(event, rowData);
    }

    onRowHover(rowData: any) {
        this.activeSoftHoverGroupId = typeof rowData?.["softHoverGroupId"] === "string"
            ? rowData["softHoverGroupId"]
            : undefined;
        this.activeStrongHoverGroupId = typeof rowData?.["strongHoverGroupId"] === "string"
            ? rowData["strongHoverGroupId"]
            : undefined;
        this.activeFeatureIdNodeId = undefined;
        this.highlightRowHoverTarget(rowData);
    }

    onRowHoverExit(rowData: any) {
        this.activeSoftHoverGroupId = undefined;
        this.activeStrongHoverGroupId = undefined;
        this.activeFeatureIdNodeId = undefined;
        if (!rowData.hasOwnProperty("type") &&
            !rowData.hasOwnProperty("hoverId") &&
            !rowData.hasOwnProperty("softHoverGroupId")) {
            return;
        }
        if (rowData["type"] === this.InspectionValueType.FEATUREID.value ||
            rowData["hoverId"] ||
            rowData["softHoverGroupId"]) {
            this.mapService.setHoveredFeatures([]).then();
        }
    }

    onNodeValueHover(rowData: any, colKey: string) {
        if (colKey !== "value" || !this.isFeatureIdValueRow(rowData)) {
            return;
        }
        this.activeFeatureIdNodeId = typeof rowData?.["nodeId"] === "string"
            ? rowData["nodeId"]
            : undefined;
        this.jumpService.highlightByJumpTargetFilter(
            rowData["mapId"],
            rowData["value"],
            coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
    }

    onNodeValueHoverExit(rowData: any, colKey: string) {
        if (colKey !== "value" || !this.isFeatureIdValueRow(rowData)) {
            return;
        }
        this.activeFeatureIdNodeId = undefined;
        this.highlightRowHoverTarget(rowData);
    }

    private highlightRowHoverTarget(rowData: any) {
        const hoverId = typeof rowData["strongHoverGroupId"] === "string"
            ? String(rowData["strongHoverGroupId"])
            : typeof rowData["softHoverGroupId"] === "string"
                ? String(rowData["softHoverGroupId"])
                : typeof rowData["hoverId"] === "string"
                    ? String(rowData["hoverId"])
                    : "";
        const mapTileKey = typeof rowData["mapTileKey"] === "string"
            ? rowData["mapTileKey"]
            : undefined;
        if (!mapTileKey || !hoverId) {
            this.mapService.setHoveredFeatures([]).then();
            return;
        }
        this.mapService.setHoveredFeatures([{
            mapTileKey,
            featureId: hoverId
        }]).then();
    }

    protected isFeatureIdValueRow(rowData: any): boolean {
        return rowData?.["type"] === this.InspectionValueType.FEATUREID.value;
    }

    isHoveredFeatureIdValue(rowData: any, colKey: string): boolean {
        return colKey === "value" &&
            this.isFeatureIdValueRow(rowData) &&
            typeof rowData?.["nodeId"] === "string" &&
            rowData["nodeId"] === this.activeFeatureIdNodeId;
    }

    private rowLevel(rowNode: any): number {
        if (typeof rowNode?.level === "number") {
            return rowNode.level;
        }
        if (typeof rowNode?.node?.level === "number") {
            return rowNode.node.level;
        }
        return 0;
    }

    shouldShowRowActions(rowNode: any, rowData: any): boolean {
        return this.rowLevel(rowNode) > 0 && rowData?.["type"] !== this.InspectionValueType.SECTION.value;
    }

    getRowClasses(rowData: any): Record<string, boolean> {
        const strongHoverGroupId = typeof rowData?.["strongHoverGroupId"] === "string"
            ? rowData["strongHoverGroupId"]
            : undefined;
        const softHoverGroupId = typeof rowData?.["softHoverGroupId"] === "string"
            ? rowData["softHoverGroupId"]
            : undefined;
        return {
            [rowData?.styleClass ?? ""]: !!rowData?.styleClass,
            "inspection-hover-soft": !!this.activeSoftHoverGroupId &&
                softHoverGroupId === this.activeSoftHoverGroupId,
            "inspection-hover-strong": !!this.activeStrongHoverGroupId &&
                strongHoverGroupId === this.activeStrongHoverGroupId
        };
    }

    showSourceData(event: Event, sourceDataRef: any) {
        event.stopPropagation();
        if (!this.enableSourceDataNavigation()) {
            return;
        }
        try {
            this.stateService.setSelection({
                mapTileKey: sourceDataRef.mapTileKey,
                address: sourceDataRef.address
            } as SelectedSourceData);
        } catch (e) {
            this.messageService.showError(`Encountered error: ${e}`);
        }
    }

    getStyleClassByType(rowData: any): string {
        if (!rowData || !rowData.hasOwnProperty("type")) {
            return "standard-style";
        }
        switch (rowData["type"]) {
            case this.InspectionValueType.SECTION.value:
                return "section-style";
            case this.InspectionValueType.FEATUREID.value:
                return "feature-id-style";
            default:
                return "standard-style";
        }
    }

    copyToClipboard(text: string) {
        this.clipboardService.copyToClipboard(text);
    }

    showGeoJsonMenu(event: MouseEvent) {
        event.stopPropagation();
        if (!this.geoJson()) {
            return;
        }
        this.geoJsonMenuItems = [
            {
                label: 'Open in new tab',
                icon: 'pi pi-external-link',
                command: () => this.openGeoJsonInNewTab()
            },
            {
                label: 'Download (.geojson)',
                icon: 'pi pi-download',
                command: () => this.downloadGeoJson()
            },
            {
                label: 'Copy to clipboard',
                icon: 'pi pi-copy',
                command: () => this.copyGeoJson()
            }
        ];
        this.geoJsonMenu.toggle(event);
    }

    copyGeoJson() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        this.copyToClipboard(data);
    }

    downloadGeoJson() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        const blob = new Blob([data], {type: 'application/geo+json'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.geoJsonFilename();
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.messageService.showSuccess('GeoJSON download started');
    }

    openGeoJsonInNewTab() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        const blob = new Blob([data], {type: 'application/geo+json'});
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        this.messageService.showSuccess('Opened GeoJSON in new tab');
    }

    private geoJsonFilename(): string {
        return `inspection-${this.panelId()}.geojson`;
    }

    filterTree(filterString: string) {
        if (!filterString) {
            this.data = this.treeData();
            this.expandTreeNodes(this.data);
        }

        const query = filterString.toLowerCase();
        this.table.filterGlobal(query, "contains");
    }

    onFilterInput(filterString: string) {
        const nextValue = filterString ?? "";
        this.filterString = nextValue;
        this.filterTree(nextValue);
        this.emitFilterChange(nextValue);
    }

    expandTreeNodes(nodes: TreeTableNode[], parent: TreeTableNode | null = null): void {
        nodes.forEach(node => {
            const isTopLevelNode = parent === null;
            const isRelationTypeNode = parent && parent.data["key"] === "Relations";
            const isSection = node.data && node.data["type"] === this.InspectionValueType.SECTION.value;
            const hasSingleChild = node.children && node.children.length === 1;
            node.expanded = isTopLevelNode || isRelationTypeNode || isSection || hasSingleChild;

            if (node.children) {
                this.expandTreeNodes(node.children, node);
            }
        });
    }

    protected readonly InspectionValueType = coreLib.ValueType;

    private isFeatureInspectionTree(nodes: TreeTableNode[]): boolean {
        const firstKey = nodes[0]?.data?.["key"];
        return firstKey === "Feature" || firstKey === "Identifiers";
    }

    private emitFilterChange(filterString: string) {
        if (this.suppressFilterEmit || this.lastEmittedFilterText === filterString) {
            return;
        }
        this.lastEmittedFilterText = filterString;
        this.filterTextChange.emit(filterString);
    }
}
