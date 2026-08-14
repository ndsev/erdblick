import type {TileFeatureId} from "../../shared/appstate.service";
import type {DeckInteractionEffect} from "./deck-interaction-effect";

/** One view-owned interaction material applied to exact scene-local targets. */
export interface TileSubsetInteractionOverlay {
    id: string;
    targets: readonly TileFeatureId[];
    effect: DeckInteractionEffect;
    order: number;
}
