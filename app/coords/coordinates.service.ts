import { ControlValue } from "../actions/app-action";
import { AppActionService } from "../actions/app-action.service";
import { coordinateControls } from "./coordinates.service.declarations";

import { Injectable } from "@angular/core";
import { BehaviorSubject, skip } from "rxjs";
import { z } from "zod";
import { Cartographic, GeoMath } from "../integrations/geo";
import { AppConfigService } from "../shared/app-config.service";
import { Boolish } from "../shared/app-state";
import { AppStateService } from "../shared/appstate.service";
import { roundCoordinateStateValue } from "./coordinates-state.model";

@Injectable({ providedIn: 'root' })
/**
 * Shared coordinate event service for hover/click coordinates and optional
 * plugin-provided auxiliary coordinate systems.
 */
export class CoordinatesService {

    readonly markerState = this.stateService.registerState<boolean>({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false
    });

    readonly markedPositionState = this.stateService.registerState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(3),
        toStorage: (value: number[]) => value.map(v => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map(v => roundCoordinateStateValue(v)),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false
    });

    readonly enabledCoordsTileIdsState = this.stateService.registerState<string[]>({
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

    /** Enables or disables the explicit location marker overlay. */
    setMarkerState(enabled: boolean) {
        this.stateService.transaction(() => {
            this.markerState.next(enabled);
            if (!enabled) {
                this.setMarkerPosition(null, false);
            }
        });
    }

    /** Updates the explicit location marker position, optionally delaying URL sync. */
    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = GeoMath.toDegrees(position.longitude);
            const latitude = GeoMath.toDegrees(position.latitude);
            this.markedPosition = [longitude, latitude, position.height];
        } else {
            this.markedPosition = [];
        }
        if (!delayUpdate) {
            this.stateService.requestHistoryEntry();
        }
    }

    mouseMoveCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    mouseClickCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    auxiliaryCoordinatesFun: ((x: number, y: number) => Array<[string, Array<number>]>) | null = null;
    auxiliaryTileIdsFun: ((x: number, y: number, level: number) => Array<[string, bigint | number]>) | null = null;

    constructor(public stateService: AppStateService,
        private configService: AppConfigService) {
        this.mouseClickCoordinates.pipe(
            skip(1)  // Skip the first (null) value from mouseClickCoordinates BehaviorSubject
        ).subscribe(position => {
            this.setMarkerPosition(position);
        });
    }

    /** Loads the configured jump-target module via dynamic import. */
    protected loadJumpTargetsModule(path: string): Promise<any> {
        return import(/* @vite-ignore */ path);
    }

    /** Initializes optional jump-target helpers from the configured extension module. */
    initialize() {
        const jumpTargetsConfig = this.configService.getExtensionModuleId("jumpTargets");
        if (!jumpTargetsConfig) {
            return;
        }

        const jumpTargetsPath = `/static-config/${jumpTargetsConfig}.js`;
        this.loadJumpTargetsModule(jumpTargetsPath).then((plugin) => {
            const { getAuxCoordinates, getAuxTileIds } = plugin;
            if (typeof getAuxCoordinates === "function") {
                this.auxiliaryCoordinatesFun = getAuxCoordinates;
            }
            if (typeof getAuxTileIds === "function") {
                this.auxiliaryTileIdsFun = getAuxTileIds;
            }
        }).catch((error) => {
            console.error(error);
        });
    }

    registerActions(actions: AppActionService): void {
        actions.registerControl(coordinateControls.marker, {
            read: () => this.markerControlValue,
            write: (_selector, value) => this.setMarker(value)
        });
    }

    get markerControlValue(): ControlValue<typeof coordinateControls.marker> {
        return {
            enabled: this.marker, position: this.markedPosition.length >= 2
                ? { lon: this.markedPosition[0], lat: this.markedPosition[1], alt: this.markedPosition[2] ?? 0 } : null
        };
    }

    /** Position and visibility are one marker edit for both UI and external controls. */
    setMarker(value: ControlValue<typeof coordinateControls.marker>): void {
        this.stateService.transaction(() => {
            this.setMarkerPosition(value.position ? Cartographic.fromDegrees(value.position.lon, value.position.lat, value.position.alt) : null);
            this.setMarkerState(value.enabled);
        });
    }

}
