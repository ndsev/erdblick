import {colorSchema, indexSchema} from "../actions/action-schema";
import {boundedUnicodeString} from "../shared/unicode-string";
import {patchAppState, StateWriteOrigin, transient, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, type, withComputed, withMethods, withProps} from "@ngrx/signals";
import {z} from "zod";
import {computed, inject, Injector} from "@angular/core";
import {action} from "../actions/action";
import {control} from "../actions/control";
import {rejectAction} from "../actions/action-utils";
import type {ActionSuggestion} from "../actions/omnibar";
import type {FeatureWrapper} from "../mapdata/feature-inspection.model";
import type {AppLayoutValues} from "../shared/app-layout.store-feature";
import {InfoMessageService} from "../shared/info.service";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {DEFAULT_HIGHLIGHT_COLORS} from "./inspection-state.model";
import {
    AppDialogLayout,
    AppDialogPosition,
    AppDialogSize,
    DEFAULT_DOCKED_EM_HEIGHT,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    INSPECTION_DOCK_TAB_ID
} from "../shared/app-layout.model";
import {Boolish} from "../shared/state-value";
import {AppStateOptions, deepCopy, deepEquals} from "../shared/state-value";
import {
    DEFAULT_DRILL_PICK_RADIUS,
    DEFAULT_HOVER_LABEL_FIELDS,
    HoverLabelFieldConfig,
    InspectionComparisonModel,
    InspectionPanelModel,
    MAX_DRILL_PICK_RADIUS,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MIN_DRILL_PICK_RADIUS,
    TileFeatureId,
    InspectionTreeExpansionState,
    InspectionDialogLayout,
    SelectedSourceData,
    InspectionComparisonOption,
    InspectionComparisonEntry,
    MAX_COMPARE_PANELS
} from "./inspection-state.model";

const tabSelectorSchema = z.strictObject({});
const inspectionPreferencesSchema = z.strictObject({
    limit: z.number().int().min(1).max(50),
    drillPickRadius: z.number().int().min(1).max(10),
    expandByDefault: z.boolean(),
    varyColors: z.boolean(),
    varyOutlines: z.boolean(),
    varyStriping: z.boolean()
});
const hoverPreferencesSchema = z.strictObject({
    enabled: z.boolean(),
    fields: z
        .array(
            z.strictObject({
                expression: boundedUnicodeString(4096, true),
                customExpression: z.boolean(),
                displayKey: boundedUnicodeString(128).optional()
            })
        )
        .max(32)
});
const panelSchema = z.strictObject({
    locked: z.boolean(),
    undocked: z.boolean(),
    focused: z.boolean(),
    color: colorSchema
});

export const inspectionStateControls = {
    preferences: {
        name: "app.preferences.inspection",
        description: "Inspection limits and value presentation preferences.",
        selectorSchema: tabSelectorSchema,
        valueSchema: inspectionPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    },
    hover: {
        name: "app.preferences.hover",
        description: "Configured hover values and optional display labels.",
        selectorSchema: tabSelectorSchema,
        valueSchema: hoverPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    },
    panel: {
        name: "inspection.panel",
        description: "One existing inspection panel's presentation; closing is a lifecycle command.",
        selectorSchema: z.strictObject({panelId: indexSchema}),
        valueSchema: panelSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    }
} as const;

export interface InspectionValues {
    selection: InspectionPanelModel<TileFeatureId>[];
    panelGenerations: Record<string, number>;
    nextGeneration: number;
    pushUrlRevision: number;
    treeExpansion: Map<number, InspectionTreeExpansionState>;
    inspectionsLimit: number;
    drillPickRadius: number;
    inspectionTreeExpandByDefault: boolean;
    sourceDataInspectionDefaultColumns: string[];
    inspectionTreeHiddenColumns: Record<string, string[]>;
    inspectionValueVaryColors: boolean;
    inspectionValueVaryOutlines: boolean;
    inspectionValueVaryStriping: boolean;
    hoverLabelsEnabled: boolean;
    hoverLabelFields: HoverLabelFieldConfig[];
    inspectionComparison: InspectionComparisonModel | null;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    selection: {
        name: "selected",
        defaultValue: [],
        schema: z.array(z.string()),
        toStorage: (value: InspectionPanelModel<TileFeatureId>[]) => {
            return value.map((state) => {
                let s = `${state.id}~${state.locked ? 1 : 0}${state.focused ? "f" : ""}~`;
                if (state.sourceData) {
                    s += `${state.sourceData.mapTileKey}~${state.sourceData.address ?? ""}~`;
                }
                s += `${state.features.map((id) => `${id.mapTileKey}~${id.featureId}`).join("~")}~`;
                // Remove # character from hex color
                const color = state.color.startsWith("#") ? state.color.slice(1) : state.color;
                s += `${state.size[0]}:${state.size[1]}~${color}~${state.undocked ? 1 : 0}`;
                return s;
            });
        },
        fromStorage: (payload: any): InspectionPanelModel<TileFeatureId>[] => {
            const result: InspectionPanelModel<TileFeatureId>[] = [];
            if (!payload || !payload.length) {
                return result;
            }
            for (const panelStateStr of payload) {
                const parts: string[] = panelStateStr.split("~");
                if (parts.length < 7) {
                    continue;
                }
                const id = Number(parts.shift()!);
                const panelFlags = parts.shift()!;
                const lockState = panelFlags.startsWith("1");
                const focused = panelFlags.includes("f");
                const undocked = parts.pop()! === "1";
                const colorToken = parts.pop()!;
                const color =
                    colorToken.length > 0 && !colorToken.startsWith("#") ? `#${colorToken}` : colorToken;
                const sizeToken = parts.pop()!;
                const sizeParts = sizeToken.split(":");
                const size =
                    sizeParts.length === 2
                        ? [Number(sizeParts[0]), Number(sizeParts[1])]
                        : [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];

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
                    });
                }

