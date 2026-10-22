/**
 * Saved inspection panels, selected feature references and display preferences.
 * URL decoding and normalization operate on plain panel descriptions here.
 * InspectionPanelService owns panel workflows; InspectionSelectionService
 * loads the referenced features and builds their live inspection content.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { DEFAULT_EM_HEIGHT, DEFAULT_EM_WIDTH } from "../layout/app-layout";
import { Boolish } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";
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
} from "./inspection-state";

@Injectable({ providedIn: "root" })
export class InspectionModel {
    constructor(private readonly persistence: AppStateService) {}

    /** Returns the default inspection panel size. */
    get defaultInspectionPanelSize(): [number, number] {
        return [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];
    }

    // 2~0f~features:map:layer:tile~featureid~layertype:map:layer:tile~featureid~layertype:map:layer:tile~featureid~245:56
    // 1~0~sourcedata:map:layer:tile~address~...features...~size
    // 0~1~...
    readonly selectionState = this.persistence.registerState<InspectionPanelModel<TileFeatureId>[]>({
        name: "selected",
        normalize: (panels) => {
            const next = structuredClone(panels);
            this.sanitizeFocusedInspectionPanel(next);
            return next;
        },
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
                        : this.defaultInspectionPanelSize;

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
    });

    readonly inspectionsLimitState = this.persistence.registerState<number>({
        name: "inspectionsLimitState",
        defaultValue: Math.floor(MAX_SIMULTANEOUS_INSPECTIONS / 2),
        schema: z.coerce.number().int().min(1).max(MAX_SIMULTANEOUS_INSPECTIONS)
    });

    readonly drillPickRadiusState = this.persistence.registerState<number>({
        name: "drillPickRadius",
        defaultValue: DEFAULT_DRILL_PICK_RADIUS,
        schema: z.coerce.number().int().min(MIN_DRILL_PICK_RADIUS).max(MAX_DRILL_PICK_RADIUS)
    });

    readonly inspectionTreeExpandByDefaultState = this.persistence.registerState<boolean>({
        name: "inspectionTreeExpandByDefault",
        defaultValue: false,
        schema: Boolish
    });

    readonly sourceDataInspectionDefaultColumnsState = this.persistence.registerState<string[]>({
        name: "sourceDataInspectionDefaultColumns",
        defaultValue: [],
        schema: z.array(z.enum(["displayAddress", "schemaType"]))
    });

    readonly inspectionTreeHiddenColumnsState = this.persistence.registerState<Record<string, string[]>>({
        name: "inspectionTreeHiddenColumns",
        defaultValue: {},
        schema: z.record(z.string(), z.array(z.string())),
        snapshotPersist: false
    });

    readonly inspectionValueVaryColorsState = this.persistence.registerState<boolean>({
        name: "inspectionValueVaryColors",
        defaultValue: true,
        schema: Boolish
    });

    readonly inspectionValueVaryOutlinesState = this.persistence.registerState<boolean>({
        name: "inspectionValueVaryOutlines",
        defaultValue: false,
        schema: Boolish
    });

    readonly inspectionValueVaryStripingState = this.persistence.registerState<boolean>({
        name: "inspectionValueVaryStriping",
        defaultValue: false,
        schema: Boolish
    });

    readonly hoverLabelsEnabledState = this.persistence.registerState<boolean>({
        name: "hoverLabelsEnabled",
        defaultValue: true,
        schema: Boolish
    });

    readonly hoverLabelFieldsState = this.persistence.registerState<HoverLabelFieldConfig[]>({
        name: "hoverLabelFields",
        defaultValue: DEFAULT_HOVER_LABEL_FIELDS.map((field) => ({ ...field })),
        schema: z.array(
            z.object({
                expression: z.string(),
                customExpression: Boolish,
                displayKey: z.string().optional()
            })
        )
    });

    readonly inspectionComparisonState = this.persistence.registerState<InspectionComparisonModel | null>({
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
    });

    get selection() {
        return this.selectionState.getValue();
    }

    set selection(val: InspectionPanelModel<TileFeatureId>[]) {
        this.selectionState.next(val);
    }

    get inspectionsLimit() {
        return this.inspectionsLimitState.getValue();
    }

    set inspectionsLimit(val: number) {
        const numeric = Number(val);
        if (!Number.isFinite(numeric)) {
            return;
        }
        const normalized = Math.min(MAX_SIMULTANEOUS_INSPECTIONS, Math.max(1, Math.trunc(numeric)));
        this.inspectionsLimitState.next(normalized);
    }

    get drillPickRadius() {
        return this.drillPickRadiusState.getValue();
    }

    set drillPickRadius(val: number) {
        const numeric = Number(val);
        if (!Number.isFinite(numeric)) {
            return;
        }
        const normalized = Math.min(
            MAX_DRILL_PICK_RADIUS,
            Math.max(MIN_DRILL_PICK_RADIUS, Math.trunc(numeric))
        );
        this.drillPickRadiusState.next(normalized);
    }

    get inspectionComparison() {
        return this.inspectionComparisonState.getValue();
    }

    set inspectionComparison(val: InspectionComparisonModel | null) {
        this.inspectionComparisonState.next(val);
    }

    get inspectionTreeExpandByDefault() {
        return this.inspectionTreeExpandByDefaultState.getValue();
    }

    set inspectionTreeExpandByDefault(val: boolean) {
        this.inspectionTreeExpandByDefaultState.next(!!val);
    }

    get sourceDataInspectionDefaultColumns() {
        return this.sourceDataInspectionDefaultColumnsState.getValue();
    }

    set sourceDataInspectionDefaultColumns(val: string[]) {
        const allowed = new Set(["displayAddress", "schemaType"]);
        this.sourceDataInspectionDefaultColumnsState.next([
            ...new Set(val.filter((column) => allowed.has(column)))
        ]);
    }

    get inspectionValueVaryColors() {
        return this.inspectionValueVaryColorsState.getValue();
    }

    set inspectionValueVaryColors(val: boolean) {
        this.inspectionValueVaryColorsState.next(!!val);
    }

    get inspectionValueVaryOutlines() {
        return this.inspectionValueVaryOutlinesState.getValue();
    }

    set inspectionValueVaryOutlines(val: boolean) {
        this.inspectionValueVaryOutlinesState.next(!!val);
    }

    get inspectionValueVaryStriping() {
        return this.inspectionValueVaryStripingState.getValue();
    }

    set inspectionValueVaryStriping(val: boolean) {
        this.inspectionValueVaryStripingState.next(!!val);
    }

    get hoverLabelsEnabled() {
        return this.hoverLabelsEnabledState.getValue();
    }

    set hoverLabelsEnabled(val: boolean) {
        this.hoverLabelsEnabledState.next(!!val);
    }

    get hoverLabelFields() {
        return this.hoverLabelFieldsState.getValue();
    }

    set hoverLabelFields(val: HoverLabelFieldConfig[]) {
        this.hoverLabelFieldsState.next(val.map((field) => ({ ...field })));
    }

    /** Keeps the focused inspection panel id aligned with the current selection set. */
    sanitizeFocusedInspectionPanel(panels: InspectionPanelModel<TileFeatureId>[]): void {
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
            const fallbackPanel = panels.find((panel) => panel.id === fallbackId);
            if (fallbackPanel) {
                fallbackPanel.focused = true;
            }
        }
    }
}
