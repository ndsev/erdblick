import type {TileFeatureId} from "../../shared/appstate.service";
import type {DeckInteractionEffect} from "./deck-interaction-effect";

/** Style-order boundary separating ordinary presentation from transient interaction rules. */
export const INTERACTION_STYLE_ORDER_BASE = 2_000;

/** One view-owned interaction material applied to exact scene-local targets. */
export interface TileSubsetInteractionOverlay {
    id: string;
    targets: readonly TileFeatureId[];
    effect: DeckInteractionEffect;
    order: number;
}