                result.push(newPanelState);
            }
            return result;
        },
        urlParamName: "sel",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<InspectionValues["selection"]>,

    inspectionsLimit: {
        name: "inspectionsLimitState",
        defaultValue: Math.floor(MAX_SIMULTANEOUS_INSPECTIONS / 2),
        schema: z.coerce.number().int().min(1).max(MAX_SIMULTANEOUS_INSPECTIONS)
    } satisfies AppStateOptions<InspectionValues["inspectionsLimit"]>,

    drillPickRadius: {
        name: "drillPickRadius",
        defaultValue: DEFAULT_DRILL_PICK_RADIUS,
        schema: z.coerce.number().int().min(MIN_DRILL_PICK_RADIUS).max(MAX_DRILL_PICK_RADIUS)
    } satisfies AppStateOptions<InspectionValues["drillPickRadius"]>,

    inspectionTreeExpandByDefault: {
        name: "inspectionTreeExpandByDefault",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionValues["inspectionTreeExpandByDefault"]>,

    sourceDataInspectionDefaultColumns: {
        name: "sourceDataInspectionDefaultColumns",
        defaultValue: [],
        schema: z.array(z.enum(["displayAddress", "schemaType"]))
    } satisfies AppStateOptions<InspectionValues["sourceDataInspectionDefaultColumns"]>,

    inspectionTreeHiddenColumns: {
        name: "inspectionTreeHiddenColumns",
        defaultValue: {},
        schema: z.record(z.string(), z.array(z.string())),
        snapshotPersist: false
    } satisfies AppStateOptions<InspectionValues["inspectionTreeHiddenColumns"]>,

    inspectionValueVaryColors: {
        name: "inspectionValueVaryColors",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<InspectionValues["inspectionValueVaryColors"]>,

    inspectionValueVaryOutlines: {
        name: "inspectionValueVaryOutlines",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionValues["inspectionValueVaryOutlines"]>,

    inspectionValueVaryStriping: {
        name: "inspectionValueVaryStriping",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionValues["inspectionValueVaryStriping"]>,

    hoverLabelsEnabled: {
        name: "hoverLabelsEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<InspectionValues["hoverLabelsEnabled"]>,

    hoverLabelFields: {
        name: "hoverLabelFields",
        defaultValue: DEFAULT_HOVER_LABEL_FIELDS.map((field) => ({...field})),
        schema: z.array(
            z.object({
                expression: z.string(),
                customExpression: Boolish,
                displayKey: z.string().optional()
            })
        )
    } satisfies AppStateOptions<InspectionValues["hoverLabelFields"]>,

    inspectionComparison: {
        name: "inspectionComparisonState",
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.object({
                base: z.object({
                    panelId: z.coerce.number(),
                    mapId: z.string().optional().default(""),
                    label: z.string(),
                    featureIds: z.array(
                        z.object({
                            featureId: z.string(),
                            mapTileKey: z.string()
                        })
                    )
                }),
                others: z.array(
                    z.object({
                        panelId: z.coerce.number(),
                        mapId: z.string().optional().default(""),
                        label: z.string(),
                        featureIds: z.array(
                            z.object({
                                featureId: z.string(),
                                mapTileKey: z.string()
                            })
                        )
                    })
                )
            })
        ])
    } satisfies AppStateOptions<InspectionValues["inspectionComparison"]>
};

type InspectionRoot = {inspection: InspectionValues; layout: AppLayoutValues};
type Panel = InspectionPanelModel<TileFeatureId>;

/** Keep one focused panel and retain unchanged references for native signal readers. */
function focusPanels(panels: Panel[], requested?: number): Panel[] {
    const focused =
        requested !== undefined && panels.some((panel) => panel.id === requested)
            ? requested
            : panels.at(-1)?.id;
    const next = panels.map((panel) => {
        if (!!panel.focused === (panel.id === focused)) {
            return panel;
        }
        const next = {...panel};
        if (panel.id === focused) {
            next.focused = true;
        } else {
            delete next.focused;
        }
        return next;
    });
    return next.every((panel, index) => panel === panels[index]) ? panels : next;
}

/**
 * Prepare the dependent state when inspection membership changes. This replaces
 * AppState's beforeCommit hooks: closing a panel calculates its focus, comparison,
 * column overrides, floating geometry and dock visibility before any observer runs.
 * Imports use the same cleanup without inferring that an empty dock should close:
 * users can open the empty dock deliberately. Only a semantic removal supplies
 * its previous selection, allowing the last removed docked panel to collapse it.
 */
export function normalizeInspections<State extends InspectionRoot>(
    state: State,
    previousSelection?: readonly Panel[]
): State {
    const original = state.inspection;
    const selection = focusPanels(original.selection, original.selection.find((panel) => panel.focused)?.id);
    const ids = new Set(selection.map((panel) => panel.id));
    let nextGeneration = original.nextGeneration;
    const panelGenerations = Object.fromEntries(
        selection.map((panel) => [panel.id, original.panelGenerations[panel.id] ?? ++nextGeneration])
    );
    const eligible = new Set(
        selection.filter((panel) => !panel.sourceData && panel.features.length).map((panel) => panel.id)
    );
    const comparison = original.inspectionComparison;
    const entries = comparison
        ? [comparison.base, ...comparison.others].filter((entry) => eligible.has(entry.panelId))
        : [];
    const inspectionComparison = entries.length ? {base: entries[0], others: entries.slice(1)} : null;
    const keepLayout = (id: string) =>
        !id.startsWith("inspection:") || ids.has(Number(id.slice("inspection:".length)));
    const dialogLayouts = Object.fromEntries(
        Object.entries(state.layout.dialogLayouts).filter(([id]) => keepLayout(id))
    );
    const hasDockedPanels = selection.some((panel) => !panel.undocked);
    const otherDockedSurface = Object.values(dialogLayouts).some(
        (layout) => layout.docked && layout.dockTab === state.layout.dockActiveTab
    );
    const removedLastDockedPanel = previousSelection?.some((panel) => !panel.undocked) && !hasDockedPanels;
    const dockOpen =
        state.layout.dockActiveTab === INSPECTION_DOCK_TAB_ID &&
        removedLastDockedPanel &&
        !otherDockedSurface
            ? false
            : state.layout.dockOpen;
    const preserve = <Value>(current: Value, candidate: Value): Value =>
        deepEquals(current, candidate) ? current : candidate;
    return {
        ...state,
        inspection: {
            ...original,
            selection,
            panelGenerations: preserve(original.panelGenerations, panelGenerations),
            nextGeneration,
            inspectionComparison: preserve(original.inspectionComparison, inspectionComparison),
            treeExpansion: preserve(
                original.treeExpansion,
                new Map([...original.treeExpansion].filter(([id]) => ids.has(id)))
            ),
            inspectionTreeHiddenColumns: preserve(
                original.inspectionTreeHiddenColumns,
                Object.fromEntries(
                    Object.entries(original.inspectionTreeHiddenColumns).filter(([id]) => ids.has(Number(id)))
                )
            )
        },
        layout: {
            ...state.layout,
            dockOpen,
            dialogLayouts: preserve(state.layout.dialogLayouts, dialogLayouts),
            pendingOpenDialogs: preserve(
                state.layout.pendingOpenDialogs,
                state.layout.pendingOpenDialogs.filter(keepLayout)
            )
        }
    };
}

function comparisonEntry(panel: InspectionPanelModel<FeatureWrapper>): InspectionComparisonEntry {
    return {
        panelId: panel.id,
        mapId: panel.features[0]?.featureTile.mapName ?? "",
        label: panel.features
            .map((feature) => `${feature.featureTile.mapName}.${feature.featureId}`)
            .join(", "),
        featureIds: panel.features.map((feature) => ({
            mapTileKey: feature.mapTileKey,
            featureId: feature.featureId
        }))
    };
}

/**
 * Calculate the visible selection without publishing intermediate panels. A normal
 * feature click reuses the latest unlocked feature panel; pinned and source-data
 * panels survive. A repeated click focuses the existing feature rather than
 * duplicating it. Grouped inspections reuse this calculation before one final patch.
 */
export function prepareInspectionSelection(
    state: InspectionRoot,
    newSelection: TileFeatureId[] | SelectedSourceData,
    id?: number,
    forceNewPanel = false,
    createUndockedFeaturePanel = false,
    presentation: Partial<Pick<Panel, "locked" | "color">> = {}
): {state: InspectionRoot; panelId?: number; warning?: string} {
    let panels = state.inspection.selection.map((panel) => ({...panel}));
    const origin = id === undefined ? undefined : panels.find((panel) => panel.id === id);
    const sourceData = Array.isArray(newSelection) ? undefined : newSelection;
    let features = Array.isArray(newSelection) ? newSelection : [];
    const duplicate = panels.find(
        (panel) =>
            !panel.sourceData &&
            panel.features.some((existing) =>
                features.some(
                    (feature) =>
                        feature.featureId === existing.featureId && feature.mapTileKey === existing.mapTileKey
                )
            )
    );
    let layout = state.layout;
    if (!sourceData && id === undefined && features.length && !createUndockedFeaturePanel) {
        layout = {...layout, dockOpen: true};
    }
    if (features.length && !forceNewPanel) {
        features = features.filter(
            (feature) =>
                !panels.some(
                    (panel) =>
                        !panel.sourceData &&
                        panel.features.some(
                            (other) =>
                                feature.featureId === other.featureId &&
                                feature.mapTileKey === other.mapTileKey
                        )
                )
        );
        if (!features.length && !(origin?.sourceData && sourceData === undefined)) {
            if (duplicate && !duplicate.undocked && !createUndockedFeaturePanel) {
                layout = {...layout, dockOpen: true, dockActiveTab: INSPECTION_DOCK_TAB_ID};
            }
            return {
                state: normalizeInspections({
                    ...state,
                    inspection: {...state.inspection, selection: focusPanels(panels, duplicate?.id)},
                    layout
                })
            };
        }
    }
    let target =
        !forceNewPanel &&
        origin &&
        ((sourceData && origin.sourceData) || (!sourceData && !origin.sourceData && !origin.locked))
            ? origin.id
            : undefined;
    let create = forceNewPanel;
    if (!create && target === undefined) {
        if (!sourceData && id === undefined) {
            const reusable = panels.findLast(
                (panel) =>
                    !panel.sourceData && !panel.locked && (!createUndockedFeaturePanel || panel.undocked)
            );
            if (reusable) {
                target = reusable.id;
                if (!createUndockedFeaturePanel) {
                    panels = panels.filter(
                        (panel) => panel.sourceData || panel.locked || panel.id === target
                    );
                }
            } else {
                create = true;
            }
        } else {
            const matches = (panel: Panel) => !panel.locked && !!sourceData === !!panel.sourceData;
            target = (
                panels.find((panel) => !panel.undocked && matches(panel)) ??
                panels.find((panel) => panel.undocked && matches(panel))
            )?.id;
            create = target === undefined;
        }
    }
    if (create) {
        const limit = state.inspection.inspectionsLimit;
        if (panels.length >= limit) {
            return {
                state,
                warning: `Maximum of ${limit} inspections reached. Close an existing inspection to add more.`
            };
        }
        target = 1 + Math.max(-1, ...panels.map((panel) => panel.id));
        const undocked = !!sourceData || createUndockedFeaturePanel;
        panels.push({
            id: target,
            features: sourceData ? [] : features,
            sourceData,
            locked: false,
            size: [DEFAULT_EM_WIDTH, undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT],
            color: DEFAULT_HIGHLIGHT_COLORS[target % DEFAULT_HIGHLIGHT_COLORS.length],
            undocked
        });
    } else if (target !== undefined) {
        panels = panels.map((panel) =>
            panel.id !== target
                ? panel
                : {
                      ...panel,
                      sourceData,
                      features: sourceData ? [] : features.length ? features : panel.features
                  }
        );
    }
    if (target === undefined) {
        return {state};
    }
    if (!panels.find((panel) => panel.id === target)!.undocked && !sourceData) {
        layout = {...layout, dockOpen: true, dockActiveTab: INSPECTION_DOCK_TAB_ID};
    }
    panels = panels.map((panel) => (panel.id === target ? {...panel, ...presentation} : panel));
    return {
        state: normalizeInspections({
            ...state,
            inspection: {...state.inspection, selection: focusPanels(panels, target)},
            layout
        }),
        panelId: target
    };
}

/** Inspection values and their complete semantic edits; loaded feature models remain resource-owned. */
export function withInspectionState() {
    return signalStoreFeature(
        {state: type<{layout: AppLayoutValues}>()},
        withPersistedState<"inspection", InspectionValues>("inspection", {
            ...ownerState,
            panelGenerations: transient({}),
            nextGeneration: transient(0),
            pushUrlRevision: transient(0),
            treeExpansion: transient(new Map())
        }),
        withComputed((store) => ({
            focusedInspectionPanelId: computed(
                () => store.inspection.selection().find((panel) => panel.focused)?.id
            )
        })),
        withProps(() => ({
            defaultInspectionPanelSize: [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT] as [number, number]
        })),
        withMethods((store) => {
            const injector = inject(Injector);
            // Closing/replacing a selection must prune all dependent state. A
            // preference-only edit must retain runtime selection references, so
            // it neither rebuilds loading shells nor clears a comparison in flight.
            function publish(
                inspection: InspectionValues,
                layout: AppLayoutValues = store.layout(),
                origin: StateWriteOrigin = "user"
            ) {
                const next =
                    inspection.selection === store.inspection.selection()
                        ? {inspection, layout}
                        : normalizeInspections({inspection, layout}, store.inspection.selection());
                patchAppState(store, next, origin);
            }
            function setInspectionValue<Key extends keyof InspectionValues>(
                key: Key,
                value: InspectionValues[Key]
            ) {
                let normalized: InspectionValues[Key] = value;
                if (key === "inspectionsLimit" || key === "drillPickRadius") {
                    const number = Number(value);
                    if (!Number.isFinite(number)) {
                        return;
                    }
                    const minimum = key === "inspectionsLimit" ? 1 : MIN_DRILL_PICK_RADIUS;
                    const maximum =
                        key === "inspectionsLimit" ? MAX_SIMULTANEOUS_INSPECTIONS : MAX_DRILL_PICK_RADIUS;
                    normalized = Math.min(
                        maximum,
                        Math.max(minimum, Math.trunc(number))
                    ) as InspectionValues[Key];
                }
                publish({...store.inspection(), [key]: normalized});
            }
            function setSelectionValue(selection: Panel[], layout = store.layout()) {
                publish({...store.inspection(), selection}, layout);
            }
            function setFocusedInspectionPanel(id?: number) {
                setSelectionValue(focusPanels(store.inspection.selection(), id));
            }
            function updatePanel(id: number, changes: Partial<Panel>, focus = false) {
                const current = store.inspection.selection();
                if (!current.some((panel) => panel.id === id)) {
                    return;
                }
                let panels = current.map((panel) => (panel.id === id ? {...panel, ...changes} : panel));
                if (focus) {
                    panels = focusPanels(panels, id);
                }
                const layout =
                    changes.undocked === false
                        ? {...store.layout(), dockOpen: true, dockActiveTab: INSPECTION_DOCK_TAB_ID}
                        : store.layout();
                setSelectionValue(panels, layout);
            }
            function unsetPanel(id: number) {
                setSelectionValue(store.inspection.selection().filter((panel) => panel.id !== id));
            }
            function panelPresentation(id: number) {
                const panel = store.inspection.selection().find((panel) => panel.id === id);
                if (!panel) {
                    rejectAction("The inspection no longer exists");
                }
                return {
                    locked: panel.locked,
                    undocked: panel.undocked,
                    focused: !!panel.focused,
                    color: panel.color
                };
            }
            function inspectionPreferences() {
                const values = store.inspection();
                return {
                    limit: values.inspectionsLimit,
                    drillPickRadius: values.drillPickRadius,
                    expandByDefault: values.inspectionTreeExpandByDefault,
                    varyColors: values.inspectionValueVaryColors,
                    varyOutlines: values.inspectionValueVaryOutlines,
                    varyStriping: values.inspectionValueVaryStriping
                };
            }
            function getInspectionDialogLayout(panelId: number): InspectionDialogLayout | undefined {
                const layout = store.layout.dialogLayouts()[`inspection:${panelId}`];
                return layout && "panelId" in layout && "slot" in layout
                    ? (layout as InspectionDialogLayout)
                    : undefined;
            }
            return {
                setInspectionsLimit(value: InspectionValues["inspectionsLimit"]): void {
                    setInspectionValue("inspectionsLimit", value);
                },
                setDrillPickRadius(value: InspectionValues["drillPickRadius"]): void {
                    setInspectionValue("drillPickRadius", value);
                },
                setInspectionTreeExpandByDefault(
                    value: InspectionValues["inspectionTreeExpandByDefault"]
                ): void {
                    setInspectionValue("inspectionTreeExpandByDefault", value);
                },
                setSourceDataInspectionDefaultColumns(
                    value: InspectionValues["sourceDataInspectionDefaultColumns"]
                ): void {
                    setInspectionValue("sourceDataInspectionDefaultColumns", value);
                },
                setInspectionValueVaryColors(value: InspectionValues["inspectionValueVaryColors"]): void {
                    setInspectionValue("inspectionValueVaryColors", value);
                },
                setInspectionValueVaryOutlines(value: InspectionValues["inspectionValueVaryOutlines"]): void {
                    setInspectionValue("inspectionValueVaryOutlines", value);
                },
                setInspectionValueVaryStriping(value: InspectionValues["inspectionValueVaryStriping"]): void {
                    setInspectionValue("inspectionValueVaryStriping", value);
                },
                setHoverLabelsEnabled(value: InspectionValues["hoverLabelsEnabled"]): void {
                    setInspectionValue("hoverLabelsEnabled", value);
                },
                setHoverLabelFields(value: InspectionValues["hoverLabelFields"]): void {
                    setInspectionValue("hoverLabelFields", value);
                },
                setInspectionComparison(value: InspectionValues["inspectionComparison"]): void {
                    setInspectionValue("inspectionComparison", value);
                },
                /** Collapse after an empty/failed load only if this is still the same selection revision. */
                completeInspectionLoading(
                    expected: readonly Panel[],
                    visiblePanelIds: readonly number[]
                ): void {
                    if (store.inspection.selection() !== expected || !store.layout.dockAutoCollapse()) {
                        return;
                    }
                    const visible = new Set(visiblePanelIds);
                    const hasInspection = expected.some((panel) => !panel.undocked && visible.has(panel.id));
                    const hasSurface = Object.values(store.layout.dialogLayouts()).some(
                        (layout) => layout.docked
                    );
                    if (!hasInspection && !hasSurface) {
                        patchAppState(store, {layout: {...store.layout(), dockOpen: false}});
                    }
                },
                setSelectionValue,
                setFocusedInspectionPanel,
                unsetPanel,
                panelPresentation,
                inspectionPreferences,
                getInspectionDialogLayout,
                /** Capture the logical lifetime so an awaited command cannot target a reused panel number. */
                captureInspectionPanel(panelId: number) {
                    const generation = store.inspection.panelGenerations()[panelId];
                    return generation ? {panelId, generation} : undefined;
                },
                isCurrentInspectionPanel(target: {panelId: number; generation: number}) {
                    return store.inspection.panelGenerations()[target.panelId] === target.generation;
                },
                /** Select features and reveal their final panel/dock state as one history step. */
                setSelection(
                    newSelection: TileFeatureId[] | SelectedSourceData,
                    id?: number,
                    forceNewPanel = false,
                    createUndockedFeaturePanel = false,
                    presentation: Partial<Pick<Panel, "locked" | "color">> = {}
                ): number | undefined {
                    const result = prepareInspectionSelection(
                        {inspection: store.inspection(), layout: store.layout()},
                        newSelection,
                        id,
                        forceNewPanel,
                        createUndockedFeaturePanel,
                        presentation
                    );
                    if (result.warning) {
                        injector.get(InfoMessageService).showWarning(result.warning);
                    }
                    // A feature click creates a browser Back step. Keep that
                    // intent in this patch; persistence observes it synchronously.
                    patchAppState(store, {
                        ...result.state,
                        inspection: {
                            ...result.state.inspection,
                            pushUrlRevision: store.inspection.pushUrlRevision() + 1
                        }
                    });
                    return result.panelId;
                },
                /** Prepare grouped selection, pinning and color before any native subscriber runs. */
                applyInspectionFeatures(
                    features: TileFeatureId[],
                    options: {panelId?: number; newPanel?: boolean; lock?: boolean; color?: string} = {}
                ) {
                    let next: InspectionRoot = {inspection: store.inspection(), layout: store.layout()};
                    let panelId: number | undefined;
                    const contains = (feature: TileFeatureId) =>
                        next.inspection.selection.some(
                            (panel) =>
                                !panel.sourceData &&
                                panel.features.some(
                                    (candidate) =>
                                        candidate.mapTileKey === feature.mapTileKey &&
                                        candidate.featureId === feature.featureId
                                )
                        );
                    const presentation = {
                        ...(options.lock ? {locked: true} : {}),
                        ...(options.color !== undefined ? {color: options.color} : {})
                    };
                    if (options.panelId !== undefined || options.newPanel) {
                        const result = prepareInspectionSelection(
                            next,
                            features,
                            options.panelId,
                            !!options.newPanel,
                            false,
                            presentation
                        );
                        next = result.state;
                        panelId = result.panelId;
                        if (result.warning) {
                            injector.get(InfoMessageService).showWarning(result.warning);
                        }
                    } else if (features.length === 1) {
                        const feature = features[0];
                        if (
                            contains(feature) ||
                            next.inspection.selection.some((panel) => !panel.sourceData && !panel.locked) ||
                            next.inspection.selection.length < next.inspection.inspectionsLimit
                        ) {
                            next = prepareInspectionSelection(
                                next,
                                [feature],
                                undefined,
                                !!options.lock,
                                false,
                                presentation
                            ).state;
                        }
                    } else if (features.length) {
                        next = normalizeInspections({
                            ...next,
                            inspection: {
                                ...next.inspection,
                                selection: next.inspection.selection.filter(
                                    (panel) => panel.locked || panel.sourceData
                                )
                            }
                        });
                        for (const feature of features) {
                            if (contains(feature)) {
                                continue;
                            }
                            if (next.inspection.selection.length >= next.inspection.inspectionsLimit) {
                                break;
                            }
                            next = prepareInspectionSelection(
                                next,
                                [feature],
                                undefined,
                                true,
                                false,
                                presentation
                            ).state;
                        }
                    }
                    const matches = (panel: Panel) =>
                        !panel.sourceData &&
                        (!options.newPanel || panel.id === panelId) &&
                        panel.features.some((candidate) =>
                            features.some(
                                (feature) =>
                                    candidate.mapTileKey === feature.mapTileKey &&
                                    candidate.featureId === feature.featureId
                            )
                        );
                    next = {
                        ...next,
                        inspection: {
                            ...next.inspection,
                            selection: next.inspection.selection.map((panel) =>
                                matches(panel) ? {...panel, ...presentation} : panel
                            )
                        }
                    };
                    patchAppState(
                        store,
                        normalizeInspections(
                            {
                                ...next,
                                inspection: {
                                    ...next.inspection,
                                    pushUrlRevision: store.inspection.pushUrlRevision() + 1
                                }
                            },
                            store.inspection.selection()
                        )
                    );
                    return next.inspection.selection.filter(matches);
                },
                toggleInspectionFeatureHighlight(
                    panelId: number,
                    mapTileKey: string,
                    targetFeatureId: string
                ) {
                    const panel = store.inspection
                        .selection()
                        .find((panel) => panel.id === panelId && !panel.sourceData);
                    if (!panel) {
                        return;
                    }
                    const base = stripFeatureInspectionTarget(targetFeatureId);
                    const features = panel.features.map((feature) =>
                        feature.mapTileKey === mapTileKey &&
                        stripFeatureInspectionTarget(feature.featureId) === base
                            ? {
                                  ...feature,
                                  featureId: feature.featureId === targetFeatureId ? base : targetFeatureId
                              }
                            : feature
                    );
                    const panels = focusPanels(
                        store.inspection
                            .selection()
                            .map((value) => (value.id === panelId ? {...value, features} : value)),
                        panelId
                    );
                    setSelectionValue(
                        panels,
                        panel.undocked
                            ? store.layout()
                            : {...store.layout(), dockOpen: true, dockActiveTab: INSPECTION_DOCK_TAB_ID}
                    );
                },
                setInspectionPanelSize(id: number, size: [number, number]) {
                    updatePanel(id, {size});
                },
                setInspectionPanelLockedState(id: number, locked: boolean) {
                    updatePanel(id, {locked});
                },
                setInspectionPanelColor(id: number, color: string) {
                    updatePanel(id, {color});
                },
                setInspectionPanelUndockedState(id: number, undocked: boolean) {
                    const panel = store.inspection.selection().find((panel) => panel.id === id);
                    if (!panel) {
                        return;
                    }
                    updatePanel(
                        id,
                        {
                            undocked,
                            locked: undocked ? panel.locked : true,
                            size: [panel.size[0], undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT]
                        },
                        true
                    );
                },
                isInspectionPanelFocused(id: number) {
                    return store.focusedInspectionPanelId() === id;
                },
                setInspectionTreeExpansionState(id: number, value: InspectionTreeExpansionState) {
                    const treeExpansion = new Map(store.inspection.treeExpansion());
                    treeExpansion.set(id, deepCopy(value));
                    setInspectionValue("treeExpansion", treeExpansion);
                },
                getInspectionTreeExpansionState(id: number) {
                    const value = store.inspection.treeExpansion().get(id);
                    return value ? deepCopy(value) : undefined;
                },
                setInspectionTreeHiddenColumns(id: number, columns: Iterable<string>) {
                    setInspectionValue("inspectionTreeHiddenColumns", {
                        ...store.inspection.inspectionTreeHiddenColumns(),
                        [id]: [...new Set(columns)]
                    });
                },
                getInspectionTreeHiddenColumns(id: number) {
                    const value = store.inspection.inspectionTreeHiddenColumns()[id];
                    return value ? [...value] : undefined;
                },
                ensureInspectionDialogLayout(
                    panelId: number,
                    slot: number,
                    factory: () => AppDialogLayout
                ): InspectionDialogLayout {
                    const current = getInspectionDialogLayout(panelId);
                    if (current) {
                        return current;
                    }
                    const fallback = factory();
                    const created = {
                        panelId,
                        slot,
                        position: {...fallback.position},
                        size: {...fallback.size}
                    };
                    patchAppState(store, {
                        layout: {
                            ...store.layout(),
                            dialogLayouts: {
                                ...store.layout.dialogLayouts(),
                                [`inspection:${panelId}`]: created
                            }
                        }
                    });
                    return created;
                },
                setInspectionDialogPosition(
                    panelId: number,
                    position: AppDialogPosition,
                    preferredIndex?: number,
                    fallbackSize: AppDialogSize = {
                        width: DEFAULT_EM_WIDTH * 16,
                        height: DEFAULT_EM_HEIGHT * 16
                    }
                ) {
                    if (!store.inspection.selection().some((panel) => panel.id === panelId)) {
                        return;
                    }
                    const current = getInspectionDialogLayout(panelId);
                    const layout = {
                        ...current,
                        panelId,
                        slot: current?.slot ?? preferredIndex ?? panelId,
                        position: {...position},
                        size: current?.size ?? {...fallbackSize}
                    };
                    patchAppState(store, {
                        layout: {
                            ...store.layout(),
                            dialogLayouts: {
                                ...store.layout.dialogLayouts(),
                                [`inspection:${panelId}`]: layout
                            }
                        }
                    });
                },
                pruneInspectionDialogLayout(activePanelIds: number[]) {
                    const keep = new Set(activePanelIds.map((id) => `inspection:${id}`));
                    patchAppState(store, {
                        layout: {
                            ...store.layout(),
                            dialogLayouts: Object.fromEntries(
                                Object.entries(store.layout.dialogLayouts()).filter(
                                    ([id]) => !id.startsWith("inspection:") || keep.has(id)
                                )
                            )
                        }
                    });
                },
                openInspectionComparison(model: InspectionComparisonModel) {
                    setInspectionValue("inspectionComparison", model);
                },
                closeInspectionComparison() {
                    setInspectionValue("inspectionComparison", null);
                },
                reconcileComparison(panels: Panel[]) {
                    publish({...store.inspection(), selection: panels});
                },
                reorderInspectionPanels(order: number[]) {
                    const panels = store.inspection.selection();
                    const docked = panels.filter((panel) => !panel.undocked);
                    const byId = new Map(docked.map((panel) => [panel.id, panel]));
                    const ids = [...new Set(order.filter((id) => byId.has(id)))];
                    for (const panel of docked) {
                        if (!ids.includes(panel.id)) {
                            ids.push(panel.id);
                        }
                    }
                    ids.reverse();
                    let index = 0;
                    setSelectionValue(
                        panels.map((panel) => (panel.undocked ? panel : byId.get(ids[index++])!))
                    );
                },
                unsetUnlockedSelections() {
                    setSelectionValue(
                        store.inspection
                            .selection()
                            .filter((panel) => panel.locked || panel.sourceData !== undefined)
                    );
                },
                buildCompareOptions(
                    panels: InspectionPanelModel<FeatureWrapper>[],
                    excludePanelId?: number
                ): InspectionComparisonOption[] {
                    return panels
                        .filter(
                            (panel) =>
                                panel.id !== excludePanelId && !panel.sourceData && panel.features.length
                        )
                        .map((panel) => ({label: comparisonEntry(panel).label, value: panel.id}));
                },
                createComparisonModel(
                    baseId: number,
                    otherIds: number[],
                    panels: InspectionPanelModel<FeatureWrapper>[]
                ): InspectionComparisonModel | null {
                    const byId = new Map(
                        panels
                            .filter((panel) => !panel.sourceData && panel.features.length)
                            .map((panel) => [panel.id, panel])
                    );
                    const base = byId.get(baseId);
                    if (!base) {
                        return null;
                    }
                    return {
                        base: comparisonEntry(base),
                        others: [...new Set(otherIds)]
                            .filter((id) => id !== baseId)
                            .slice(0, MAX_COMPARE_PANELS - 1)
                            .flatMap((id) => {
                                const panel = byId.get(id);
                                return panel ? [comparisonEntry(panel)] : [];
                            })
                    };
                },
                setInspectionPreferences(
                    value: z.infer<typeof inspectionStateControls.preferences.valueSchema>
                ) {
                    const parsed = inspectionStateControls.preferences.valueSchema.parse(value);
                    publish({
                        ...store.inspection(),
                        inspectionsLimit: parsed.limit,
                        drillPickRadius: parsed.drillPickRadius,
                        inspectionTreeExpandByDefault: parsed.expandByDefault,
                        inspectionValueVaryColors: parsed.varyColors,
                        inspectionValueVaryOutlines: parsed.varyOutlines,
                        inspectionValueVaryStriping: parsed.varyStriping
                    });
                },
                setHoverPreferences(value: z.infer<typeof inspectionStateControls.hover.valueSchema>) {
                    const parsed = inspectionStateControls.hover.valueSchema.parse(value);
                    publish({
                        ...store.inspection(),
                        hoverLabelsEnabled: parsed.enabled,
                        hoverLabelFields: parsed.fields
                    });
                },
                setPanelPresentation(
                    panelId: number,
                    value: z.infer<typeof inspectionStateControls.panel.valueSchema>
                ) {
                    panelPresentation(panelId);
                    if (!value.undocked && !value.locked) {
                        rejectAction("Docked inspections are locked", "invalid_arguments");
                    }
                    const panel = store.inspection.selection().find((panel) => panel.id === panelId)!;
                    let selection = store.inspection.selection().map((current) =>
                        current.id === panelId
                            ? {
                                  ...current,
                                  ...value,
                                  size: [
                                      panel.size[0],
                                      value.undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT
                                  ] as [number, number]
                              }
                            : current
                    );
                    if (value.focused || panel.focused) {
                        selection = focusPanels(selection, value.focused ? panelId : undefined);
                    }
                    setSelectionValue(
                        selection,
                        value.undocked
                            ? store.layout()
                            : {...store.layout(), dockOpen: true, dockActiveTab: INSPECTION_DOCK_TAB_ID}
                    );
                },
                closeInspection: action(
                    {
                        name: "viewer_close_inspection",
                        description:
                            "Close one inspection panel, including a pinned panel. Other inspections remain open.",
                        mutation: true,
                        inputSchema: z.strictObject({panelId: z.number().int().nonnegative()}),
                        outputSchema: z.strictObject({status: z.literal("applied"), changed: z.boolean()})
                    },
                    ({panelId}) => {
                        if (!store.inspection.selection().some((panel) => panel.id === panelId)) {
                            rejectAction("The inspection no longer exists", "not_available");
                        }
                        unsetPanel(panelId);
                        return {status: "applied" as const, changed: true};
                    },
                    {
                        suggest: (query) => {
                            if (!/^close\b/i.test(query.trim())) {
                                return [];
                            }
                            const filter = query
                                .trim()
                                .replace(/^close\s*(inspection\s*)?/i, "")
                                .toLowerCase();
                            return store.inspection
                                .selection()
                                .flatMap((panel): ActionSuggestion<{panelId: number}>[] => {
                                    const label = panel.features.length
                                        ? panel.features.map((feature) => feature.featureId).join(", ")
                                        : (panel.sourceData?.mapTileKey ?? `Inspection ${panel.id}`);
                                    if (filter && !label.toLowerCase().includes(filter)) {
                                        return [];
                                    }
                                    const generation = store.inspection.panelGenerations()[panel.id];
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
                                            isCurrent: () =>
                                                store.inspection.panelGenerations()[panel.id] === generation
                                        }
                                    ];
                                });
                        }
                    }
                )
            };
        }),
        withProps((store) => ({
            inspectionPreferencesControl: control(inspectionStateControls.preferences, {
                read: () => store.inspectionPreferences(),
                write: (_, value) => store.setInspectionPreferences(value)
            }),
            hoverPreferencesControl: control(inspectionStateControls.hover, {
                read: () => ({
                    enabled: store.inspection.hoverLabelsEnabled(),
                    fields: store.inspection.hoverLabelFields()
                }),
                write: (_, value) => store.setHoverPreferences(value)
            }),
            inspectionPanelControl: control(inspectionStateControls.panel, {
                read: ({panelId}) => store.panelPresentation(panelId),
                write: ({panelId}, value) => store.setPanelPresentation(panelId, value)
            })
        }))
    );
}
