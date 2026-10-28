/**
 * Identity, filter-plan and event values shared by styled-layer presentations.
 * Rendering and search consumers can name these values independently of the
 * presentation object that opens and retires the underlying tile subscription.
 */
import type { FilterChannelDefinition } from "./filter-subscription.model";
import type { FilterTileState } from "./filter-tile-state.model";
import type { MapTileStreamFilterStatusPayload } from "./map-tile-stream.protocol";
export type PresentationKind =
    | "regular"
    | "search"
    | "hover"
    | "selection"
    | "hover-details";

export interface StyledMapgetLayerIdentity {
    viewIndex: number;
    mapId: string;
    layerId: string;
    presentationKind: PresentationKind;
    presentationInstanceId: string;
}

export interface StyleFilterPlanIssue {
    ruleIndex: number;
    message: string;
}

export interface StyleFilterPlan {
    valid: boolean;
    channels: FilterChannelDefinition[];
    issues: StyleFilterPlanIssue[];
}

export type StyledMapgetLayerEvent =
    | {type: "tile-ready"; state: FilterTileState}
    | {type: "tiles-pending"; states: readonly FilterTileState[]}
    | {type: "tiles-removed"; states: readonly FilterTileState[]}
    | {type: "generation"; generation: number}
    | {type: "status"; status: MapTileStreamFilterStatusPayload}
    | {type: "error"; message: string};
