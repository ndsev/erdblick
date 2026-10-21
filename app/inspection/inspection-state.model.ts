import type { AppDialogLayout } from "../shared/app-layout.model";

export const MAX_SIMULTANEOUS_INSPECTIONS = 50;

export const DEFAULT_DRILL_PICK_RADIUS = 3;

export const MIN_DRILL_PICK_RADIUS = 1;

export const MAX_DRILL_PICK_RADIUS = 10;

export const MAX_COMPARE_PANELS = 4;

export const DEFAULT_HIGHLIGHT_COLORS = [
    "#fff314",
    "#4ad6d6",
    "#8f52ff",
    "#ff1212",
    "#3474ff",
    "#ff04d6",
    "#ffa600",
    "#b3ff99",
    "#ccefff",
    "#58cf08"
]

/** Canonical frontend selection identity for one feature inside one map tile. */
export interface TileFeatureId {
    featureId: string;
    mapTileKey: string;
}

/** One ordered SIMFIL field shown in the map feature-hover popover. */
export interface HoverLabelFieldConfig {
    expression: string;
    customExpression: boolean;
    /** Optional short key shown next to the value; the expression leaf is used when absent. */
    displayKey?: string;
}

/** Derives the concise key used for a hover field when no override was configured. */
export function defaultHoverLabelFieldKey(expression: string): string {
    const trimmed = expression.trim();
    const leaf = trimmed.split(".").filter(segment => segment.length).at(-1);
    return leaf ?? trimmed;
}

/** Initial hover overlay preserves the previous feature-id-only behavior. */
export const DEFAULT_HOVER_LABEL_FIELDS: HoverLabelFieldConfig[] = [{
    expression: "id",
    customExpression: false
}];

/** Selection payload used for source-data/meta-data rows that are not regular features. */
export interface SelectedSourceData {
    mapTileKey: string;
    address?: bigint;
}

/** Runtime model for one inspection panel, docked or floating. */
export interface InspectionPanelModel<FeatureRepresentation> {
    id: number;
    features: FeatureRepresentation[];
    locked: boolean;
    focused?: boolean;
    size: [number, number];
    sourceData?: SelectedSourceData;
    color: string;
    undocked: boolean;
    /** Runtime-only marker used while feature identities are resolving into inspectable wrappers. */
    loading?: boolean;
}

/** Transient expansion state for one mounted inspection tree. */
export type InspectionTreeExpansionSnapshot = Map<string, boolean | undefined>;

/** Transient inspection-tree UI state kept while moving panels between docked and floating hosts. */
export interface InspectionTreeExpansionState {
    expandedNodes: InspectionTreeExpansionSnapshot;
    fullExpansionActive: boolean;
    expansionSnapshotBeforeFullExpand?: InspectionTreeExpansionSnapshot;
    fullCollapseActive: boolean;
    expansionSnapshotBeforeFullCollapse?: InspectionTreeExpansionSnapshot;
}

/** Persisted layout for floating inspection dialogs, including dock preference. */
export interface InspectionDialogLayout extends AppDialogLayout {
    panelId: number;
    slot: number;
}

/** One selectable comparison candidate for the inspection comparison dialog. */
export interface InspectionComparisonEntry {
    panelId: number;
    mapId: string;
    label: string;
    featureIds: TileFeatureId[];
}

/** Complete model for the inspection comparison dialog. */
export interface InspectionComparisonModel {
    base: InspectionComparisonEntry;
    others: InspectionComparisonEntry[];
}

/** Command-style option that can populate an inspection comparison slot. */
export interface InspectionComparisonOption {
    label: string;
    value: number;
}
