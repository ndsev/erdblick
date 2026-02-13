import {SceneMode} from "../integrations/cesium";
import {DeckMapView} from "./deck-view";

export class DeckMapView2D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE2D;
    protected readonly allowPitchAndBearing = false;
}

