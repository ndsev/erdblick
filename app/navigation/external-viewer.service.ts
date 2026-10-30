import { Injectable } from "@angular/core";
import { z } from "zod";
import { applied, rejectAction } from "../action/action.model";
import { AppActionContributor, AppActionRegistration } from "../action/action-contributor.model";
import { AppConfigService } from "../config/appconfig.service";
import type { ExternalViewerConfig } from "./external-viewer.model";
import { CoordinatesState } from "../coordinates/coordinates.state";
import { parseWgs84CoordinateString } from "../coordinates/wgs84-coordinate.util";
import { MapViewState } from "../mapview/mapview.state";
import { boundedUnicodeString } from "../utils/unicode-string.util";

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

@Injectable({ providedIn: "root" })
/** Owns configured external-viewer URLs and the omnibox marker/viewport fallback policy. */
export class ExternalViewerService implements AppActionContributor {
    constructor(
        private readonly configService: AppConfigService,
        public readonly coordinates: CoordinatesState,
        public readonly viewSettings: MapViewState
    ) { }

    /** Returns the current ordered configuration shared by every external-viewer UI. */
    get providers(): readonly ExternalViewerProvider[] {
        return this.configService.snapshot.externalViewers;
    }

    /** Resolves an explicit point or falls back to the active marker and focused viewport centre. */
    resolveLocation(explicit?: ExternalViewerLocation): ResolvedExternalViewerLocation {
        if (explicit) {
            return { ...explicit, source: "input" };
        }
        const marker = this.coordinates.markedPosition;
        const markerLocation = { lon: marker[0], lat: marker[1] };
        if (this.coordinates.marker && marker.length >= 2 && isValidExternalViewerLocation(markerLocation)) {
            return { ...markerLocation, source: "marker" };
        }
        const destination = this.viewSettings.cameraViewDataState
            .getValue(this.viewSettings.focusedView)
            .destination;
        return { lon: destination.lon, lat: destination.lat, source: "viewport" };
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

    /** Formats the coordinate and fallback source shown below an external-viewer action. */
    private externalViewerLabel(location: ResolvedExternalViewerLocation): string {
        const sourceLabels = {
            input: "search input",
            marker: "current marker",
            viewport: "viewport centre"
        } as const;
        return `lat = ${location.lat} | lon = ${location.lon} | ${sourceLabels[location.source]}`;
    }

    /** Resolves valid explicit coordinates or applies the shared marker/viewport fallback. */
    private externalViewerLocation(value: string): ResolvedExternalViewerLocation | undefined {
        const explicit = this.explicitExternalViewerLocation(value);
        if (explicit) {
            return this.resolveLocation(explicit);
        }
        if (this.looksLikeCoordinateInput(value)) {
            return undefined;
        }
        return this.resolveLocation();
    }

    /** Returns a valid explicit latitude/longitude input without applying fallback behavior. */
    private explicitExternalViewerLocation(value: string): ExternalViewerLocation | undefined {
        const parsed = parseWgs84CoordinateString(value, false);
        if (!parsed) {
            return undefined;
        }
        return { lat: parsed.lat, lon: parsed.lon };
    }

    /** Distinguishes malformed two-coordinate input from ordinary search text. */
    private looksLikeCoordinateInput(value: string): boolean {
        return (value.match(/-?\d+(?:\.\d+)?/g) ?? []).length >= 2;
    }
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: AppActionRegistration): void {
        actions.registerAction(
            {
                name: "open_external_viewer",
                exposure: "omnibar",
                mutation: true,
                description:
                    "Open a configured external viewer at input coordinates, the marker or focused map centre.",
                inputSchema: z.strictObject({
                    providerId: boundedUnicodeString(4096, true),
                    text: boundedUnicodeString(4096)
                }),
                outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
            },
            (input) => {
                const provider = this.providers.find((provider) => provider.id === input.providerId);
                const location = this.externalViewerLocation(input.text);
                if (!provider || !location)
                    rejectAction("The external viewer or location is no longer available");
                this.open(provider, location);
                return applied();
            },
            (query) => {
                const location = this.externalViewerLocation(query);
                return this.providers.map((provider) => ({
                    id: provider.id,
                    name: provider.name,
                    icon: "pi-map-marker",
                    color: "green",
                    label: location
                        ? this.externalViewerLabel(location)
                        : 'lat = ? | lon = ?<br><span class="omnibar-option-warning">Invalid coordinates</span>',
                    enabled: location !== undefined,
                    acceptsEmptyInput: true,
                    saveToHistory: this.explicitExternalViewerLocation(query) !== undefined,
                    input: { providerId: provider.id, text: query }
                }));
            }
        );
    }


}
