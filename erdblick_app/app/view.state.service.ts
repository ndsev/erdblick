import {Injectable} from "@angular/core";
import {Cartesian3, Entity, Viewer} from "./cesium";
import {ParametersService} from "./parameters.service";
import {Subject} from "rxjs";
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
    is2DMode: boolean;
    isChangingMode = false;
    isDestroyingViewer = false;
    viewer!: Viewer;
    isViewerInit: Subject<boolean> = new Subject<boolean>();

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