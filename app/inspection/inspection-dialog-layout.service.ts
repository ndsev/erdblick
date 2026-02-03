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
    private slotByPanelId = new Map<number, number>();

    getPosition(index: number, panelId: number): InspectionDialogPosition | undefined {
        const slot = this.slots[this.getSlotIndexForPanel(index, panelId)];
        if (!slot || slot.panelId !== panelId) {
            return;
        }
        return slot.position;
    }

    setPosition(index: number, panelId: number, position: InspectionDialogPosition) {
        this.slots[this.getSlotIndexForPanel(index, panelId)] = {panelId, position};
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

    syncPanels(panelIds: number[]) {
        const activeIds = new Set(panelIds);
        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i];
            if (slot && !activeIds.has(slot.panelId)) {
                this.slots[i] = undefined;
            }
        }
        for (const panelId of this.slotByPanelId.keys()) {
            if (!activeIds.has(panelId)) {
                this.slotByPanelId.delete(panelId);
            }
        }
    }

    getSlotIndex(index: number): number {
        const normalized = index % MAX_INSPECTION_DIALOG_POSITIONS;
        return normalized < 0 ? normalized + MAX_INSPECTION_DIALOG_POSITIONS : normalized;
    }

    getSlotIndexForPanel(index: number, panelId: number): number {
        const existing = this.slotByPanelId.get(panelId);
        if (existing !== undefined) {
            return existing;
        }
        const startIndex = this.getSlotIndex(index);
        for (let offset = 0; offset < MAX_INSPECTION_DIALOG_POSITIONS; offset++) {
            const candidate = this.getSlotIndex(startIndex + offset);
            const slot = this.slots[candidate];
            if (!slot || slot.panelId === panelId) {
                this.slotByPanelId.set(panelId, candidate);
                return candidate;
            }
        }
        this.slotByPanelId.set(panelId, startIndex);
        return startIndex;
    }
}
