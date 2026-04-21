import {SceneMode} from "../../integrations/geo";
import {DeckMapView} from "./deck-view";

/** Deck-backed map view configured for orthographic 2D rendering without pitch or bearing. */
export class DeckMapView2D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE2D;
    protected readonly allowPitchAndBearing = false;
    protected override readonly useOrthographicProjection: boolean = true;
}
