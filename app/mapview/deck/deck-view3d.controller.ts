/**
 * The spatial Deck controller selected for a map view component.
 * Its behavior is shared with DeckMapView; this specialization selects the
 * scene mode rather than duplicating navigation or resource ownership.
 */
import {SceneMode} from "../../integrations/geo.adapter";
import {DeckMapView} from "./deck-view.controller";

/** Deck-backed map view configured for perspective 3D rendering with pitch and bearing enabled. */
export class DeckMapView3D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE3D;
    protected readonly allowPitchAndBearing = true;
}
