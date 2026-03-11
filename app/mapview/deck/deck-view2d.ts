import {SceneMode} from "../../integrations/geo";
import {DeckMapView} from "./deck-view";

export class DeckMapView2D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE2D;
    protected readonly allowPitchAndBearing = false;
    protected override readonly useOrthographicProjection: boolean = true;
}
