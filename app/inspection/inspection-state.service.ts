import { Injectable } from "@angular/core";
import { z } from "zod";
import { ActionInput, AppActionCandidate, ControlValue, applied, rejectAction } from "../actions/app-action";
import { AppActionService } from "../actions/app-action.service";
import { coreLib } from "../integrations/wasm";
import type { FeatureWrapper } from "../mapdata/feature-inspection.model";
import type { MapTreeNode } from "../mapdata/map.tree.model";
import { parseMapPartitionKey } from "../mapdata/partition.model";
import {
    AppDialogLayout,
    AppDialogPosition,
    DEFAULT_DOCKED_EM_HEIGHT,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    INSPECTION_DOCK_TAB_ID
} from "../shared/app-layout.model";
import { AppLayoutService } from "../shared/app-layout.service";
import { Boolish } from "../shared/app-state";
import { AppStateService } from "../shared/appstate.service";
import { InfoMessageService } from "../shared/info.service";
import { stripFeatureInspectionTarget } from "../shared/tile-feature-id";
import {
    DEFAULT_DRILL_PICK_RADIUS,
    DEFAULT_HIGHLIGHT_COLORS,
    DEFAULT_HOVER_LABEL_FIELDS,
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
import { inspectionStateActions, inspectionStateControls } from "./inspection-state.service.declarations";

/** Owns persisted panel identities, focus, comparison and inspection presentation invariants. */
@Injectable({ providedIn: "root" })
export class InspectionStateService {
    constructor(private readonly persistence: AppStateService,
        private readonly layout: AppLayoutService,
        private readonly infoMessageService: InfoMessageService) {
        this.selectionState.subscribe(panels => {
            const ids = panels.map(panel => panel.id);
            for (const id of [...this.panelLifetimes.keys()]) if (!ids.includes(id)) this.panelLifetimes.delete(id);
            for (const id of ids) if (!this.panelLifetimes.has(id)) this.panelLifetimes.set(id, ++this.nextPanelLifetime);
            this.pruneInspectionDialogLayout(ids);
            this.pruneInspectionTreeExpansionStates(ids);
            this.pruneInspectionTreeHiddenColumns(ids);

        });
    }

    private readonly inspectionTreeExpansionStates = new Map<number, InspectionTreeExpansionState>();

    /** Returns the default inspection panel size. */
    get defaultInspectionPanelSize(): [number, number] {
        return [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];
    }

    // 2~0f~features:map:layer:tile~featureid~layertype:map:layer:tile~featureid~layertype:map:layer:tile~featureid~245:56
    // 1~0~sourcedata:map:layer:tile~address~...features...~size
    // 0~1~...
    readonly selectionState = this.persistence.registerState<InspectionPanelModel<TileFeatureId>[]>({
        name: 'selected',
        normalize: panels => {
            const next = structuredClone(panels);
            this.sanitizeFocusedInspectionPanel(next);
            return next;
        },
        defaultValue: [],
        schema: z.array(z.string()),
        toStorage: (value: InspectionPanelModel<TileFeatureId>[]) => {
            return value.map(state => {
                let s = `${state.id}~${state.locked ? 1 : 0}${state.focused ? 'f' : ''}~`;
                if (state.sourceData) {
                    s += `${state.sourceData.mapTileKey}~${state.sourceData.address ?? ''}~`
                }
                s += `${state.features.map(id => `${id.mapTileKey}~${id.featureId}`).join('~')}~`;
                // Remove # character from hex color
                const color = state.color.startsWith('#') ? state.color.slice(1) : state.color;
                s += `${state.size[0]}:${state.size[1]}~${color}~${state.undocked ? 1 : 0}`;
                return s;
            });
        },
        fromStorage: (payload: any): InspectionPanelModel<TileFeatureId>[] => {
            const result: InspectionPanelModel<TileFeatureId>[] = []
            if (!payload || !payload.length) {
                return result;
            }
            for (const panelStateStr of payload) {
                const parts: string[] = panelStateStr.split('~');
                if (parts.length < 7) {
                    continue;
                }
                const id = Number(parts.shift()!);
                const panelFlags = parts.shift()!;
                const lockState = panelFlags.startsWith("1");
                const focused = panelFlags.includes("f");
                const undocked = parts.pop()! === "1";
                const colorToken = parts.pop()!;
                const color = colorToken.length > 0 && !colorToken.startsWith('#') ? `#${colorToken}` : colorToken;
                const sizeToken = parts.pop()!;
                const sizeParts = sizeToken.split(':');
                const size = sizeParts.length === 2 ? [Number(sizeParts[0]), Number(sizeParts[1])] : this.defaultInspectionPanelSize;

                const newPanelState: InspectionPanelModel<TileFeatureId> = {
                    id: id,
                    features: [],
                    locked: lockState || !undocked,
                    focused: focused || undefined,
                    size: size as [number, number],
                    color: color,
                    undocked: undocked
                };

                // Check if the first MapTileKey is for SourceData.
                if (parts[0].startsWith("SourceData:")) {
                    const mapTileKey = parts.shift()!;
                    newPanelState.sourceData = {
                        mapTileKey: mapTileKey,
                        address: parts[0].length ? BigInt(parts[0]) : undefined
                    };
                    // Shift the address.
                    parts.shift();
                }

                // The remaining strings are MapTileKey-FeatureId-pairs.
                while (parts.length >= 2) {
                    newPanelState.features.push({
                        mapTileKey: parts.shift()!,
                        featureId: parts.shift()!
                    })
                }

                result.push(newPanelState);
            }
            return result;
        },
        urlParamName: 'sel',
        urlIncludeInVisualizationOnly: false
    });

    readonly inspectionsLimitState = this.persistence.registerState<number>({
        name: 'inspectionsLimitState',
        defaultValue: Math.floor(MAX_SIMULTANEOUS_INSPECTIONS / 2),
        schema: z.coerce.number().int().min(1).max(MAX_SIMULTANEOUS_INSPECTIONS)
    });

    readonly drillPickRadiusState = this.persistence.registerState<number>({
        name: 'drillPickRadius',
        defaultValue: DEFAULT_DRILL_PICK_RADIUS,
        schema: z.coerce.number().int().min(MIN_DRILL_PICK_RADIUS).max(MAX_DRILL_PICK_RADIUS)
    });

    readonly inspectionTreeExpandByDefaultState = this.persistence.registerState<boolean>({
        name: 'inspectionTreeExpandByDefault',
        defaultValue: false,
        schema: Boolish
    });

    readonly sourceDataInspectionDefaultColumnsState = this.persistence.registerState<string[]>({
        name: 'sourceDataInspectionDefaultColumns',
        defaultValue: [],
        schema: z.array(z.enum(["displayAddress", "schemaType"]))
    });

    readonly inspectionTreeHiddenColumnsState = this.persistence.registerState<Record<string, string[]>>({
        name: 'inspectionTreeHiddenColumns',
        defaultValue: {},
        schema: z.record(z.string(), z.array(z.string())),
        snapshotPersist: false
    });

    readonly inspectionValueVaryColorsState = this.persistence.registerState<boolean>({
        name: 'inspectionValueVaryColors',
        defaultValue: true,
        schema: Boolish
    });

    readonly inspectionValueVaryOutlinesState = this.persistence.registerState<boolean>({
        name: 'inspectionValueVaryOutlines',
        defaultValue: false,
        schema: Boolish
    });

    readonly inspectionValueVaryStripingState = this.persistence.registerState<boolean>({
        name: 'inspectionValueVaryStriping',
        defaultValue: false,
        schema: Boolish
    });

    readonly hoverLabelsEnabledState = this.persistence.registerState<boolean>({
        name: 'hoverLabelsEnabled',
        defaultValue: true,
        schema: Boolish
    });

    readonly hoverLabelFieldsState = this.persistence.registerState<HoverLabelFieldConfig[]>({
        name: 'hoverLabelFields',
        defaultValue: DEFAULT_HOVER_LABEL_FIELDS.map(field => ({ ...field })),
        schema: z.array(z.object({
            expression: z.string(),
            customExpression: Boolish,
            displayKey: z.string().optional()
        }))
    });

    readonly inspectionComparisonState = this.persistence.registerState<InspectionComparisonModel | null>({
        name: 'inspectionComparisonState',
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.object({
                base: z.object({
                    panelId: z.coerce.number(),
                    mapId: z.string().optional().default(''),
                    label: z.string(),
                    featureIds: z.array(z.object({
                        featureId: z.string(),
                        mapTileKey: z.string()
                    }))
                }),
                others: z.array(z.object({
                    panelId: z.coerce.number(),
                    mapId: z.string().optional().default(''),
                    label: z.string(),
                    featureIds: z.array(z.object({
                        featureId: z.string(),
                        mapTileKey: z.string()
                    }))
                }))
            })
        ])
    });

    get selection() { return this.selectionState.getValue(); }

    set selection(val: InspectionPanelModel<TileFeatureId>[]) { this.selectionState.next(val); }

    get focusedInspectionPanelId() {
        return this.selectionState.getValue().find(panel => panel.focused)?.id;
    }

    set focusedInspectionPanelId(val: number | undefined) {
        this.setFocusedInspectionPanel(val);
    }

    get inspectionsLimit() { return this.inspectionsLimitState.getValue(); }

    set inspectionsLimit(val: number) {
        const numeric = Number(val);
        if (!Number.isFinite(numeric)) {
            return;
        }
        const normalized = Math.min(MAX_SIMULTANEOUS_INSPECTIONS, Math.max(1, Math.trunc(numeric)));
        this.inspectionsLimitState.next(normalized);
    }

    get drillPickRadius() { return this.drillPickRadiusState.getValue(); }

    set drillPickRadius(val: number) {
        const numeric = Number(val);
        if (!Number.isFinite(numeric)) {
            return;
        }
        const normalized = Math.min(MAX_DRILL_PICK_RADIUS, Math.max(MIN_DRILL_PICK_RADIUS, Math.trunc(numeric)));
        this.drillPickRadiusState.next(normalized);
    }

    get inspectionComparison() { return this.inspectionComparisonState.getValue(); }

    set inspectionComparison(val: InspectionComparisonModel | null) { this.inspectionComparisonState.next(val); }

    get inspectionTreeExpandByDefault() { return this.inspectionTreeExpandByDefaultState.getValue(); }

    set inspectionTreeExpandByDefault(val: boolean) { this.inspectionTreeExpandByDefaultState.next(!!val); }

    get sourceDataInspectionDefaultColumns() {
        return this.sourceDataInspectionDefaultColumnsState.getValue();
    }

    set sourceDataInspectionDefaultColumns(val: string[]) {
        const allowed = new Set(["displayAddress", "schemaType"]);
        this.sourceDataInspectionDefaultColumnsState.next(
            [...new Set(val.filter(column => allowed.has(column)))]);
    }

    get inspectionValueVaryColors() { return this.inspectionValueVaryColorsState.getValue(); }

    set inspectionValueVaryColors(val: boolean) { this.inspectionValueVaryColorsState.next(!!val); }

    get inspectionValueVaryOutlines() { return this.inspectionValueVaryOutlinesState.getValue(); }

    set inspectionValueVaryOutlines(val: boolean) { this.inspectionValueVaryOutlinesState.next(!!val); }

    get inspectionValueVaryStriping() { return this.inspectionValueVaryStripingState.getValue(); }

    set inspectionValueVaryStriping(val: boolean) { this.inspectionValueVaryStripingState.next(!!val); }

    get hoverLabelsEnabled() { return this.hoverLabelsEnabledState.getValue(); }

    set hoverLabelsEnabled(val: boolean) { this.hoverLabelsEnabledState.next(!!val); }

    get hoverLabelFields() { return this.hoverLabelFieldsState.getValue(); }

    set hoverLabelFields(val: HoverLabelFieldConfig[]) {
        this.hoverLabelFieldsState.next(val.map(field => ({ ...field })));
    }

    /** Updates the current selection, reusing or creating inspection panels as needed. */
    setSelection(
        newSelection: TileFeatureId[] | SelectedSourceData,
        id?: number,
        forceNewPanel = false,
        createUndockedFeaturePanel = false
    ): number | undefined {
        let panelId: number | undefined;
        this.persistence.transaction(() => {
            panelId = this.updateSelection(newSelection, id, forceNewPanel, createUndockedFeaturePanel);
        });
        return panelId;
    }

    /** Applies panel reuse, focus and dock rules inside the caller's coordinated edit. */
    private updateSelection(
        newSelection: TileFeatureId[] | SelectedSourceData,
        id: number | undefined,
        forceNewPanel: boolean,
        createUndockedFeaturePanel: boolean
    ): number | undefined {
        this.persistence.requestHistoryEntry();
        let allPanels = structuredClone(this.selectionState.getValue());
        const originPanel = id !== undefined ? allPanels.find(panel => panel.id === id) : undefined;
        const sourceDataSelection = !Array.isArray(newSelection) ? newSelection as SelectedSourceData : undefined;
        const isSourceDataSelection = sourceDataSelection !== undefined;
        let featureSelection = Array.isArray(newSelection) ? newSelection as TileFeatureId[] : [];
        const duplicateFeaturePanelId = !isSourceDataSelection && featureSelection.length
            ? this.findPanelIdContainingFeatureSelection(allPanels, featureSelection)
            : undefined;
        if (!isSourceDataSelection && id === undefined && featureSelection.length > 0 && !createUndockedFeaturePanel) {
            this.layout.isDockOpen = true;
        }
        const isFeaturePanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData === undefined;
        const isSourceDataPanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData !== undefined;
        const isClearSourceDataRequest =
            originPanel !== undefined &&
            sourceDataSelection === undefined &&
            originPanel.sourceData !== undefined;

        // Filter out features which are already selected. If there are none left, we don't need to do anything
        // unless we are explicitly clearing a source data selection.
        if (featureSelection.length && !forceNewPanel) {
            featureSelection = featureSelection.filter(feature =>
                !allPanels.some(panel =>
                    isFeaturePanel(panel) &&
                    panel.features.some(otherFeature =>
                        feature.featureId === otherFeature.featureId && feature.mapTileKey === otherFeature.mapTileKey)));
            if (!featureSelection.length && !isClearSourceDataRequest) {
                const duplicatePanel = allPanels.find(panel => panel.id === duplicateFeaturePanelId);
                if (duplicatePanel && !duplicatePanel.undocked && !createUndockedFeaturePanel) {
                    this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
                    this.layout.isDockOpen = true;
                }
                this.setFocusedInspectionPanel(duplicateFeaturePanelId);
                this.persistence.replaceHistoryEntry();
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
        if (!forceNewPanel &&
            targetPanelId === undefined &&
            originPanel &&
            !isSourceDataSelection &&
            isFeaturePanel(originPanel) &&
            (isClearSourceDataRequest || !originPanel.locked)) {
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
                    if (isFeaturePanel(panel) && !panel.locked &&
                        (!requiresUndockedFeaturePanel || panel.undocked)) {
                        lastUnlockedFeaturePanelId = panel.id;
                        break;
                    }
                }
                if (lastUnlockedFeaturePanelId !== undefined) {
                    if (!requiresUndockedFeaturePanel) {
                        allPanels = allPanels.filter(panel =>
                            !isFeaturePanel(panel) ||
                            panel.locked ||
                            panel.id === lastUnlockedFeaturePanelId
                        );
                    }
                    targetPanelId = lastUnlockedFeaturePanelId;
                } else {
                    mustCreateNewPanel = true;
                }
            } else {
                const firstUnlockedDockedPanel = allPanels.find(panel =>
                    !panel.undocked &&
                    !panel.locked &&
                    (isSourceDataSelection ? isSourceDataPanel(panel) : isFeaturePanel(panel))
                );
                if (firstUnlockedDockedPanel) {
                    targetPanelId = firstUnlockedDockedPanel.id;
                } else {
                    const firstUnlockedUndockedPanel = allPanels.find(panel =>
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
                this.infoMessageService.showWarning(`Maximum of ${limit} inspections reached. Close an existing inspection to add more.`);
                this.persistence.replaceHistoryEntry();
                return;
            }
            const newId = Math.max(this.lastIssuedPanelId + 1, 1 + Math.max(-1, ...allPanels.map(panel => panel.id)));
            this.lastIssuedPanelId = newId;
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
            this.sanitizeInspectionComparisonForSelection(allPanels);
            return newId;
        }

        if (targetPanelId !== undefined) {
            const panelIndex = allPanels.findIndex(panel => panel.id === targetPanelId);
            if (panelIndex === -1) {
                this.persistence.replaceHistoryEntry();
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
            this.sanitizeInspectionComparisonForSelection(allPanels);
            return targetPanelId;
        }

        return;
    }

    /** Toggles one inspection panel between base-feature and attribute/validity-highlight pseudo-feature ids. */
    toggleInspectionFeatureHighlight(panelId: number, mapTileKey: string, targetFeatureId: string): void {
        const allPanels = structuredClone(this.selectionState.getValue());
        const panelIndex = allPanels.findIndex(panel => panel.id === panelId && panel.sourceData === undefined);
        if (panelIndex === -1) {
            return;
        }

        const targetBaseFeatureId = stripFeatureInspectionTarget(targetFeatureId);
        const panel = allPanels[panelIndex];
        let changed = false;
        const nextFeatures = panel.features.map(feature => {
            if (feature.mapTileKey !== mapTileKey ||
                stripFeatureInspectionTarget(feature.featureId) !== targetBaseFeatureId) {
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
        this.sanitizeInspectionComparisonForSelection(nextPanels);
    }

    /** Persists the size of one inspection panel. */
    setInspectionPanelSize(id: number, size: [number, number]) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].size = size;
        this.selectionState.next(allPanels);
    }

    /** Updates the locked state of one inspection panel. */
    setInspectionPanelLockedState(id: number, isLocked: boolean) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].locked = isLocked;
        this.selectionState.next(allPanels);
    }

    /** Persists whether one inspection panel is undocked. */
    setInspectionPanelUndockedState(id: number, undocked: boolean) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].undocked = undocked;
        allPanels[index].size = [
            allPanels[index].size[0],
            undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT
        ];
        if (!undocked) {
            allPanels[index].locked = true;
            this.layout.dockActiveTab = INSPECTION_DOCK_TAB_ID;
            this.layout.isDockOpen = true;
        }
        this.selectionState.next(allPanels);
        this.setFocusedInspectionPanel(id);
    }

    /** Marks one inspection panel as the active target for inspection-level shortcuts. */
    setFocusedInspectionPanel(id: number | undefined): void {
        const allPanels = structuredClone(this.selectionState.getValue());
        const fallbackId = allPanels.length ? allPanels[allPanels.length - 1].id : undefined;
        const nextId = id !== undefined && allPanels.some(panel => panel.id === id)
            ? id
            : fallbackId;
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
        const states = this.inspectionTreeHiddenColumnsState.getValue();
        this.inspectionTreeHiddenColumnsState.next({
            ...states,
            [panelId]: [...new Set(hiddenColumns)]
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
        if (layout && 'panelId' in layout && 'slot' in layout) {
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
            position: { ...fallback.position },
            size: { ...fallback.size }
        };
        this.layout.upsertDialogLayout(layoutId, created);
        return created;
    }

    /** Updates the stored floating position for one inspection panel. */
    setInspectionDialogPosition(panelId: number, position: AppDialogPosition, preferredIndex?: number): void {
        if (!this.selectionState.getValue().some(panel => panel.id === panelId)) {
            return;
        }
        const current = this.getInspectionDialogLayout(panelId);
        if (current) {
            this.layout.upsertDialogLayout(this.inspectionLayoutId(panelId), {
                ...current,
                position: { left: position.left, top: position.top }
            });
            return;
        }
        const slot = preferredIndex ?? panelId;
        const existing = this.layout.getDialogLayout(this.inspectionLayoutId(panelId));
        this.layout.upsertDialogLayout(this.inspectionLayoutId(panelId), {
            panelId,
            slot,
            position: { left: position.left, top: position.top },
            size: existing?.size ?? {
                width: Math.round(this.defaultInspectionPanelSize[0] * this.layout.baseFontSize),
                height: Math.round(this.defaultInspectionPanelSize[1] * this.layout.baseFontSize)
            }
        });
    }

    /** Removes persisted inspection-dialog layouts for panels that no longer exist. */
    pruneInspectionDialogLayout(activePanelIds: number[]) {
        const activeIds = new Set(activePanelIds.map(panelId => this.inspectionLayoutId(panelId)));
        const currentLayouts = this.layout.dialogLayoutsState.getValue();
        const nextLayouts: Record<string, AppDialogLayout | InspectionDialogLayout> = {};
        let changed = false;
        for (const [id, layout] of Object.entries(currentLayouts)) {
            if (id.startsWith('inspection:') && !activeIds.has(id)) {
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
        const retained = Object.fromEntries(
            Object.entries(current).filter(([panelId]) => activeIds.has(panelId)));
        if (Object.keys(retained).length !== Object.keys(current).length) {
            this.inspectionTreeHiddenColumnsState.next(retained);
        }
    }

    /** Opens the inspection comparison dialog with the supplied model. */
    openInspectionComparison(model: InspectionComparisonModel): void {
        this.inspectionComparisonState.next(model);
    }

    /** Closes the inspection comparison dialog. */
    closeInspectionComparison(): void {
        this.inspectionComparisonState.next(null);
    }

    /** Reorders docked inspection panels according to the supplied display order. */
    reorderInspectionPanels(dockedDisplayOrder: number[]) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const dockedPanels = allPanels.filter(panel => !panel.undocked);
        if (dockedPanels.length < 2) {
            return;
        }
        const dockedById = new Map(dockedPanels.map(panel => [panel.id, panel]));
        const normalizedDisplayOrder = dockedDisplayOrder.filter(id => dockedById.has(id));
        if (normalizedDisplayOrder.length !== dockedPanels.length) {
            dockedPanels.forEach(panel => {
                if (!normalizedDisplayOrder.includes(panel.id)) {
                    normalizedDisplayOrder.push(panel.id);
                }
            });
        }
        const rawOrder = normalizedDisplayOrder.toReversed();
        let dockedIndex = 0;
        const nextPanels = allPanels.map(panel => {
            if (panel.undocked) {
                return panel;
            }
            const nextId = rawOrder[dockedIndex++];
            return dockedById.get(nextId)!;
        });
        if (!this.panelOrderEquals(allPanels, nextPanels)) {
            this.selectionState.next(nextPanels);
        }
    }

    /** Sets the accent color stored for one inspection panel. */
    setInspectionPanelColor(id: number, color: string) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].color = color;
        this.selectionState.next(allPanels);
    }

    /** Drops all unlocked inspection panels, preserving only pinned selections. */
    unsetUnlockedSelections() {
        const nextSelection = this.selectionState.getValue().filter(panel =>
            panel.locked || panel.sourceData !== undefined
        );
        this.selectionState.next(nextSelection);
        this.sanitizeInspectionComparisonForSelection(nextSelection);
    }

    /** Removes one inspection panel and any associated persisted layout state. */
    unsetPanel(id: number) {
        const allPanels = structuredClone(this.selectionState.getValue());
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels.splice(index, 1);
        this.selectionState.next(allPanels);
        this.sanitizeInspectionComparisonForSelection(allPanels);
    }

    /** Finds the first regular inspection panel containing any of the requested feature identities. */
    private findPanelIdContainingFeatureSelection(
        panels: InspectionPanelModel<TileFeatureId>[],
        features: TileFeatureId[]
    ): number | undefined {
        return panels.find(panel =>
            panel.sourceData === undefined &&
            panel.features.some(existing =>
                features.some(feature =>
                    feature.featureId === existing.featureId &&
                    feature.mapTileKey === existing.mapTileKey
                )
            )
        )?.id;
    }

    /** Keeps the focused inspection panel id aligned with the current selection set. */
    private sanitizeFocusedInspectionPanel(panels: InspectionPanelModel<TileFeatureId>[]): void {
        let focusedSeen = false;
        const fallbackId = panels.length ? panels[panels.length - 1].id : undefined;
        for (const panel of panels) {
            if (panel.focused && !focusedSeen) {
                focusedSeen = true;
                continue;
            }
            if (panel.focused) {
                delete panel.focused;
            }
        }
        if (!focusedSeen && fallbackId !== undefined) {
            const fallbackPanel = panels.find(panel => panel.id === fallbackId);
            if (fallbackPanel) {
                fallbackPanel.focused = true;
            }
        }
    }

    /** Returns whether two inspection-panel orderings are identical by panel id. */
    private panelOrderEquals(a: InspectionPanelModel<TileFeatureId>[], b: InspectionPanelModel<TileFeatureId>[]): boolean {
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
    sanitizeInspectionComparisonForSelection(panels: InspectionPanelModel<TileFeatureId>[]): void {
        const model = this.inspectionComparisonState.getValue();
        if (!model) {
            return;
        }
        const eligiblePanelIds = new Set(
            panels
                .filter(panel => panel.sourceData === undefined && panel.features.length > 0)
                .map(panel => panel.id)
        );
        const nextModel = this.sanitizeInspectionComparisonModel(model, eligiblePanelIds);
        if (nextModel === model) {
            return;
        }
        this.inspectionComparisonState.next(nextModel);
    }

    /** Removes ineligible panels from a comparison model and drops empty results. */
    private sanitizeInspectionComparisonModel(model: InspectionComparisonModel, eligiblePanelIds: Set<number>): InspectionComparisonModel | null {
        const entries = [model.base, ...model.others];
        const remainingEntries = entries.filter(entry => eligiblePanelIds.has(entry.panelId));
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
    buildCompareOptions(panels: InspectionPanelModel<FeatureWrapper>[], excludePanelId?: number): InspectionComparisonOption[] {
        return panels
            .filter(panel => excludePanelId === undefined || panel.id !== excludePanelId)
            .filter(panel => this.isFeaturePanel(panel))
            .map(panel => ({
                label: this.formatFeatureLabel(panel.features),
                value: panel.id
            }));
    }

    /** Narrows inspection panels to those that represent actual feature selections. */
    private isFeaturePanel(panel: InspectionPanelModel<FeatureWrapper> | undefined): panel is InspectionPanelModel<FeatureWrapper> {
        return !!panel && panel.features.length > 0 && panel.sourceData === undefined;
    }

    /** Formats the user-facing label used for comparison entries. */
    private formatFeatureLabel(features: FeatureWrapper[]): string {
        return features.map(feature => `${feature.featureTile.mapName}.${feature.featureId}`).join(', ');
    }

    /** Builds one comparison entry from an existing feature inspection panel. */
    private createComparisonEntryFromPanel(panel: InspectionPanelModel<FeatureWrapper>): InspectionComparisonEntry {
        return {
            panelId: panel.id,
            mapId: panel.features[0]?.featureTile.mapName ?? '',
            label: this.formatFeatureLabel(panel.features),
            featureIds: panel.features.map(feature => ({
                mapTileKey: feature.mapTileKey,
                featureId: feature.featureId
            }))
        };
    }

    /** Creates the comparison-dialog model for the selected set of feature panels. */
    createComparisonModel(basePanelId: number, otherPanelIds: number[], panels: InspectionPanelModel<FeatureWrapper>[]): InspectionComparisonModel | null {
        const panelsById = new Map(
            panels
                .filter(this.isFeaturePanel)
                .map(panel => [panel.id, panel] as const)
        );
        const basePanel = panelsById.get(basePanelId);
        if (!basePanel) {
            return null;
        }
        const others = Array.from(new Set(otherPanelIds))
            .filter(panelId => panelId !== basePanelId)
            .slice(0, MAX_COMPARE_PANELS - 1)
            .map(panelId => panelsById.get(panelId))
            .filter((panel): panel is InspectionPanelModel<FeatureWrapper> => !!panel)
            .map(panel => this.createComparisonEntryFromPanel(panel));

        return {
            base: this.createComparisonEntryFromPanel(basePanel),
            others
        };
    }

    registerActions(actions: AppActionService): void {
        actions.registerAction(inspectionStateActions.closeInspection, input => {
            this.closeInspection(input.panelId, input.lifetime);
            return applied();
        }, query => this.closeInspectionCandidates(query));
        actions.registerControl(inspectionStateControls.preferences, {
            read: () => ({
                limit: this.inspectionsLimit, drillPickRadius: this.drillPickRadius,
                expandByDefault: this.inspectionTreeExpandByDefault, varyColors: this.inspectionValueVaryColors,
                varyOutlines: this.inspectionValueVaryOutlines, varyStriping: this.inspectionValueVaryStriping
            }),
            write: (_selector, value) => this.setInspectionPreferences(value)
        });
        actions.registerControl(inspectionStateControls.hover, {
            read: () => ({ enabled: this.hoverLabelsEnabled, fields: this.hoverLabelFields }),
            write: (_selector, value) => this.persistence.transaction(() => {
                this.hoverLabelsEnabled = value.enabled;
                this.hoverLabelFields = value.fields;
            })
        });
        actions.registerControl(inspectionStateControls.panel, {
            read: ({ panelId }) => this.panelPresentation(panelId),
            write: ({ panelId }, value) => this.setPanelPresentation(panelId, value)
        });
    }

    private nextPanelLifetime = 0;
    private lastIssuedPanelId = -1;
    private readonly panelLifetimes = new Map<number, number>();

    panelLifetime(panelId: number): number | undefined { return this.panelLifetimes.get(panelId); }

    /** Captured omnibar choices must not close a later panel that reused the numeric ID. */
    closeInspection(panelId: number, lifetime?: number): void {
        if (!this.selection.some(panel => panel.id === panelId) ||
            (lifetime !== undefined && lifetime !== this.panelLifetime(panelId))) rejectAction("The inspection no longer exists");
        this.persistence.transaction(() => this.unsetPanel(panelId));
    }

    setInspectionPreferences(value: ControlValue<typeof inspectionStateControls.preferences>): void {
        this.persistence.transaction(() => {
            this.inspectionsLimit = value.limit;
            this.drillPickRadius = value.drillPickRadius;
            this.inspectionTreeExpandByDefault = value.expandByDefault;
            this.inspectionValueVaryColors = value.varyColors;
            this.inspectionValueVaryOutlines = value.varyOutlines;
            this.inspectionValueVaryStriping = value.varyStriping;
        });
    }

    panelPresentation(panelId: number): ControlValue<typeof inspectionStateControls.panel> {
        const panel = this.selection.find(panel => panel.id === panelId);
        if (!panel) rejectAction("The inspection no longer exists");
        return { locked: panel.locked, undocked: panel.undocked, focused: this.focusedInspectionPanelId === panelId, color: panel.color };
    }

    setPanelPresentation(panelId: number, value: ControlValue<typeof inspectionStateControls.panel>): void {
        this.panelPresentation(panelId);
        if (!value.undocked && !value.locked) rejectAction("Docked inspections are locked", "invalid_arguments");
        this.persistence.transaction(() => {
            this.setInspectionPanelUndockedState(panelId, value.undocked);
            this.setInspectionPanelLockedState(panelId, value.locked);
            this.setInspectionPanelColor(panelId, value.color);
            if (value.focused || this.focusedInspectionPanelId === panelId) this.setFocusedInspectionPanel(value.focused ? panelId : undefined);
        });
    }

    /** Recognizable live panels supply the same guarded arguments accepted by MCP. */
    private closeInspectionCandidates(query: string): AppActionCandidate<ActionInput<typeof inspectionStateActions.closeInspection>>[] {
        return this.selection.flatMap(panel => {
            const title = panel.sourceData?.mapTileKey ?? panel.features.map(feature => feature.featureId).join(", ");
            const name = "Close " + (title || "inspection " + (panel.id + 1));
            if (!name.toLowerCase().includes(query.trim().toLowerCase())) return [];
            const lifetime = this.panelLifetime(panel.id);
            if (lifetime === undefined) return [];
            return [{
                id: "close-inspection:" + panel.id + ":" + lifetime, name,
                label: "Inspection " + (panel.id + 1) + (panel.locked ? " · locked" : ""),
                icon: "pi-times", color: "red", enabled: true, acceptsEmptyInput: true, saveToHistory: false,
                input: { panelId: panel.id, lifetime }
            }];
        });
    }

    /** Retains selections while a datasource is absent/initializing; ready layer lists can retire deleted references. */
    pruneCatalog(presentMaps: ReadonlyMap<string, MapTreeNode>): void {
        this.persistence.transaction(() => {
            const presentLayerIds = new Set<string>(); // entries of form `${mapId}/${layerId}`
            const presentSelectionLayerIds = new Set<string>(); // includes SourceData layers
            const presentMapIds = new Set<string>();
            const mapsWithKnownFeatureLayers = new Set<string>();
            const mapsWithKnownSelectionLayers = new Set<string>();
            for (const [mapId, mapNode] of presentMaps.entries()) {
                presentMapIds.add(mapId);
                // Use feature layers (exclude SourceData) via children
                for (const layer of mapNode.children) {
                    presentLayerIds.add(`${mapId}/${layer.id}`);
                }
                if (mapNode.children.length > 0) {
                    mapsWithKnownFeatureLayers.add(mapId);
                }
                // Selection pruning must keep SourceData inspections too.
                for (const layerId of mapNode.layers.keys()) {
                    presentSelectionLayerIds.add(`${mapId}/${layerId}`);
                }
                if (mapNode.layers.size > 0) {
                    mapsWithKnownSelectionLayers.add(mapId);
                }
            }

            // Keep unresolved selections until the catalog can distinguish missing layers from pending maps.
            const panels = this.selectionState.getValue();
            const nextPanels: InspectionPanelModel<TileFeatureId>[] = [];
            let selectionChanged = false;

            const parseKey = (tileKey: string): { mapId: string; mapLayerId: string } | undefined => {
                let parsed: [string, string, unknown];
                try {
                    parsed = parseMapPartitionKey(coreLib, tileKey);
                } catch {
                    return undefined;
                }
                const [mapId, layerId] = parsed;
                return { mapId, mapLayerId: `${mapId}/${layerId}` };
            };

            const keepFeatureSelection = (tileKey: string): boolean => {
                const parsed = parseKey(tileKey);
                if (!parsed) {
                    return false;
                }
                if (presentLayerIds.has(parsed.mapLayerId)) {
                    return true;
                }
                // Nonblocking datasource startup can transiently publish a map before its layers.
                return !presentMapIds.has(parsed.mapId) || !mapsWithKnownFeatureLayers.has(parsed.mapId);
            };

            const keepSourceDataSelection = (tileKey: string): boolean => {
                const parsed = parseKey(tileKey);
                if (!parsed) {
                    return false;
                }
                if (presentSelectionLayerIds.has(parsed.mapLayerId)) {
                    return true;
                }
                return !presentMapIds.has(parsed.mapId) || !mapsWithKnownSelectionLayers.has(parsed.mapId);
            };

            for (const panel of panels) {
                const updated: InspectionPanelModel<TileFeatureId> = {
                    id: panel.id,
                    features: [],
                    locked: panel.locked,
                    size: panel.size,
                    sourceData: panel.sourceData ? { ...panel.sourceData } : undefined,
                    color: panel.color,
                    undocked: panel.undocked,
                    focused: panel.focused
                };

                // Filter features
                for (const feat of panel.features) {
                    if (keepFeatureSelection(feat.mapTileKey)) {
                        updated.features.push(feat);
                    }
                }

                // Validate sourceData if present
                if (updated.sourceData && !keepSourceDataSelection(updated.sourceData.mapTileKey)) {
                    delete updated.sourceData;
                }

                if (updated.features.length !== panel.features.length ||
                    (panel.sourceData !== undefined && updated.sourceData === undefined)) {
                    selectionChanged = true;
                }

                if (updated.features.length || updated.sourceData) {
                    nextPanels.push(updated);
                } else {
                    selectionChanged = true;
                }
            }

            if (selectionChanged || nextPanels.length !== panels.length) {
                this.selectionState.next(nextPanels);
            }
            this.sanitizeInspectionComparisonForSelection(nextPanels);

        });
    }

}
