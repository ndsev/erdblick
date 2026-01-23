import {Injectable} from '@angular/core';

export interface InspectionDialogPosition {
    left: number;
    top: number;
}

@Injectable({providedIn: 'root'})
export class InspectionDialogLayoutService {
    private positions: InspectionDialogPosition[] = [];

    getPosition(index: number): InspectionDialogPosition | undefined {
        return this.positions[index];
    }

    setPosition(index: number, position: InspectionDialogPosition) {
        this.positions[index] = position;
    }
}
