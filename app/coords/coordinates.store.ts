/**
 * Marker position, marker visibility and the coordinate formats selected by the
 * user. The URL and storage codecs live beside the values they encode. Moving
 * a camera or changing the live map marker remains in CoordinatesService.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { Boolish } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";
import { roundCoordinateStateValue } from "./coordinates-state.model";

@Injectable({ providedIn: "root" })
export class CoordinatesStore {
    constructor(private readonly persistence: AppStateService) { }

    readonly markerState = this.persistence.registerState<boolean>({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false
    });

    readonly markedPositionState = this.persistence.registerState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(3),
        toStorage: (value: number[]) => value.map(v => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map(v => roundCoordinateStateValue(v)),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false
    });

    readonly enabledCoordsTileIdsState = this.persistence.registerState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        schema: z.array(z.string())
    });

    get marker() { return this.markerState.getValue(); }

    set marker(val: boolean) { this.markerState.next(val); }

    get markedPosition() { return this.markedPositionState.getValue(); }

    set markedPosition(val: number[]) { this.markedPositionState.next(val.map(v => roundCoordinateStateValue(v))); }

    get enabledCoordsTileIds() { return this.enabledCoordsTileIdsState.getValue(); }

    set enabledCoordsTileIds(val: string[]) { this.enabledCoordsTileIdsState.next(val); }

    get markerControlValue() {
        return {
            enabled: this.marker, position: this.markedPosition.length >= 2
                ? { lon: this.markedPosition[0], lat: this.markedPosition[1], alt: this.markedPosition[2] ?? 0 } : null
        };
    }
}
