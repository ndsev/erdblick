import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {DEFAULT_EM_HEIGHT, DEFAULT_EM_WIDTH} from "../shared/app-layout.model";
import {Boolish} from "../shared/app-state";
import {AppStateOptions, deepCopy} from "../shared/state-value";
import {
    DEFAULT_DRILL_PICK_RADIUS,
    DEFAULT_HOVER_LABEL_FIELDS,
    HoverLabelFieldConfig,
    InspectionComparisonModel,
    InspectionPanelModel,
    MAX_DRILL_PICK_RADIUS,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MIN_DRILL_PICK_RADIUS,
    TileFeatureId
} from "./inspection-state.model";

export interface InspectionStateServiceValues {
    selection: InspectionPanelModel<TileFeatureId>[];
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
                const color = colorToken.length > 0 && !colorToken.startsWith("#") ? `#${colorToken}` : colorToken;
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
    } satisfies AppStateOptions<InspectionStateServiceValues["selection"]>,

    inspectionsLimit: {
        name: "inspectionsLimitState",
        defaultValue: Math.floor(MAX_SIMULTANEOUS_INSPECTIONS / 2),
        schema: z.coerce.number().int().min(1).max(MAX_SIMULTANEOUS_INSPECTIONS)
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionsLimit"]>,

    drillPickRadius: {
        name: "drillPickRadius",
        defaultValue: DEFAULT_DRILL_PICK_RADIUS,
        schema: z.coerce.number().int().min(MIN_DRILL_PICK_RADIUS).max(MAX_DRILL_PICK_RADIUS)
    } satisfies AppStateOptions<InspectionStateServiceValues["drillPickRadius"]>,

    inspectionTreeExpandByDefault: {
        name: "inspectionTreeExpandByDefault",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionTreeExpandByDefault"]>,

    sourceDataInspectionDefaultColumns: {
        name: "sourceDataInspectionDefaultColumns",
        defaultValue: [],
        schema: z.array(z.enum(["displayAddress", "schemaType"]))
    } satisfies AppStateOptions<InspectionStateServiceValues["sourceDataInspectionDefaultColumns"]>,

    inspectionTreeHiddenColumns: {
        name: "inspectionTreeHiddenColumns",
        defaultValue: {},
        schema: z.record(z.string(), z.array(z.string())),
        snapshotPersist: false
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionTreeHiddenColumns"]>,

    inspectionValueVaryColors: {
        name: "inspectionValueVaryColors",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionValueVaryColors"]>,

    inspectionValueVaryOutlines: {
        name: "inspectionValueVaryOutlines",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionValueVaryOutlines"]>,

    inspectionValueVaryStriping: {
        name: "inspectionValueVaryStriping",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionValueVaryStriping"]>,

    hoverLabelsEnabled: {
        name: "hoverLabelsEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<InspectionStateServiceValues["hoverLabelsEnabled"]>,

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
    } satisfies AppStateOptions<InspectionStateServiceValues["hoverLabelFields"]>,

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
    } satisfies AppStateOptions<InspectionStateServiceValues["inspectionComparison"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withInspectionState() {
    return signalStoreFeature(
        withState(() => {
            const initial: InspectionStateServiceValues = {
                selection: deepCopy(ownerState.selection.defaultValue),
                inspectionsLimit: deepCopy(ownerState.inspectionsLimit.defaultValue),
                drillPickRadius: deepCopy(ownerState.drillPickRadius.defaultValue),
                inspectionTreeExpandByDefault: deepCopy(ownerState.inspectionTreeExpandByDefault.defaultValue),
                sourceDataInspectionDefaultColumns: deepCopy(
                    ownerState.sourceDataInspectionDefaultColumns.defaultValue
                ),
                inspectionTreeHiddenColumns: deepCopy(ownerState.inspectionTreeHiddenColumns.defaultValue),
                inspectionValueVaryColors: deepCopy(ownerState.inspectionValueVaryColors.defaultValue),
                inspectionValueVaryOutlines: deepCopy(ownerState.inspectionValueVaryOutlines.defaultValue),
                inspectionValueVaryStriping: deepCopy(ownerState.inspectionValueVaryStriping.defaultValue),
                hoverLabelsEnabled: deepCopy(ownerState.hoverLabelsEnabled.defaultValue),
                hoverLabelFields: deepCopy(ownerState.hoverLabelFields.defaultValue),
                inspectionComparison: deepCopy(ownerState.inspectionComparison.defaultValue)
            };
            return {inspection: initial};
        })
    );
}
