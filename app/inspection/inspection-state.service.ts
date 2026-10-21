import {inject} from "@angular/core";
import {rejectAction} from "../actions/action-utils";
import {AppActionService} from "../actions/app-action.service";
import type {ActionSuggestion} from "../actions/omnibar";
import {inspectionStateControls} from "./inspection-state.service.declarations";
import {ownerState} from "./inspection-state.service.state";

import {Injectable} from "@angular/core";
import {z} from "zod";
import type {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {
    AppDialogLayout,
    AppDialogPosition,
    DEFAULT_DOCKED_EM_HEIGHT,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    INSPECTION_DOCK_TAB_ID
} from "../shared/app-layout.model";
import {AppLayoutService} from "../shared/app-layout.service";
import {AppStateService} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {
    DEFAULT_HIGHLIGHT_COLORS,
    HoverLabelFieldConfig,
    InspectionComparisonEntry,
    InspectionComparisonModel,
    InspectionComparisonOption,
    InspectionDialogLayout,
    InspectionPanelModel,
    InspectionTreeExpansionSnapshot,
    InspectionTreeExpansionState,
    MAX_COMPARE_PANELS,
    MAX_DRILL_PICK_RADIUS,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MIN_DRILL_PICK_RADIUS,
    SelectedSourceData,
    TileFeatureId
} from "./inspection-state.model";

/** Owns inspection values, validation, and user operations. */
@Injectable({providedIn: "root"})
export class InspectionStateService {
    static readonly controls = inspectionStateControls;
    static readonly actions = {
        closeInspection: {
            name: "viewer_close_inspection",
            description: "Close one inspection panel, including a pinned panel. Other inspections remain open.",
            mutation: true,
            inputSchema: z.strictObject({panelId: z.number().int().nonnegative()}),
            outputSchema: z.strictObject({status: z.literal("applied"), changed: z.boolean()})
        }
    } as const;
    private readonly actions = inject(AppActionService);
    private panelLifetimes = new Map<number, object>();

    private closeInspectionSuggestions(query: string): ActionSuggestion<{panelId: number}>[] {
        if (!/^close\b/i.test(query.trim())) return [];
        const filter = query
            .trim()
            .replace(/^close\s*(inspection\s*)?/i, "")
            .toLowerCase();
        return this.selection.flatMap((panel) => {
            const label = panel.features.length
                ? panel.features.map((feature) => feature.featureId).join(", ")
                : (panel.sourceData?.mapTileKey ?? `Inspection ${panel.id}`);
            if (filter && !label.toLowerCase().includes(filter)) return [];
            const lifetime = this.panelLifetimes.get(panel.id);
            return [
                {
                    id: `close-inspection:${panel.id}`,
                    icon: "pi-times",
                    color: "orange",
                    name: `Close ${label}`,
                    label: panel.locked ? "Pinned inspection" : "Inspection",
                    enabled: true,
                    arguments: {panelId: panel.id},
                    validate: () => true,
                    isCurrent: () => lifetime !== undefined && this.panelLifetimes.get(panel.id) === lifetime
                }
            ];
        });
    }

    /** Revalidate the live target immediately before closing it. */
    closeInspection(panelId: number): {status: "applied"; changed: boolean} {
        if (!this.selection.some((panel) => panel.id === panelId)) {
            rejectAction("The inspection no longer exists", "not_available");
        }
        this.unsetPanel(panelId);
        return {status: "applied", changed: true};
    }

    private readonly inspectionTreeExpansionStates = new Map<number, InspectionTreeExpansionState>();

    /** Returns the default inspection panel size. */
    get defaultInspectionPanelSize(): [number, number] {
        return [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];
    }

    // 2~0f~features:map:layer:tile~featureid~layertype:map:layer:tile~featureid~layertype:map:layer:tile~featureid~245:56
    // 1~0~sourcedata:map:layer:tile~address~...features...~size
    // 0~1~...
    readonly selectionState = this.stateService.register(ownerState.selection, "inspection", "selection");

    readonly inspectionsLimitState = this.stateService.register(
        ownerState.inspectionsLimit,
        "inspection",
        "inspectionsLimit"
    );

    readonly drillPickRadiusState = this.stateService.register(
        ownerState.drillPickRadius,
        "inspection",
        "drillPickRadius"
    );

    readonly inspectionTreeExpandByDefaultState = this.stateService.register(
        ownerState.inspectionTreeExpandByDefault,
        "inspection",
        "inspectionTreeExpandByDefault"
    );

    readonly sourceDataInspectionDefaultColumnsState = this.stateService.register(
        ownerState.sourceDataInspectionDefaultColumns,
        "inspection",
        "sourceDataInspectionDefaultColumns"
    );

    readonly inspectionTreeHiddenColumnsState = this.stateService.register(
        ownerState.inspectionTreeHiddenColumns,
        "inspection",
        "inspectionTreeHiddenColumns"
    );

    readonly inspectionValueVaryColorsState = this.stateService.register(
        ownerState.inspectionValueVaryColors,
        "inspection",
        "inspectionValueVaryColors"
    );

    readonly inspectionValueVaryOutlinesState = this.stateService.register(
        ownerState.inspectionValueVaryOutlines,
        "inspection",
        "inspectionValueVaryOutlines"
    );

    readonly inspectionValueVaryStripingState = this.stateService.register(
        ownerState.inspectionValueVaryStriping,
        "inspection",
        "inspectionValueVaryStriping"
    );

    readonly hoverLabelsEnabledState = this.stateService.register(
        ownerState.hoverLabelsEnabled,
        "inspection",
        "hoverLabelsEnabled"
    );

    readonly hoverLabelFieldsState = this.stateService.register(
        ownerState.hoverLabelFields,
        "inspection",
        "hoverLabelFields"
    );

    readonly inspectionComparisonState = this.stateService.register(
        ownerState.inspectionComparison,
        "inspection",
        "inspectionComparison"
    );

    get selection() {
        return this.selectionState.getValue();
    }

    set selection(val: InspectionPanelModel<TileFeatureId>[]) {
        this.stateService.transaction(() => {
            this.selectionState.next(val);
        });
    }

    get focusedInspectionPanelId() {
        return this.selectionState.getValue().find((panel) => panel.focused)?.id;
    }

    set focusedInspectionPanelId(val: number | undefined) {
        this.stateService.transaction(() => {
            this.setFocusedInspectionPanel(val);
        });
    }

    get inspectionsLimit() {
        return this.inspectionsLimitState.getValue();
    }

    set inspectionsLimit(val: number) {
        this.stateService.transaction(() => {
            const numeric = Number(val);
            if (!Number.isFinite(numeric)) {
                return;
            }
            const normalized = Math.min(MAX_SIMULTANEOUS_INSPECTIONS, Math.max(1, Math.trunc(numeric)));
            this.inspectionsLimitState.next(normalized);
        });
    }

    get drillPickRadius() {
        return this.drillPickRadiusState.getValue();
    }

    set drillPickRadius(val: number) {
        this.stateService.transaction(() => {
            const numeric = Number(val);
            if (!Number.isFinite(numeric)) {
                return;
            }
            const normalized = Math.min(MAX_DRILL_PICK_RADIUS, Math.max(MIN_DRILL_PICK_RADIUS, Math.trunc(numeric)));
            this.drillPickRadiusState.next(normalized);
        });
    }

    get inspectionComparison() {
        return this.inspectionComparisonState.getValue();
    }

    set inspectionComparison(val: InspectionComparisonModel | null) {
        this.stateService.transaction(() => {
            this.inspectionComparisonState.next(val);
        });
    }

    get inspectionTreeExpandByDefault() {
        return this.inspectionTreeExpandByDefaultState.getValue();
    }

    set inspectionTreeExpandByDefault(val: boolean) {
        this.stateService.transaction(() => {
            this.inspectionTreeExpandByDefaultState.next(!!val);
        });
    }

    get sourceDataInspectionDefaultColumns() {
        return this.sourceDataInspectionDefaultColumnsState.getValue();
    }

    set sourceDataInspectionDefaultColumns(val: string[]) {
        this.stateService.transaction(() => {
            const allowed = new Set(["displayAddress", "schemaType"]);
            this.sourceDataInspectionDefaultColumnsState.next([
                ...new Set(val.filter((column) => allowed.has(column)))
            ]);
        });
    }

    get inspectionValueVaryColors() {
        return this.inspectionValueVaryColorsState.getValue();
    }

    set inspectionValueVaryColors(val: boolean) {
        this.stateService.transaction(() => {
            this.inspectionValueVaryColorsState.next(!!val);
        });
    }

    get inspectionValueVaryOutlines() {
        return this.inspectionValueVaryOutlinesState.getValue();
    }

    set inspectionValueVaryOutlines(val: boolean) {
        this.stateService.transaction(() => {
            this.inspectionValueVaryOutlinesState.next(!!val);
        });
    }

    get inspectionValueVaryStriping() {
        return this.inspectionValueVaryStripingState.getValue();
    }

    set inspectionValueVaryStriping(val: boolean) {
        this.stateService.transaction(() => {
            this.inspectionValueVaryStripingState.next(!!val);
        });
    }

    get hoverLabelsEnabled() {
        return this.hoverLabelsEnabledState.getValue();
    }

    set hoverLabelsEnabled(val: boolean) {
        this.stateService.transaction(() => {
            this.hoverLabelsEnabledState.next(!!val);
        });
    }

    get hoverLabelFields() {
        return this.hoverLabelFieldsState.getValue();
    }

    set hoverLabelFields(val: HoverLabelFieldConfig[]) {
        this.stateService.transaction(() => {
            this.hoverLabelFieldsState.next(val.map((field) => ({...field})));
        });
    }

    /** Updates the current selection, reusing or creating inspection panels as needed. */
    setSelection(
        newSelection: TileFeatureId[] | SelectedSourceData,
        id?: number,
        forceNewPanel: boolean = false,
        createUndockedFeaturePanel: boolean = false
    ) {
        return this.stateService.transaction(() => {
            this.stateService.pushNextUrl();
            let allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const originPanel = id !== undefined ? allPanels.find((panel) => panel.id === id) : undefined;
            const sourceDataSelection = !Array.isArray(newSelection) ? (newSelection as SelectedSourceData) : undefined;
            const isSourceDataSelection = sourceDataSelection !== undefined;
            let featureSelection = Array.isArray(newSelection) ? (newSelection as TileFeatureId[]) : [];
            const duplicateFeaturePanelId =
                !isSourceDataSelection && featureSelection.length
                    ? this.findPanelIdContainingFeatureSelection(allPanels, featureSelection)
                    : undefined;
            if (
                !isSourceDataSelection &&
                id === undefined &&
                featureSelection.length > 0 &&
                !createUndockedFeaturePanel
            ) {
                this.layout.isDockOpen = true;
            }
            const isFeaturePanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData === undefined;
            const isSourceDataPanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData !== undefined;
            const isClearSourceDataRequest =
                originPanel !== undefined && sourceDataSelection === undefined && originPanel.sourceData !== undefined;

            // Filter out features which are already selected. If there are none left, we don't need to do anything
            // unless we are explicitly clearing a source data selection.
            if (featureSelection.length && !forceNewPanel) {
                featureSelection = featureSelection.filter(
                    (feature) =>
                        !allPanels.some(
                            (panel) =>
                                isFeaturePanel(panel) &&
                                panel.features.some(
                                    (otherFeature) =>
                                        feature.featureId === otherFeature.featureId &&
                                        feature.mapTileKey === otherFeature.mapTileKey
                                )
                        )
                );
                if (!featureSelection.length && !isClearSourceDataRequest) {
                    const duplicatePanel = allPanels.find((panel) => panel.id === duplicateFeaturePanelId);
                    if (duplicatePanel && !duplicatePanel.undocked && !createUndockedFeaturePanel) {
                        this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                        this.layout.isDockOpen = true;
                    }
                    this.setFocusedInspectionPanel(duplicateFeaturePanelId);

                    return;
                }
            }

            // Decide whether to reuse an existing panel or create a new one.
            let targetPanelId: number | undefined = undefined;
            let mustCreateNewPanel = forceNewPanel;

            // Explicit SourceData updates from a SourceData panel stay in that panel, even when locked.
            if (!forceNewPanel && originPanel && isSourceDataSelection && isSourceDataPanel(originPanel)) {
                targetPanelId = originPanel.id;
            }

            // Explicit feature updates from an unlocked feature panel stay in that panel.
            if (
                !forceNewPanel &&
                targetPanelId === undefined &&
                originPanel &&
                !isSourceDataSelection &&
                isFeaturePanel(originPanel) &&
                (isClearSourceDataRequest || !originPanel.locked)
            ) {
                targetPanelId = originPanel.id;
            }

            // Inspection strategy:
            // Feature selection (default path): reuse the last unlocked feature panel and close all other unlocked feature panels.
            // Docked search result clicks prefer an unlocked floating feature panel, keeping the Search dock tab visible.
            // Otherwise: reuse unlocked docked panel of the same inspection type, then unlocked undocked dialog, else create new.
            if (!mustCreateNewPanel && targetPanelId === undefined) {
                const isDefaultFeatureSelectionRequest = !isSourceDataSelection && id === undefined;
                if (isDefaultFeatureSelectionRequest) {
                    const requiresUndockedFeaturePanel = createUndockedFeaturePanel;
                    let lastUnlockedFeaturePanelId: number | undefined;
                    for (let index = allPanels.length - 1; index >= 0; index--) {
                        const panel = allPanels[index];
                        if (
                            isFeaturePanel(panel) &&
                            !panel.locked &&
                            (!requiresUndockedFeaturePanel || panel.undocked)
                        ) {
                            lastUnlockedFeaturePanelId = panel.id;
                            break;
                        }
                    }
                    if (lastUnlockedFeaturePanelId !== undefined) {
                        if (!requiresUndockedFeaturePanel) {
                            allPanels = allPanels.filter(
                                (panel) =>
                                    !isFeaturePanel(panel) || panel.locked || panel.id === lastUnlockedFeaturePanelId
                            );
                        }
                        targetPanelId = lastUnlockedFeaturePanelId;
                    } else {
                        mustCreateNewPanel = true;
                    }
                } else {
                    const firstUnlockedDockedPanel = allPanels.find(
                        (panel) =>
                            !panel.undocked &&
                            !panel.locked &&
                            (isSourceDataSelection ? isSourceDataPanel(panel) : isFeaturePanel(panel))
                    );
                    if (firstUnlockedDockedPanel) {
                        targetPanelId = firstUnlockedDockedPanel.id;
                    } else {
                        const firstUnlockedUndockedPanel = allPanels.find(
                            (panel) =>
                                panel.undocked &&
                                !panel.locked &&
                                (isSourceDataSelection ? isSourceDataPanel(panel) : isFeaturePanel(panel))
                        );
                        if (firstUnlockedUndockedPanel) {
                            targetPanelId = firstUnlockedUndockedPanel.id;
                        } else {
                            mustCreateNewPanel = true;
                        }
                    }
                }
            }

            if (mustCreateNewPanel) {
                const limit = this.inspectionsLimit;
                if (allPanels.length >= limit) {
                    this.infoMessageService.showWarning(
                        `Maximum of ${limit} inspections reached. Close an existing inspection to add more.`
                    );

                    return;
                }
                const newId = 1 + Math.max(-1, ...allPanels.map((panel) => panel.id));
                const newPanelUndocked = isSourceDataSelection || createUndockedFeaturePanel;
                allPanels.push({
                    id: newId,
                    features: isSourceDataSelection ? [] : featureSelection,
                    sourceData: sourceDataSelection,
                    locked: false,
                    size: [DEFAULT_EM_WIDTH, newPanelUndocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT],
                    color: DEFAULT_HIGHLIGHT_COLORS[newId % DEFAULT_HIGHLIGHT_COLORS.length],
                    undocked: newPanelUndocked
                });
                this.selectionState.next(allPanels);
                if (!newPanelUndocked) {
                    this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                    this.layout.isDockOpen = true;
                }
                this.setFocusedInspectionPanel(newId);
                this.reconcileComparison(allPanels);
                return newId;
            }

            if (targetPanelId !== undefined) {
                const panelIndex = allPanels.findIndex((panel) => panel.id === targetPanelId);
                if (panelIndex === -1) {
                    return;
                }
                if (sourceDataSelection !== undefined) {
                    allPanels[panelIndex].features = [];
                    allPanels[panelIndex].sourceData = sourceDataSelection;
                } else {
                    if (featureSelection.length) {
                        allPanels[panelIndex].features = featureSelection;
                    }
                    allPanels[panelIndex].sourceData = undefined;
                }
                this.selectionState.next(allPanels);
                if (!allPanels[panelIndex].undocked && !isSourceDataSelection) {
                    this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                    this.layout.isDockOpen = true;
                }
                this.setFocusedInspectionPanel(targetPanelId);
                this.reconcileComparison(allPanels);
                return targetPanelId;
            }

            return;
        });
    }

    /** Toggles one inspection panel between base-feature and attribute/validity-highlight pseudo-feature ids. */
    toggleInspectionFeatureHighlight(panelId: number, mapTileKey: string, targetFeatureId: string): void {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue();
            const panelIndex = allPanels.findIndex((panel) => panel.id === panelId && panel.sourceData === undefined);
            if (panelIndex === -1) {
                return;
            }

            const targetBaseFeatureId = stripFeatureInspectionTarget(targetFeatureId);
            const panel = allPanels[panelIndex];
            let changed = false;
            const nextFeatures = panel.features.map((feature) => {
                if (
                    feature.mapTileKey !== mapTileKey ||
                    stripFeatureInspectionTarget(feature.featureId) !== targetBaseFeatureId
                ) {
                    return feature;
                }
                changed = true;
                return {
                    ...feature,
                    featureId: feature.featureId === targetFeatureId ? targetBaseFeatureId : targetFeatureId
                };
            });
            if (!changed) {
                return;
            }

            const nextPanels = allPanels.slice();
            nextPanels[panelIndex] = {
                ...panel,
                features: nextFeatures
            };
            this.selectionState.next(nextPanels);
            if (!panel.undocked) {
                this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                this.layout.isDockOpen = true;
            }
            this.setFocusedInspectionPanel(panelId);
            this.reconcileComparison(nextPanels);
        });
    }

    /** Persists the size of one inspection panel. */
    setInspectionPanelSize(id: number, size: [number, number]) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const index = allPanels.findIndex((panel) => panel.id === id);
            if (index === -1) {
                return;
            }
            allPanels[index].size = size;
            this.selectionState.next(allPanels);
        });
    }

    /** Updates the locked state of one inspection panel. */
    setInspectionPanelLockedState(id: number, isLocked: boolean) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const index = allPanels.findIndex((panel) => panel.id === id);
            if (index === -1) {
                return;
            }
            allPanels[index].locked = isLocked;
            this.selectionState.next(allPanels);
        });
    }

    /** Persists whether one inspection panel is undocked. */
    setInspectionPanelUndockedState(id: number, undocked: boolean) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const index = allPanels.findIndex((panel) => panel.id === id);
            if (index === -1) {
                return;
            }
            allPanels[index].undocked = undocked;
            allPanels[index].size = [allPanels[index].size[0], undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT];
            if (!undocked) {
                allPanels[index].locked = true;
                this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                this.layout.isDockOpen = true;
            }
            this.selectionState.next(allPanels);
            this.setFocusedInspectionPanel(id);
        });
    }

    /** Marks one inspection panel as the active target for inspection-level shortcuts. */
    setFocusedInspectionPanel(id: number | undefined): void {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const fallbackId = allPanels.length ? allPanels[allPanels.length - 1].id : undefined;
            const nextId = id !== undefined && allPanels.some((panel) => panel.id === id) ? id : fallbackId;
            let changed = false;
            for (const panel of allPanels) {
                const nextFocused = panel.id === nextId;
                if ((panel.focused ?? false) === nextFocused) {
                    continue;
                }
                changed = true;
                if (nextFocused) {
                    panel.focused = true;
                } else {
                    delete panel.focused;
                }
            }
            if (changed) {
                this.selectionState.next(allPanels);
            }
        });
    }

    /** Returns whether the supplied inspection panel is the active shortcut target. */
    isInspectionPanelFocused(id: number): boolean {
        return this.focusedInspectionPanelId === id;
    }

    /** Stores row and header-button expansion state for the current in-memory inspection panel instance. */
    setInspectionTreeExpansionState(panelId: number, state: InspectionTreeExpansionState): void {
        this.inspectionTreeExpansionStates.set(panelId, this.cloneInspectionTreeExpansionState(state));
    }

    /** Returns a defensive copy of the last known expansion state for one inspection panel. */
    getInspectionTreeExpansionState(panelId: number): InspectionTreeExpansionState | undefined {
        const state = this.inspectionTreeExpansionStates.get(panelId);
        return state ? this.cloneInspectionTreeExpansionState(state) : undefined;
    }

    /** Persists the optional columns hidden by the user in one inspection panel. */
    setInspectionTreeHiddenColumns(panelId: number, hiddenColumns: Iterable<string>): void {
        return this.stateService.transaction(() => {
            const states = this.inspectionTreeHiddenColumnsState.getValue();
            this.inspectionTreeHiddenColumnsState.next({
                ...states,
                [panelId]: [...new Set(hiddenColumns)]
            });
        });
    }

    /** Returns a panel's persisted hidden columns, or undefined when defaults still apply. */
    getInspectionTreeHiddenColumns(panelId: number): string[] | undefined {
        const hiddenColumns = this.inspectionTreeHiddenColumnsState.getValue()[panelId];
        return hiddenColumns ? [...hiddenColumns] : undefined;
    }

    /** Clones an optional inspection-tree expansion snapshot. */
    private cloneInspectionTreeExpansionSnapshot(
        snapshot?: InspectionTreeExpansionSnapshot
    ): InspectionTreeExpansionSnapshot | undefined {
        return snapshot ? new Map(snapshot) : undefined;
    }

    /** Clones transient inspection-tree expansion state so component instances cannot share mutable maps. */
    private cloneInspectionTreeExpansionState(state: InspectionTreeExpansionState): InspectionTreeExpansionState {
        const clone: InspectionTreeExpansionState = {
            expandedNodes: new Map(state.expandedNodes),
            fullExpansionActive: state.fullExpansionActive,
            fullCollapseActive: state.fullCollapseActive
        };
        const expandSnapshot = this.cloneInspectionTreeExpansionSnapshot(state.expansionSnapshotBeforeFullExpand);
        if (expandSnapshot) {
            clone.expansionSnapshotBeforeFullExpand = expandSnapshot;
        }
        const collapseSnapshot = this.cloneInspectionTreeExpansionSnapshot(state.expansionSnapshotBeforeFullCollapse);
        if (collapseSnapshot) {
            clone.expansionSnapshotBeforeFullCollapse = collapseSnapshot;
        }
        return clone;
    }

    /** Returns the floating layout record for one inspection panel, if present. */
    getInspectionDialogLayout(panelId: number): InspectionDialogLayout | undefined {
        const layout = this.layout.getDialogLayout(this.inspectionLayoutId(panelId));
        if (layout && "panelId" in layout && "slot" in layout) {
            return layout as InspectionDialogLayout;
        }
        return undefined;
    }

    /** Returns or creates the floating layout record for one inspection panel. */
    ensureInspectionDialogLayout(
        panelId: number,
        preferredSlot: number,
        fallbackFactory: () => AppDialogLayout
    ): InspectionDialogLayout {
        const layoutId = this.inspectionLayoutId(panelId);
        const existing = this.getInspectionDialogLayout(panelId);
        if (existing) {
            return existing;
        }
        const fallback = fallbackFactory();
        const created: InspectionDialogLayout = {
            panelId,
            slot: preferredSlot,
            position: {...fallback.position},
            size: {...fallback.size}
        };
        this.layout.upsertDialogLayout(layoutId, created);
        return created;
    }

    /** Updates the stored floating position for one inspection panel. */
    setInspectionDialogPosition(panelId: number, position: AppDialogPosition, preferredIndex?: number): void {
        if (!this.selectionState.getValue().some((panel) => panel.id === panelId)) {
            return;
        }
        const current = this.getInspectionDialogLayout(panelId);
        if (current) {
            this.layout.upsertDialogLayout(this.inspectionLayoutId(panelId), {
                ...current,
                position: {left: position.left, top: position.top}
            });
            return;
        }
        const slot = preferredIndex ?? panelId;
        const existing = this.layout.getDialogLayout(this.inspectionLayoutId(panelId));
        this.layout.upsertDialogLayout(this.inspectionLayoutId(panelId), {
            panelId,
            slot,
            position: {left: position.left, top: position.top},
            size: existing?.size ?? {
                width: Math.round(this.defaultInspectionPanelSize[0] * this.layout.baseFontSize),
                height: Math.round(this.defaultInspectionPanelSize[1] * this.layout.baseFontSize)
            }
        });
    }

    /** Removes persisted inspection-dialog layouts for panels that no longer exist. */
    pruneInspectionDialogLayout(activePanelIds: number[]) {
        return this.stateService.transaction(() => {
            const activeIds = new Set(activePanelIds.map((panelId) => this.inspectionLayoutId(panelId)));
            const currentLayouts = this.layout.dialogLayoutsState.getValue();
            const nextLayouts: Record<string, AppDialogLayout | InspectionDialogLayout> = {};
            let changed = false;
            for (const [id, layout] of Object.entries(currentLayouts)) {
                if (id.startsWith("inspection:") && !activeIds.has(id)) {
                    changed = true;
                    continue;
                }
                nextLayouts[id] = layout;
            }
            if (changed) {
                this.layout.dialogLayoutsState.next(nextLayouts);
            }
            for (const id of Object.keys(currentLayouts)) {
                if (!(id in nextLayouts)) {
                    this.layout.removeDialogLayout(id);
                }
            }
        });
    }

    /** Removes transient inspection-tree expansion states for panels that no longer exist. */
    private pruneInspectionTreeExpansionStates(activePanelIds: number[]): void {
        const activeIds = new Set(activePanelIds);
        for (const panelId of this.inspectionTreeExpansionStates.keys()) {
            if (!activeIds.has(panelId)) {
                this.inspectionTreeExpansionStates.delete(panelId);
            }
        }
    }

    /** Removes persisted column overrides for inspection panels that no longer exist. */
    private pruneInspectionTreeHiddenColumns(activePanelIds: number[]): void {
        const activeIds = new Set(activePanelIds.map(String));
        const current = this.inspectionTreeHiddenColumnsState.getValue();
        const retained = Object.fromEntries(Object.entries(current).filter(([panelId]) => activeIds.has(panelId)));
        if (Object.keys(retained).length !== Object.keys(current).length) {
            this.inspectionTreeHiddenColumnsState.next(retained);
        }
    }

    /** Opens the inspection comparison dialog with the supplied model. */
    openInspectionComparison(model: InspectionComparisonModel): void {
        return this.stateService.transaction(() => {
            this.inspectionComparisonState.next(model);
        });
    }

    /** Closes the inspection comparison dialog. */
    closeInspectionComparison(): void {
        return this.stateService.transaction(() => {
            this.inspectionComparisonState.next(null);
        });
    }

    /** Reorders docked inspection panels according to the supplied display order. */
    reorderInspectionPanels(dockedDisplayOrder: number[]) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue();
            const dockedPanels = allPanels.filter((panel) => !panel.undocked);
            if (dockedPanels.length < 2) {
                return;
            }
            const dockedById = new Map(dockedPanels.map((panel) => [panel.id, panel]));
            const normalizedDisplayOrder = dockedDisplayOrder.filter((id) => dockedById.has(id));
            if (normalizedDisplayOrder.length !== dockedPanels.length) {
                dockedPanels.forEach((panel) => {
                    if (!normalizedDisplayOrder.includes(panel.id)) {
                        normalizedDisplayOrder.push(panel.id);
                    }
                });
            }
            const rawOrder = normalizedDisplayOrder.toReversed();
            let dockedIndex = 0;
            const nextPanels = allPanels.map((panel) => {
                if (panel.undocked) {
                    return panel;
                }
                const nextId = rawOrder[dockedIndex++];
                return dockedById.get(nextId)!;
            });
            if (!this.panelOrderEquals(allPanels, nextPanels)) {
                this.selectionState.next(nextPanels);
            }
        });
    }

    /** Sets the accent color stored for one inspection panel. */
    setInspectionPanelColor(id: number, color: string) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const index = allPanels.findIndex((panel) => panel.id === id);
            if (index === -1) {
                return;
            }
            allPanels[index].color = color;
            this.selectionState.next(allPanels);
        });
    }

    /** Drops all unlocked inspection panels, preserving only pinned selections. */
    unsetUnlockedSelections() {
        return this.stateService.transaction(() => {
            const nextSelection = this.selectionState
                .getValue()
                .filter((panel) => panel.locked || panel.sourceData !== undefined);
            this.selectionState.next(nextSelection);
            this.reconcileComparison(nextSelection);
        });
    }

    /** Removes one inspection panel and any associated persisted layout state. */
    unsetPanel(id: number) {
        return this.stateService.transaction(() => {
            const allPanels = this.selectionState.getValue().map((panel) => ({...panel}));
            const index = allPanels.findIndex((panel) => panel.id === id);
            if (index === -1) {
                return;
            }
            allPanels.splice(index, 1);
            this.selectionState.next(allPanels);
            this.reconcileComparison(allPanels);
        });
    }

    /** Finds the first regular inspection panel containing any of the requested feature identities. */
    private findPanelIdContainingFeatureSelection(
        panels: InspectionPanelModel<TileFeatureId>[],
        features: TileFeatureId[]
    ): number | undefined {
        return panels.find(
            (panel) =>
                panel.sourceData === undefined &&
                panel.features.some((existing) =>
                    features.some(
                        (feature) =>
                            feature.featureId === existing.featureId && feature.mapTileKey === existing.mapTileKey
                    )
                )
        )?.id;
    }

    /** Keeps the focused inspection panel id aligned with the current selection set. */
    private sanitizeFocusedInspectionPanel(panels: InspectionPanelModel<TileFeatureId>[]): void {
        const focused = panels.find((panel) => panel.focused)?.id ?? panels.at(-1)?.id;
        const normalized = panels.map((panel) => {
            const shouldFocus = panel.id === focused;
            if (!!panel.focused === shouldFocus) return panel;
            const next = {...panel};
            if (shouldFocus) next.focused = true;
            else delete next.focused;
            return next;
        });
        if (normalized.some((panel, index) => panel !== panels[index])) {
            this.selectionState.next(normalized);
        }
    }

    /** Returns whether two inspection-panel orderings are identical by panel id. */
    private panelOrderEquals(
        a: InspectionPanelModel<TileFeatureId>[],
        b: InspectionPanelModel<TileFeatureId>[]
    ): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i].id !== b[i].id) {
                return false;
            }
        }
        return true;
    }

    /** Builds the persisted layout id used for one floating inspection dialog. */
    private inspectionLayoutId(panelId: number): string {
        return `inspection:${panelId}`;
    }

    /** Drops stale comparison state when the current selection no longer supports it. */
    reconcileComparison(panels: InspectionPanelModel<TileFeatureId>[]): void {
        return this.stateService.transaction(() => {
            const model = this.inspectionComparisonState.getValue();
            if (!model) {
                return;
            }
            const eligiblePanelIds = new Set(
                panels
                    .filter((panel) => panel.sourceData === undefined && panel.features.length > 0)
                    .map((panel) => panel.id)
            );
            const nextModel = this.sanitizeInspectionComparisonModel(model, eligiblePanelIds);
            if (nextModel === model) {
                return;
            }
            this.inspectionComparisonState.next(nextModel);
        });
    }

    /** Removes ineligible panels from a comparison model and drops empty results. */
    private sanitizeInspectionComparisonModel(
        model: InspectionComparisonModel,
        eligiblePanelIds: Set<number>
    ): InspectionComparisonModel | null {
        const entries = [model.base, ...model.others];
        const remainingEntries = entries.filter((entry) => eligiblePanelIds.has(entry.panelId));
        if (remainingEntries.length === entries.length) {
            return model;
        }
        if (remainingEntries.length === 0) {
            return null;
        }
        return {
            base: remainingEntries[0],
            others: remainingEntries.slice(1)
        };
    }

    /** Builds comparison candidates from the currently selected feature panels. */
    buildCompareOptions(
        panels: InspectionPanelModel<FeatureWrapper>[],
        excludePanelId?: number
    ): InspectionComparisonOption[] {
        return panels
            .filter((panel) => excludePanelId === undefined || panel.id !== excludePanelId)
            .filter((panel) => this.isFeaturePanel(panel))
            .map((panel) => ({
                label: this.formatFeatureLabel(panel.features),
                value: panel.id
            }));
    }

    /** Narrows inspection panels to those that represent actual feature selections. */
    private isFeaturePanel(
        panel: InspectionPanelModel<FeatureWrapper> | undefined
    ): panel is InspectionPanelModel<FeatureWrapper> {
        return !!panel && panel.features.length > 0 && panel.sourceData === undefined;
    }

    /** Formats the user-facing label used for comparison entries. */
    private formatFeatureLabel(features: FeatureWrapper[]): string {
        return features.map((feature) => `${feature.featureTile.mapName}.${feature.featureId}`).join(", ");
    }

    /** Builds one comparison entry from an existing feature inspection panel. */
    private createComparisonEntryFromPanel(panel: InspectionPanelModel<FeatureWrapper>): InspectionComparisonEntry {
        return {
            panelId: panel.id,
            mapId: panel.features[0]?.featureTile.mapName ?? "",
            label: this.formatFeatureLabel(panel.features),
            featureIds: panel.features.map((feature) => ({
                mapTileKey: feature.mapTileKey,
                featureId: feature.featureId
            }))
        };
    }

    /** Creates the comparison-dialog model for the selected set of feature panels. */
    createComparisonModel(
        basePanelId: number,
        otherPanelIds: number[],
        panels: InspectionPanelModel<FeatureWrapper>[]
    ): InspectionComparisonModel | null {
        const panelsById = new Map(panels.filter(this.isFeaturePanel).map((panel) => [panel.id, panel] as const));
        const basePanel = panelsById.get(basePanelId);
        if (!basePanel) {
            return null;
        }
        const others = Array.from(new Set(otherPanelIds))
            .filter((panelId) => panelId !== basePanelId)
            .slice(0, MAX_COMPARE_PANELS - 1)
            .map((panelId) => panelsById.get(panelId))
            .filter((panel): panel is InspectionPanelModel<FeatureWrapper> => !!panel)
            .map((panel) => this.createComparisonEntryFromPanel(panel));

        return {
            base: this.createComparisonEntryFromPanel(basePanel),
            others
        };
    }
    constructor(
        private readonly stateService: AppStateService,
        private readonly infoMessageService: InfoMessageService,
        private readonly layout: AppLayoutService
    ) {
        this.registerControls();

        this.selectionState.subscribe((panels) => {
            this.panelLifetimes = new Map(panels.map((panel) => [panel.id, this.panelLifetimes.get(panel.id) ?? {}]));
        });
        this.actions.registerAction(
            InspectionStateService.actions.closeInspection,
            ({panelId}) => this.closeInspection(panelId),
            {suggest: (query) => this.closeInspectionSuggestions(query)}
        );
        this.stateService.beforeCommit(
            () => {
                const panels = this.selectionState.getValue();
                if (panels === this.selectionState.signal()) return;
                const panelIds = panels.map((panel) => panel.id);
                this.pruneInspectionDialogLayout(panelIds);
                this.pruneInspectionTreeExpansionStates(panelIds);
                this.pruneInspectionTreeHiddenColumns(panelIds);
                this.sanitizeFocusedInspectionPanel(panels);
                this.reconcileComparison(panels);
            },
            () => this.selectionState.writeOrigin
        );
    }

    private registerControls(): void {
        const controls = InspectionStateService.controls;
        this.actions.registerControl(controls.preferences, {
            read: () => this.inspectionPreferences(),
            write: (_, value) => this.setInspectionPreferences(value)
        });
        this.actions.registerControl(controls.hover, {
            read: () => ({enabled: this.hoverLabelsEnabled, fields: this.hoverLabelFields}),
            write: (_, value) => this.setHoverPreferences(value)
        });
        this.actions.registerControl(controls.panel, {
            read: ({panelId}) => this.panelPresentation(panelId),
            write: ({panelId}, value) => this.setPanelPresentation(panelId, value)
        });
    }

    inspectionPreferences() {
        return {
            limit: this.inspectionsLimit,
            drillPickRadius: this.drillPickRadius,
            expandByDefault: this.inspectionTreeExpandByDefault,
            varyColors: this.inspectionValueVaryColors,
            varyOutlines: this.inspectionValueVaryOutlines,
            varyStriping: this.inspectionValueVaryStriping
        };
    }

    setInspectionPreferences(value: z.infer<typeof InspectionStateService.controls.preferences.valueSchema>): void {
        this.stateService.transaction(() => {
            this.inspectionsLimit = value.limit;
            this.drillPickRadius = value.drillPickRadius;
            this.inspectionTreeExpandByDefault = value.expandByDefault;
            this.inspectionValueVaryColors = value.varyColors;
            this.inspectionValueVaryOutlines = value.varyOutlines;
            this.inspectionValueVaryStriping = value.varyStriping;
        });
    }

    setHoverPreferences(value: z.infer<typeof InspectionStateService.controls.hover.valueSchema>): void {
        this.stateService.transaction(() => {
            this.hoverLabelsEnabled = value.enabled;
            this.hoverLabelFields = value.fields;
        });
    }

    panelPresentation(panelId: number) {
        const panel = this.selection.find((panel) => panel.id === panelId);
        if (!panel) rejectAction("The inspection no longer exists");
        return {
            locked: panel.locked,
            undocked: panel.undocked,
            focused: this.focusedInspectionPanelId === panel.id,
            color: panel.color
        };
    }

    setPanelPresentation(
        panelId: number,
        value: z.infer<typeof InspectionStateService.controls.panel.valueSchema>
    ): void {
        this.panelPresentation(panelId);
        if (!value.undocked && !value.locked) rejectAction("Docked inspections are locked", "invalid_arguments");
        this.stateService.transaction(() => {
            this.setInspectionPanelUndockedState(panelId, value.undocked);
            this.setInspectionPanelLockedState(panelId, value.locked);
            this.setInspectionPanelColor(panelId, value.color);
            if (value.focused || this.focusedInspectionPanelId === panelId)
                this.setFocusedInspectionPanel(value.focused ? panelId : undefined);
        });
    }
}
