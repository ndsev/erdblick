import {Injectable} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {Cartesian3} from "cesium";

@Injectable({providedIn: 'root'})
export class ViewService {

    // TODO: Refactor away
    viewportToBeUpdated: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

    osmEnabled: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(true);
    osmOpacityValue: BehaviorSubject<number> = new BehaviorSubject<number>(30);
    cameraViewData: BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}> =
        new BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}>({
            destination: Cartesian3.fromDegrees(22.837473, 38.490817, 16000000),
            orientation: {
                heading: 6.0,
                pitch: -1.55,
                roll: 0.25,
            }
        });

    setView(destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}) {
        this.cameraViewData.next({
            destination: destination,
            orientation: orientation
        });
    }

    collectCameraOrientation() {
        return this.cameraViewData.getValue().orientation;
    }

    collectCameraPosition() {
        return this.cameraViewData.getValue().destination;
    }
}