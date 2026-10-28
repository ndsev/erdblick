/**
 * The planar Deck controller selected for a map view component.
 * Its behavior is shared with DeckMapView; this specialization selects the
 * scene mode rather than duplicating navigation or resource ownership.
 */
import {SceneMode} from "../../integrations/geo.adapter";
import {DeckMapView} from "./deck-view.controller";

/** Deck-backed map view configured for orthographic 2D rendering without pitch or bearing. */
export class DeckMapView2D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE2D;
    protected readonly allowPitchAndBearing = false;
    protected override readonly useOrthographicProjection: boolean = true;
}
