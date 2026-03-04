import {SceneMode} from "../../integrations/geo";
import {DeckMapView} from "./deck-view";

export class DeckMapView3D extends DeckMapView {
    protected readonly sceneMode = SceneMode.SCENE3D;
    protected readonly allowPitchAndBearing = true;
}
