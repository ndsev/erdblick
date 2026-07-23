import {Injectable} from "@angular/core";
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
export interface ExternalViewerProvider {
    id: string;
    name: string;
    buildUrl: (location: ExternalViewerLocation) => string;
}

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
/** Owns external map-viewer URLs and the omnibox marker/viewport fallback policy. */
export class ExternalViewerService {
    readonly providers: readonly ExternalViewerProvider[] = [
        {
            id: "e:gm",
            name: "Open in Google Maps",
            buildUrl: ({lat, lon}) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
        },
        {
            id: "e:google-street-view",
            name: "Open in Google Street View",
            buildUrl: ({lat, lon}) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`
        },
        {
            id: "e:osm",
            name: "Open in OpenStreetMap",
            buildUrl: ({lat, lon}) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
        },
        {
            id: "e:bing-maps",
            name: "Open in Bing Maps",
            buildUrl: ({lat, lon}) => `https://bing.com/maps/default.aspx?cp=${lat}~${lon}&lvl=18&style=r`
        }
    ];

    constructor(private readonly stateService: AppStateService) {}

    /** Resolves an explicit point or falls back to the active marker and focused viewport centre. */
    resolveLocation(explicit?: ExternalViewerLocation): ResolvedExternalViewerLocation {
        if (explicit) {
            return {...explicit, source: "input"};
        }
        const marker = this.stateService.markedPosition;
        const markerLocation = {lon: marker[0], lat: marker[1]};
        if (this.stateService.marker && marker.length === 2 && isValidExternalViewerLocation(markerLocation)) {
            return {...markerLocation, source: "marker"};
        }
        const destination = this.stateService.cameraViewDataState
            .getValue(this.stateService.focusedView)
            .destination;
        return {lon: destination.lon, lat: destination.lat, source: "viewport"};
    }

    /** Opens one provider at the supplied WGS84 point in a separate browser tab. */
    open(provider: ExternalViewerProvider, location: ExternalViewerLocation): void {
        window.open(provider.buildUrl(location), "_blank", "noopener");
    }
}
