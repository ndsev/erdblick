import { Injectable } from "@angular/core";
import { BehaviorSubject, skip } from "rxjs";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";
import { ControlValue } from "../actions/app-action";
import { AppActionContributor } from "../actions/app-action-contributor";
import { AppConfigService } from "../config/app-config.service";
import { Cartographic, GeoMath } from "../integrations/geo";
import { AppStateService } from "../state/app-state.service";
import { CoordinatesStore } from "./coordinates.store";

@Injectable({ providedIn: 'root' })
/**
 * Shared coordinate event service for hover/click coordinates and optional
 * plugin-provided auxiliary coordinate systems.
 */
export class CoordinatesService implements AppActionContributor {

    /** Enables or disables the explicit location marker overlay. */
    setMarkerState(enabled: boolean) {
        this.stateService.transaction(() => {
            this.store.markerState.next(enabled);
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
            this.store.markedPosition = [longitude, latitude, position.height];
        } else {
            this.store.markedPosition = [];
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
        private configService: AppConfigService,
        public readonly store: CoordinatesStore) {
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

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: ActionRegistry): void {
        actions.registerControl(coordinateControls.marker, {
            read: () => this.store.markerControlValue,
            write: (_selector, value) => this.setMarker(value)
        });
    }

    /** Position and visibility are one marker edit for both UI and external controls. */
    setMarker(value: ControlValue<typeof coordinateControls.marker>): void {
        this.stateService.transaction(() => {
            this.setMarkerPosition(value.position ? Cartographic.fromDegrees(value.position.lon, value.position.lat, value.position.alt) : null);
            this.setMarkerState(value.enabled);
        });
    }

}


/** CoordinatesService exposes marker position and visibility as one coherent assignment. */
export const coordinateControls = {
    marker: {
        name: "app.marker",
        description: "Coordinate marker visibility and WGS84 position.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            enabled: z.boolean(),
            position: z.strictObject({
                lon: z.number().min(-180).max(180),
                lat: z.number().min(-90).max(90),
                alt: z.number()
            }).nullable()
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "url-and-local-storage"
    }
} as const;
