import {Injectable} from '@angular/core';

export interface InspectionDialogPosition {
    left: number;
    top: number;
}

export const MAX_INSPECTION_DIALOG_POSITIONS = 25;

interface InspectionDialogSlot {
    panelId: number;
    position: InspectionDialogPosition;
}

@Injectable({providedIn: 'root'})
export class InspectionDialogLayoutService {
    private slots: Array<InspectionDialogSlot | undefined> = new Array(MAX_INSPECTION_DIALOG_POSITIONS);
    private pendingPositions = new Map<number, InspectionDialogPosition>();

    getPosition(index: number, panelId: number): InspectionDialogPosition | undefined {
        const slot = this.slots[this.getSlotIndex(index)];
        if (!slot || slot.panelId !== panelId) {
            return;
        }
        return slot.position;
    }

    setPosition(index: number, panelId: number, position: InspectionDialogPosition) {
        this.slots[this.getSlotIndex(index)] = {panelId, position};
    }

    setPendingPosition(panelId: number, position: InspectionDialogPosition) {
        this.pendingPositions.set(panelId, position);
    }

    consumePendingPosition(panelId: number): InspectionDialogPosition | undefined {
        const position = this.pendingPositions.get(panelId);
        if (position) {
            this.pendingPositions.delete(panelId);
        }
        return position;
    }

    getSlotIndex(index: number): number {
        const normalized = index % MAX_INSPECTION_DIALOG_POSITIONS;
        return normalized < 0 ? normalized + MAX_INSPECTION_DIALOG_POSITIONS : normalized;
    }
}
