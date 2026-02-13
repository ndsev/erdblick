import {SceneMode} from "../../integrations/cesium";
import {DeckMapView} from "./deck-view";

export class DeckMapView3D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE3D;
    protected readonly allowPitchAndBearing = true;
}
