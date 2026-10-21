import {inject, Injectable} from "@angular/core";
import {z} from "zod";
import {rejectAction} from "../actions/action-utils";
import {ActionDeclaration, AppActionService} from "../actions/app-action.service";
import type {SearchTarget} from "../actions/omnibar";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {AppConfigService, type ExternalViewerConfig} from "../shared/app-config.service";
import {CoordinateJumpService} from "./coordinate-jump.service";

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
    return (
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lon) &&
        location.lat >= -90 &&
        location.lat <= 90 &&
        location.lon >= -180 &&
        location.lon <= 180
    );
}

@Injectable({providedIn: "root"})
/** Owns configured external-viewer URLs and the omnibox marker/viewport fallback policy. */
export class ExternalViewerService {
    static readonly actions = {
        open: {
            name: "omnibar_external_viewer",
            description: "Open a currently configured external viewer at a validated location.",
            mutation: true,
            exposure: "omnibar",
            inputSchema: z
                .object({
                    providerId: z.string().min(1),
                    location: z
                        .object({
                            lat: z.number().min(-90).max(90),
                            lon: z.number().min(-180).max(180)
                        })
                        .strict()
                })
                .strict(),
            outputSchema: z.void()
        }
    } as const satisfies Record<string, ActionDeclaration>;
    private readonly actions = inject(AppActionService);
    readonly viewStateOwner = inject(MapViewStateService);
    private readonly coordinates = inject(CoordinateJumpService);
    constructor(private readonly configService: AppConfigService) {
        this.actions.registerAction(ExternalViewerService.actions.open, ({providerId, location}) => {
            const provider = this.providers.find((current) => current.id === providerId);
            if (!provider) rejectAction("External viewer is no longer configured", "not_available");
            this.open(provider, location);
        });
        this.actions.registerOmnibar(
            "external-viewers",
            (query) => {
                const location = this.externalViewerLocation(query);
                return this.providers.map((provider) => this.externalViewerTarget(provider, location));
            },
            40
        );
    }

    /** Returns the current ordered configuration shared by every external-viewer UI. */
    get providers(): readonly ExternalViewerProvider[] {
        return this.configService.snapshot.externalViewers;
    }

    /** Resolves an explicit point or falls back to the active marker and focused viewport centre. */
    resolveLocation(explicit?: ExternalViewerLocation): ResolvedExternalViewerLocation {
        if (explicit) {
            return {...explicit, source: "input"};
        }
        const marker = this.viewStateOwner.markedPosition;
        const markerLocation = {lon: marker[0], lat: marker[1]};
        if (this.viewStateOwner.marker && marker.length >= 2 && isValidExternalViewerLocation(markerLocation)) {
            return {...markerLocation, source: "marker"};
        }
        const destination = this.viewStateOwner.cameraViewDataState.getValue(
            this.viewStateOwner.focusedView
        ).destination;
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

    /** Builds one omnibox action for a configured external map viewer. */
    private externalViewerTarget(
        provider: ExternalViewerProvider,
        location: ResolvedExternalViewerLocation | undefined
    ): SearchTarget {
        return this.actions.candidate(ExternalViewerService.actions.open, {
            id: provider.id,
            icon: "pi-map-marker",
            color: "green",
            name: provider.name,
            label: location
                ? this.externalViewerLabel(location)
                : `lat = ? | lon = ?<br><span class="search-option-warning">Invalid coordinates</span>`,
            enabled: location !== undefined,
            acceptsEmptyInput: true,
            saveToHistory: (input: string) => this.explicitExternalViewerLocation(input) !== undefined,
            arguments: (input: string) => {
                const resolved = this.externalViewerLocation(input);
                if (!resolved) rejectAction("Invalid external-viewer coordinates", "invalid_arguments");
                return {providerId: provider.id, location: {lat: resolved.lat, lon: resolved.lon}};
            },
            isCurrent: () => this.providers.includes(provider),
            validate: (input: string) => this.externalViewerLocation(input) !== undefined
        });
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
        const parsed = this.coordinates.parseWgs84Coordinates(value, false);
        if (!parsed || !this.coordinates.validateWGS84(value, false)) {
            return undefined;
        }
        return {lat: parsed.markerPosition[0], lon: parsed.markerPosition[1]};
    }

    /** Distinguishes malformed two-coordinate input from ordinary search text. */
    private looksLikeCoordinateInput(value: string): boolean {
        return (value.match(/-?\d+(?:\.\d+)?/g) ?? []).length >= 2;
    }
}
