import {Injectable} from "@angular/core";
import {Cartesian3, Entity, Viewer} from "./cesium";
import {ParametersService} from "./parameters.service";
import {Subject, Subscription} from "rxjs";
import {MenuItem} from "primeng/api";

export interface ViewState {
    openStreetMapLayerAlpha: number;
    openStreetMapLayerShow: boolean;
    markerPositions: Cartesian3[];
    tileOutlineEntity: Entity | null;
    cameraState: any;
    menuItems: MenuItem[];
}

@Injectable({providedIn: 'root'})
export class ViewStateService {
    // TODO - refactoring:
    //   1. There should be a ViewerWrapper - a proper class encapsulating a viewer: Viewer with a getter
    //      which initialises a viewer from the encapsulating object's constraints and parameters if the viewer is null.
    //   2. All of the constraints and all of the coupled states of each viewer should be stored
    //      in its encapsulating object.
    //   3. It should be possible to operate more than one viewer / encapsulating object simultaneously, therefore,
    //      all concerns should be separated and encapsulated as much as possible.
    //   4. The syntactic overhead has to be minimised where possible.
    //   5. ViewerWrapper should provide a unique viewerId: string.
    is2DMode: boolean;
    isChangingMode = false;
    isDestroyingViewer = false;
    viewer!: Viewer;
    isViewerInit: Subject<boolean> = new Subject<boolean>();
    tileOutlineEntity: Entity | null = null;

    // State to preserve during viewer reinitialization
    viewerState: ViewState | null = null;

    constructor(private parameterService: ParametersService) {
        this.is2DMode = this.parameterService.parameters.getValue().mode2d;
    }

    isAvailable() {
        return !!this.viewer && !!this.viewer.scene;
    }

    isUnavailable() {
        return !this.viewer || !this.viewer.scene || !this.viewer.camera;
    }

    isNotDestroyed() {
        return typeof this.viewer.isDestroyed === 'function' && !this.viewer.isDestroyed();
    }

    isDestroyed() {
        return typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed();
    }
}
