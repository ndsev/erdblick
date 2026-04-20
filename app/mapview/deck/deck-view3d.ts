import {SceneMode} from "../../integrations/geo";
import {DeckMapView} from "./deck-view";

/** Deck-backed map view configured for perspective 3D rendering with pitch and bearing enabled. */
export class DeckMapView3D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE3D;
    protected readonly allowPitchAndBearing = true;
}
