import {Injectable} from "@angular/core";
import {
    AppConfigService,
    type ExternalViewerConfig
} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";

/** A validated WGS84 point used by external map viewers. */
export interface ExternalViewerLocation {
    lat: number;
    lon: number;
}

/** Describes where an omnibox external-viewer location came from. */
export interface ResolvedExternalViewerLocation extends ExternalViewerLocation {
    source: "input" | "marker" | "viewport";
}

/** One external map viewer exposed by search and the map context menu. */
export type ExternalViewerProvider = ExternalViewerConfig;

/** Returns whether a point is finite and inside the WGS84 latitude/longitude domain. */
function isValidExternalViewerLocation(location: ExternalViewerLocation): boolean {
    return Number.isFinite(location.lat)
        && Number.isFinite(location.lon)
        && location.lat >= -90
        && location.lat <= 90
        && location.lon >= -180
        && location.lon <= 180;
}

@Injectable({providedIn: "root"})
/** Owns configured external-viewer URLs and the omnibox marker/viewport fallback policy. */
export class ExternalViewerService {
    constructor(
        private readonly stateService: AppStateService,
        private readonly configService: AppConfigService
    ) {}

    /** Returns the current ordered configuration shared by every external-viewer UI. */
    get providers(): readonly ExternalViewerProvider[] {
        return this.configService.snapshot.externalViewers;
    }

    /** Resolves an explicit point or falls back to the active marker and focused viewport centre. */
    resolveLocation(explicit?: ExternalViewerLocation): ResolvedExternalViewerLocation {
        if (explicit) {
            return {...explicit, source: "input"};
        }
        const marker = this.stateService.markedPosition;
        const markerLocation = {lon: marker[0], lat: marker[1]};
        if (this.stateService.marker && marker.length >= 2 && isValidExternalViewerLocation(markerLocation)) {
            return {...markerLocation, source: "marker"};
        }
        const destination = this.stateService.cameraViewDataState
            .getValue(this.stateService.focusedView)
            .destination;
        return {lon: destination.lon, lat: destination.lat, source: "viewport"};
    }

    /** Opens one provider at the supplied WGS84 point in a separate browser tab. */
    open(provider: ExternalViewerProvider, location: ExternalViewerLocation): void {
        if (!isValidExternalViewerLocation(location)) {
            return;
        }
        const href = provider.urlTemplate
            .replaceAll("{lat}", String(location.lat))
            .replaceAll("{lon}", String(location.lon));
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return;
        }
        window.open(url.toString(), "_blank", "noopener");
    }
}
