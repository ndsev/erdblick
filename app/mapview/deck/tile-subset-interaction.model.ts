/**
 * Semantic interaction targets and effect values for a rendered subset.
 * Visualizations publish these values to the per-view mask controller without
 * owning its textures or rendering passes.
 */
import type { TileFeatureId } from "../../inspection/inspection.model";
import type { DeckInteractionEffect } from "./deck-interaction-effect.util";

/** Style-order boundary separating ordinary presentation from transient interaction rules. */
export const INTERACTION_STYLE_ORDER_BASE = 2_000;

/** One view-owned interaction material applied to exact scene-local targets. */
export interface TileSubsetInteractionOverlay {
    id: string;
    targets: readonly TileFeatureId[];
    effect: DeckInteractionEffect;
    order: number;
}
