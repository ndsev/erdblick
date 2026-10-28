import { Injectable } from "@angular/core";
import { HighlightMode } from "build/libs/core/erdblick-core";
import { BehaviorSubject, Subject } from "rxjs";
import { z } from "zod";
import { AppActionCandidate, applied, rejectAction } from "../action/action.model";
import { AppActionContributor, AppActionRegistration } from "../action/action-contributor.model";
import { AppConfigService } from "../config/appconfig.service";
import { CoordinatesService } from "../coordinates/coordinates.service";
import {
    packedTileIdFromMortonString,
    packedTileIdFromParsedNdsCoordinates,
    parseMortonCoordinateString,
    parseNdsCoordinateString,
    parsePackedTileId,
    parsePackedTileId as parsePackedTileIdValue
} from "../coordinates/nds-coordinate.util";
import { parseWgs84CoordinateString } from "../coordinates/wgs84-coordinate.util";
import { InspectionPanelService } from "../inspection/inspection-panel.service";
import { InspectionSelectionService } from "../inspection/inspection-selection.service";
import { SelectedSourceData, TileFeatureId } from "../inspection/inspection.model";
import { GeoMath, Rectangle } from "../integrations/geo.adapter";
import { coreLib } from "../integrations/wasm.adapter";
import { MapDataService } from "../mapdata/mapdata.service";
import { MapViewService } from "../mapview/mapview.service";
import { MapViewState } from "../mapview/mapview.state";
import { RightClickMenuService } from "../mapview/rightclickmenu.service";
import { InfoMessageService } from "../diagnostics/info.service";
import { boundedUnicodeString } from "../utils/unicode-string.util";

export const FEATURE_SEARCH_TARGET_ID = "features";

/**
 * Response shape returned by the backend /locate endpoint for jump-target resolution.
 */
interface LocateResponse {
    responses: Array<Array<{
        tileId: string;
        typeId: string;
        featureId: Array<string>;
    }>>;
}

/** Camera target plus an optional exact coordinate at which to place the persistent marker. */
export interface SearchJump {
    target: number[] | Rectangle;
    markerPosition?: number[];
}

/** Legacy plugin jump values and the richer built-in jump representation. */
export type SearchJumpResult = number[] | Rectangle | SearchJump;

/** Normalizes plugin and built-in jump results while preserving point markers for legacy array targets. */
export function normalizeSearchJumpResult(result: SearchJumpResult): SearchJump {
    if (Array.isArray(result)) {
        return { target: result, markerPosition: result };
    }
    if ("target" in result) {
        return result;
    }
    return { target: result };
}

/**
 * One action offered by the omnibox-style search panel.
 *
 * Targets can either jump to a location or execute a side effect such as starting a feature search.
 */
export interface SearchTarget {
    id: string;
    icon: string;
    iconType?: "prime" | "material";
    color: string;
    name: string;
    label: string;
    enabled: boolean;
    acceptsEmptyInput?: boolean;
    saveToHistory?: (value: string) => boolean;
    payload?: unknown;
    jump?: (value: string, payload?: unknown) => SearchJumpResult | undefined | Promise<SearchJumpResult | undefined>;
    execute?: (value: string, payload?: unknown) => void | Promise<void>;
    validate: (value: string) => boolean;
}

/**
 * Core-lib jump-target description parsed from a feature id expression.
 */
interface FeatureJumpAction {
    id: string;
    name: string;
    error: string | null;
    idParts: Array<{ key: string, value: string | number }>;
    maps: Array<string>;
}

interface ParsedCoordinateJump extends SearchJump {
    label: string;
    markerPosition: number[];
    x?: number;
    y?: number;
    level?: number;
}

interface ParsedNdsCoordinateLabel {
    x: number;
    y: number;
    level?: number;
}

@Injectable({ providedIn: 'root' })
/**
 * Builds and executes the action list shown by the global search panel.
 *
 * The service merges static actions, feature-derived jump targets, plugin-provided actions,
 * and the temporary map-selection flow used when a feature can exist in multiple maps.
 */
export class JumpTargetService implements AppActionContributor {

    markedPosition: Subject<Array<number>> = new Subject<Array<number>>();
    targetValueSubject = new BehaviorSubject<string>("");
    readonly targetsChanged = new Subject<void>();
    extJumpTargets: Array<SearchTarget> = [];

    // Communication channels with the map selection dialog (in OmnibarComponent).
    // The mapSelectionSubject triggers the display of the dialog, and
    // the setSelectedMap promise resolver is used by the dialog to communicate the
    // user's choice.
    mapSelectionSubject = new Subject<Array<string>>();
    setSelectedMap: ((choice: string | null) => void) | null = null;

    /**
     * Loads optional jump-target plugins and wires the reactive channels used by the search UI.
     */
    constructor(private mapService: MapDataService,
        private inspectionSelection: InspectionSelectionService,
        private messageService: InfoMessageService,
        private menuService: RightClickMenuService,
        private configService: AppConfigService,
        public readonly coordinates: CoordinatesService,
        public readonly inspectionState: InspectionPanelService,
        public readonly viewSettings: MapViewState,
        private readonly views: MapViewService) {
        // Forward marked positions to the coordinate owner.
        this.markedPosition.subscribe(position => {
            if (position.length >= 2) {
                this.coordinates.setMarker({
                    enabled: true,
                    position: { lon: position[1], lat: position[0], alt: position[2] ?? 0 }
                });
            }
        });
    }

    private initialized = false;

    /** Starts parser-backed suggestions after config and the native library are ready. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.loadConfiguredJumpTargets();
        this.targetValueSubject.subscribe(() => this.update());
    }

    /** Loads optional jump-target plugins declared in the shared frontend config. */
    private loadConfiguredJumpTargets() {
        const jumpTargetsConfig = this.configService.getExtensionModuleId("jumpTargets");
        if (!jumpTargetsConfig) {
            return;
        }

        const jumpTargetsPath = `/static-config/${jumpTargetsConfig}.js`;
        this.loadJumpTargetsModule(jumpTargetsPath)
            .then((plugin) => plugin.default() as Array<SearchTarget>)
            .then((jumpTargets: Array<SearchTarget>) => {
                this.extJumpTargets = this.validatePluginJumpTargets(jumpTargets);
                this.update();
            })
            .catch((error) => {
                console.error(error);
            });
    }

    private validatePluginJumpTargets(jumpTargets: Array<SearchTarget>): Array<SearchTarget> {
        if (!Array.isArray(jumpTargets)) {
            throw new Error("Jump-target plugin must return an array.");
        }
        const seenIds = new Set<string>();
        for (const target of jumpTargets) {
            if (!target || typeof target.id !== "string" || !target.id.trim()) {
                throw new Error(`Jump-target plugin returned a target without a stable id: ${target?.name ?? "<unnamed>"}`);
            }
            if (seenIds.has(target.id)) {
                throw new Error(`Duplicate jump-target plugin id: ${target.id}`);
            }
            seenIds.add(target.id);
        }
        return jumpTargets;
    }

    /** Accepts only valid signed NDS.Live packed tile ids without embedded whitespace. */
    validatePackedTileId(value: string) {
        return parsePackedTileId(value) !== undefined;
    }

    /**
     * Builds the source-data inspection action for inputs of the form tileId [mapId] [sourceLayerId].
     *
     * The parser accepts quoted map and layer ids because both may contain spaces.
     */
    getInspectTileSourceDataTarget(searchString: string = this.targetValueSubject.getValue()) {
        let label = "packedTileId = ? | (mapId = ?) | (sourceLayerId = ?)";
        let valid = true;

        const matchSourceDataElements = (value: string): [number, string, string] | null => {
            const regex = /^\s*(-?\d+)(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?\s*$/;
            const match = value.match(regex);
            let tileId: number;
            let mapId = "";
            let sourceLayerId = "";

            if (match) {
                const [_, tileIdStr, quoted1, unquoted1, quoted2, unquoted2] = match;
                const packedTileId = parsePackedTileId(tileIdStr);
                if (!packedTileId) {
                    return null;
                }
                tileId = packedTileId.value;

                if (quoted1 || unquoted1) {
                    mapId = (quoted1 ? quoted1 : unquoted1).replace(/\\ /g, ' ');
                    if (mapId.startsWith('"') || mapId.startsWith("'")) {
                        mapId = mapId.slice(1, -1);
                    }
                    if (mapId.endsWith('"') || mapId.endsWith("'")) {
                        mapId = mapId.slice(1, -1);
                    }
                }
                if (quoted2 || unquoted2) {
                    sourceLayerId = (quoted2 ? quoted2 : unquoted2).replace(/\\ /g, ' ');
                    if (sourceLayerId.startsWith('"') || sourceLayerId.startsWith("'")) {
                        sourceLayerId = sourceLayerId.slice(1, -1);
                    }
                    if (sourceLayerId.endsWith('"') || sourceLayerId.endsWith("'")) {
                        mapId = sourceLayerId.slice(1, -1);
                    }
                }
            } else {
                return null;
            }

            return [tileId, mapId, sourceLayerId]
        }

        const matches = matchSourceDataElements(searchString);
        if (matches) {
            const [tileId, mapId, sourceLayerId] = matches;
            label = `packedTileId = ${tileId}`;
            if (mapId) {
                label = `${label} | mapId = ${mapId}`;
                if (sourceLayerId) {
                    label = `${label} | sourceLayerId = ${sourceLayerId}`;
                } else {
                    label = `${label} | (sourceLayerId = ?)`;
                }
            } else {
                label = `${label} | (mapId = ?) | (sourceLayerId = ?)`;
            }

            if (matches.length > 1 && matches[1]) {
                if (!this.mapService.maps.maps.has(matches[1])) {
                    label += `<br><span class="omnibar-option-warning">Map ID not found.</span>`;
                    valid = false;
                }
            }

            if (matches.length == 3 && matches[2]) {
                if (!this.mapService.sourceDataLayerIdForLayerName(matches[2])) {
                    label += `<br><span class="omnibar-option-warning">SourceData layer ID not found.</span>`;
                    valid = false;
                }
            }

            valid &&= this.validatePackedTileId(matches[0].toString());
        }
        else {
            valid = false;
        }

        return {
            id: "source-data",
            icon: "pi-database",
            color: "red",
            name: "Inspect Tile Layer Source Data",
            label: label,
            enabled: false,
            execute: (value: string) => {
                const matches = matchSourceDataElements(value);
                if (matches) {
                    let [tileId, mapId, sourceLayerId] = matches;
                    try {
                        if (tileId) {
                            if (mapId) {
                                if (sourceLayerId) {
                                    sourceLayerId = this.mapService.sourceDataLayerIdForLayerName(sourceLayerId) || "";
                                    if (sourceLayerId) {
                                        this.inspectionState.setSelection({
                                            mapTileKey: coreLib.getSourceDataLayerKey(mapId, sourceLayerId, tileId)
                                        } as SelectedSourceData);
                                    } else {
                                        this.menuService.customTileAndMapId.next([String(tileId), mapId]);
                                    }
                                } else {
                                    this.menuService.customTileAndMapId.next([String(tileId), mapId]);
                                }
                            } else {
                                this.menuService.customTileAndMapId.next([String(tileId), ""]);
                            }
                        }
                    } catch (e) {
                        this.messageService.showError(String(e));
                    }
                }
            },
            validate: (_: string) => {
                return valid;
            }
        }
    }

    /**
     * Loads the configured jump-target plugin bundle from /config at runtime.
     */
    private loadJumpTargetsModule(jumpTargetsPath: string) {
        return import(/* @vite-ignore */ jumpTargetsPath);
    }

    /**
     * Recomputes the active search targets whenever the query string or plugin state changes.
     */
    featureTargetsForValue(value: string): Array<SearchTarget> {
        let featureJumpTargets = this.mapService.tileLayerParser.filterFeatureJumpTargets(value) as Array<FeatureJumpAction>;
        let featureJumpTargetsConverted: Array<SearchTarget> = [];
        if (featureJumpTargets) {
            featureJumpTargetsConverted = featureJumpTargets.map((fjt: FeatureJumpAction) => {
                let label = fjt.idParts.map(idPart => `${idPart.key}=${idPart.value}`).join(" | ")
                if (fjt.error) {
                    label += `<br><span class="omnibar-option-warning">${fjt.error}</span>`;
                }
                return {
                    id: `fj:${fjt.id}`,
                    icon: "pi-arrow-down-left-and-arrow-up-right-to-center",
                    color: "orange",
                    name: `Jump to ${fjt.name}`,
                    label: label,
                    enabled: !fjt.error,
                    execute: (_: string) => this.highlightByJumpTarget(fjt, null, coreLib.HighlightMode.SELECTION_HIGHLIGHT,
                        this.viewSettings.focusedView),
                    validate: (_: string) => { return !fjt.error; },
                }
            });
        }

        return featureJumpTargetsConverted;
    }

    update() {
        this.targetsChanged.next();
    }

    /**
     * Resolves a raw feature id expression to the first valid jump action and executes it.
     */
    async highlightByJumpTargetFilter(mapId: string, featureId: string, mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT, cameraMoveViewIndex?: number) {
        let featureJumpTargets = this.mapService.tileLayerParser.filterFeatureJumpTargets(featureId) as Array<FeatureJumpAction>;
        const validIndex = featureJumpTargets.findIndex(action => !action.error);
        if (validIndex == -1) {
            console.error(`Error highlighting ${featureId}!`);
            return;
        }
        await this.highlightByJumpTarget(featureJumpTargets[validIndex], mapId, mode, cameraMoveViewIndex);
    }

    /**
     * Locates a specific feature, applies the requested highlight mode, and optionally moves the camera.
     *
     * If multiple maps are possible, the method waits for the search panel to provide a user choice first.
     */
    async highlightByJumpTarget(
        action: FeatureJumpAction,
        mapId?: string | null,
        mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT,
        cameraMoveViewIndex?: number) {
        const cameraTarget = cameraMoveViewIndex === undefined ? undefined : this.views.captureView(cameraMoveViewIndex);
        if (cameraMoveViewIndex !== undefined && !cameraTarget) return;
        const targetIsCurrent = () => !cameraTarget || !!this.views.resolveCapturedView(cameraTarget);
        // Select the map.
        if (!mapId) {
            if (action.maps.length > 1) {
                let selectedMapPromise = new Promise<string | null>((resolve, _) => {
                    this.setSelectedMap = resolve;
                })
                this.mapSelectionSubject.next(action.maps);
                mapId = await selectedMapPromise;
            }
            else {
                mapId = action.maps[0];
            }
        }
        if (!mapId || !targetIsCurrent()) return;

        // Locate the feature.
        let resolveMe = {
            requests: [{
                typeId: action.name,
                mapId: mapId,
                featureId: action.idParts.map((kv) => [kv.key, kv.value]).flat()
            }]
        };
        const response = await fetch("locate", {
            body: JSON.stringify(resolveMe),
            method: "POST"
        });
        if (!response.ok) {
            throw new Error(`Could not locate feature (HTTP ${response.status}).`);
        }
        let extRefsResolved = await response.json() as LocateResponse;
        if (!targetIsCurrent()) return;
        if (extRefsResolved.responses[0].length < 1) {
            this.messageService.showError("Could not locate feature!")
            return;
        }
        let selectThisFeature = extRefsResolved.responses[0][0];

        // Set feature-to-select on MapService.
        const featureId = `${selectThisFeature.typeId}.${selectThisFeature.featureId.filter((_, index) => index % 2 === 1).join('.')}`;
        if (mode === coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            this.inspectionState.setSelection([{
                mapTileKey: selectThisFeature.tileId,
                featureId: featureId
            } as TileFeatureId]);
        } else {
            this.inspectionSelection.setHoveredFeatures([{
                mapTileKey: selectThisFeature.tileId,
                featureId: featureId
            }], true);
        }

        // Center the camera on the feature if a view index was passed.
        if (cameraMoveViewIndex !== undefined) {
            await this.inspectionSelection.focusOnFeature(this.viewSettings.indexOfView(cameraTarget!.viewId), {
                featureId: featureId,
                mapTileKey: selectThisFeature.tileId,
            });
        }
    }

    /** Builds static search targets for the current input value. */
    coordinateTargetsForValue(inputValue: string) {
        const targetsArray: Array<SearchTarget> = [];
        const value = inputValue.trim();

        /////////// Jump to packed tile id
        let label = "packedTileId = ?";
        const packedTileIdValid = this.validatePackedTileId(value);
        if (packedTileIdValid) {
            label = `packedTileId = ${value}`;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:packed-tile-id",
            icon: "pi-table",
            color: "green",
            name: "PackedTileId",
            label: label,
            enabled: packedTileIdValid,
            jump: (value: string) => { return this.parsePackedTileId(value) },
            validate: (value: string) => { return this.validatePackedTileId(value) }
        });

        /////////// Jump to NDS x-y
        label = "x = ? | y = ? | (level = ?)";
        const ndsXyValid = this.validateNdsCoordinates(value, true);
        if (ndsXyValid) {
            label = this.parseNdsCoordinates(value, true)!.label;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-x-y",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS X-Y Coordinates",
            label: label,
            enabled: ndsXyValid,
            jump: (value: string) => this.parseNdsCoordinates(value, true),
            validate: (value: string) => { return this.validateNdsCoordinates(value, true) }
        });

        /////////// Jump to NDS y-x
        label = "y = ? | x = ? | (level = ?)";
        const ndsYxValid = this.validateNdsCoordinates(value, false);
        if (ndsYxValid) {
            label = this.parseNdsCoordinates(value, false)!.label;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-y-x",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS Y-X Coordinates",
            label: label,
            enabled: ndsYxValid,
            jump: (value: string) => this.parseNdsCoordinates(value, false),
            validate: (value: string) => { return this.validateNdsCoordinates(value, false) }
        });

        /////////// Jump to Morton code
        label = "mortonCode = ? | (level = ?)";
        const mortonValid = this.validateMortonCoordinates(value);
        if (mortonValid) {
            label = this.parseMortonCoordinates(value)!.label;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:morton-code",
            icon: "pi-map-marker",
            color: "green",
            name: "Morton Code Coordinates",
            label: label,
            enabled: mortonValid,
            jump: (value: string) => this.parseMortonCoordinates(value),
            validate: (value: string) => { return this.validateMortonCoordinates(value) }
        });

        /////////// Jump to lon-lat
        label = "lon = ? | lat = ? | (level = ?)"
        const lonLatValid = this.validateWGS84(value, true);
        if (lonLatValid) {
            label = this.parseWgs84Coordinates(value, true)!.label;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lon-lat",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lon-Lat Coordinates",
            label: label,
            enabled: lonLatValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, true),
            validate: (value: string) => { return this.validateWGS84(value, true) }
        });

        /////////// Jump to lat-lon
        label = "lat = ? | lon = ? | (level = ?)"
        const latLonValid = this.validateWGS84(value, false);
        if (latLonValid) {
            label = this.parseWgs84Coordinates(value, false)!.label;
        } else {
            label += `<br><span class="omnibar-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lat-lon",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lat-Lon Coordinates",
            label: label,
            enabled: latLonValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, false),
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });

        return targetsArray;
    }

    /** Resolves an already parsed WGS84 location into an exact point or native tile rectangle. */
    parseWgs84Coordinates(value: string, isLonLat: boolean): ParsedCoordinateJump | undefined {
        const parsed = parseWgs84CoordinateString(value, isLonLat);
        if (!parsed) return undefined;
        const { lat, lon, level } = parsed;
        const label = isLonLat ? `lon = ${lon} | lat = ${lat}` : `lat = ${lat} | lon = ${lon}`;
        return {
            target: level ? Rectangle.fromDegrees(...coreLib.getTileBox(coreLib.getTileIdFromPosition(lon, lat, level))) : [lat, lon, 0],
            label: label + (level ? ` | level = ${level}` : ''),
            markerPosition: [lat, lon]
        };
    }

    /** Converts a signed NDS.Live packed tile id into a WGS84 rectangle for camera jumps. */
    parsePackedTileId(value: string): Rectangle | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        try {
            const packedTileId = parsePackedTileIdValue(value);
            if (!packedTileId) {
                throw new Error("TileId is not a valid PackedTileId.");
            }
            return Rectangle.fromDegrees(...coreLib.getTileBox(packedTileId.value));
        } catch (e) {
            this.messageService.showError("Possibly malformed PackedTileId: " + (e as Error).message.toString());
        }
        return undefined;
    }

    /** Parses NDS coordinate pairs into either a point jump or a tile-extent jump when a level is present. */
    parseNdsCoordinates(value: string, isXyOrder: boolean): ParsedCoordinateJump | undefined {
        const parsed = parseNdsCoordinateString(value, isXyOrder);
        if (!parsed) {
            return undefined;
        }
        const label = this.ndsCoordinateLabel(parsed, isXyOrder);
        if (parsed.level !== undefined) {
            const tileId = packedTileIdFromParsedNdsCoordinates(parsed);
            if (tileId === undefined) {
                return undefined;
            }
            return {
                target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                label,
                markerPosition: [parsed.lat, parsed.lon],
                x: parsed.x,
                y: parsed.y,
                level: parsed.level
            };
        }
        return {
            target: [parsed.lat, parsed.lon, 0],
            label,
            markerPosition: [parsed.lat, parsed.lon],
            x: parsed.x,
            y: parsed.y
        };
    }

    /** Parses a Morton code into either a point jump or a tile-extent jump when a level is present. */
    parseMortonCoordinates(value: string): ParsedCoordinateJump | undefined {
        const parsed = parseMortonCoordinateString(value);
        if (!parsed) {
            return undefined;
        }
        const label = this.mortonCoordinateLabel(parsed);
        if (parsed.level !== undefined) {
            const tileId = packedTileIdFromMortonString(value);
            if (tileId === undefined) {
                return undefined;
            }
            return {
                target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                label,
                markerPosition: [parsed.lat, parsed.lon],
                x: parsed.x,
                y: parsed.y,
                level: parsed.level
            };
        }
        return {
            target: [parsed.lat, parsed.lon, 0],
            label,
            markerPosition: [parsed.lat, parsed.lon],
            x: parsed.x,
            y: parsed.y
        };
    }

    /** Builds the omnibar-action label for parsed NDS coordinate input. */
    private ndsCoordinateLabel(parsed: ParsedNdsCoordinateLabel, isXyOrder: boolean): string {
        const ordered = isXyOrder
            ? `x = ${parsed.x} | y = ${parsed.y}`
            : `y = ${parsed.y} | x = ${parsed.x}`;
        return parsed.level === undefined ? ordered : `${ordered} | level = ${parsed.level}`;
    }

    /** Builds the omnibar-action label for parsed Morton-code input. */
    private mortonCoordinateLabel(parsed: ParsedNdsCoordinateLabel): string {
        const base = `x = ${parsed.x} | y = ${parsed.y}`;
        return parsed.level === undefined ? base : `${base} | level = ${parsed.level}`;
    }

    /**
     * Dispatches the parsed jump target either as a camera move or a rectangle fit request.
     */
    jumpToLocation(result: SearchJumpResult | undefined, label?: string | null, targetViewIndex = this.viewSettings.focusedView) {
        if (result === undefined) {
            this.messageService.showError("Could not parse coordinates from the input.");
            return;
        }
        const jump = normalizeSearchJumpResult(result);
        const coordinates = jump.target;
        if (Array.isArray(coordinates)) {
            let lat = coordinates[0];
            let lon = coordinates[1];
            const cameraView = this.viewSettings.cameraViewDataState.getValue(targetViewIndex);
            let alt = coordinates[2] ? coordinates[2] : cameraView.destination.alt;

            this.views.moveToWgs84PositionTopic.next({
                x: lon,
                y: lat,
                z: alt,
                targetView: targetViewIndex
            });
            if (label) {
                this.views.showLocationLabelTopic.next({
                    targetView: targetViewIndex,
                    x: lon,
                    y: lat,
                    label
                });
            }
        } else {
            this.views.moveToRectangleTopic.next({
                targetView: targetViewIndex,
                rectangle: {
                    west: GeoMath.toDegrees(coordinates.west),
                    south: GeoMath.toDegrees(coordinates.south),
                    east: GeoMath.toDegrees(coordinates.east),
                    north: GeoMath.toDegrees(coordinates.north),
                }
            });
        }
        if (jump.markerPosition) {
            this.markedPosition.next(jump.markerPosition);
        }
    }

    /**
     * Validates coordinate inputs by parsing them and checking geographic bounds.
     */
    validateWGS84(value: string, isLonLat: boolean = false) {
        return parseWgs84CoordinateString(value, isLonLat) !== undefined;
    }

    /** Validates integer NDS coordinate input accepted by the built-in NDS jump targets. */
    validateNdsCoordinates(value: string, isXyOrder: boolean) {
        return this.parseNdsCoordinates(value, isXyOrder) !== undefined;
    }

    /** Validates Morton-code input accepted by the built-in Morton jump target. */
    validateMortonCoordinates(value: string) {
        return this.parseMortonCoordinates(value) !== undefined;
    }
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: AppActionRegistration): void {
        const appliedSchema = z.strictObject({ status: z.literal("applied"), changed: z.boolean() });

        actions.registerAction(
            {
                name: "inspect_source_input",
                exposure: "omnibar",
                mutation: true,
                description: "Inspect a packed tile ID with optional map and source layer names.",
                inputSchema: z.strictObject({ text: boundedUnicodeString(4096) }),
                outputSchema: appliedSchema
            },
            async (input) => {
                await this.executeTarget(this.getInspectTileSourceDataTarget(input.text), input.text);
                return applied();
            },
            (query) =>
                this.initialized
                    ? [this.candidate(this.getInspectTileSourceDataTarget(query), query, { text: query })]
                    : []
        );
        actions.registerAction(
            {
                name: "jump_feature_input",
                exposure: "omnibar",
                mutation: true,
                description: "Resolve a feature ID expression and navigate the focused map.",
                inputSchema: z.strictObject({
                    targetId: boundedUnicodeString(4096, true),
                    text: boundedUnicodeString(4096)
                }),
                outputSchema: appliedSchema
            },
            async (input) => {
                const target = this.featureTargetsForValue(input.text).find(
                    (target) => target.id === input.targetId
                );
                if (!target) rejectAction("The feature jump is no longer available");
                await this.executeTarget(target, input.text);
                return applied();
            },
            (query) =>
                this.initialized
                    ? this.featureTargetsForValue(query).map((target) =>
                          this.candidate(target, query, { targetId: target.id, text: query })
                      )
                    : []
        );
        actions.registerAction(
            {
                name: "jump_plugin_input",
                exposure: "omnibar",
                mutation: true,
                description:
                    "Run one configured jump provider with validated text and optional saved payload.",
                inputSchema: z.strictObject({
                    targetId: boundedUnicodeString(4096, true),
                    text: boundedUnicodeString(4096),
                    payload: z.unknown().optional()
                }),
                outputSchema: appliedSchema
            },
            async (input) => {
                const target = this.extJumpTargets.find((target) => target.id === input.targetId);
                if (!target) rejectAction("The jump provider is no longer available");
                await this.executeTarget(target, input.text, input.payload);
                return applied();
            },
            (query, history) =>
                this.extJumpTargets.map((target) =>
                    this.candidate(target, query, {
                        targetId: target.id,
                        text: query,
                        payload: history?.id === target.id ? history.payload : target.payload
                    })
                )
        );
        actions.registerAction(
            {
                name: "jump_coordinates",
                exposure: "omnibar",
                mutation: true,
                description: "Parse coordinates or a packed tile ID and navigate the focused map.",
                inputSchema: z.strictObject({
                    targetId: z.enum([
                        "j:packed-tile-id",
                        "j:nds-x-y",
                        "j:nds-y-x",
                        "j:morton-code",
                        "j:wgs84-lon-lat",
                        "j:wgs84-lat-lon"
                    ]),
                    text: boundedUnicodeString(4096)
                }),
                outputSchema: appliedSchema
            },
            async (input) => {
                const target = this.coordinateTargetsForValue(input.text).find(
                    (target) => target.id === input.targetId
                )!;
                await this.executeTarget(target, input.text);
                return applied();
            },
            (query) =>
                this.initialized
                    ? this.coordinateTargetsForValue(query).map((target) =>
                          this.candidate(target, query, {
                              targetId: target.id as {
                                  targetId:
                                      | "j:packed-tile-id"
                                      | "j:nds-x-y"
                                      | "j:nds-y-x"
                                      | "j:morton-code"
                                      | "j:wgs84-lon-lat"
                                      | "j:wgs84-lat-lon";
                                  text: string;
                              }["targetId"],
                              text: query
                          })
                      )
                    : []
        );
    }


    /** Adapts the supported plugin presentation contract; no callback escapes into the UI registry. */
    private candidate<Input>(target: SearchTarget, query: string, input: Input): AppActionCandidate<Input> {
        return {
            id: target.id, name: target.name, label: target.label, icon: target.icon,
            iconType: target.iconType, color: target.color, enabled: target.validate(query),
            acceptsEmptyInput: target.acceptsEmptyInput, saveToHistory: target.saveToHistory?.(query),
            payload: target.payload, input
        };
    }

    /** Revalidates a current parser/provider immediately before its ordinary behavior runs. */
    private async executeTarget(target: SearchTarget, query: string, payload?: unknown): Promise<void> {
        if (!target.validate(query) || (!query.trim() && !target.acceptsEmptyInput)) rejectAction("Search action is not valid for this input", "invalid_arguments");
        if (target.jump) {
            const destination = this.views.captureView(this.viewSettings.focusedView);
            if (!destination) rejectAction("The destination map is unavailable");
            const result = await target.jump(query, payload);
            if (!this.views.resolveCapturedView(destination)) rejectAction("The destination map is no longer available", "cancelled");
            this.jumpToLocation(result, undefined, this.viewSettings.indexOfView(destination.viewId));
        }
        else if (target.execute) await target.execute(query, payload);
        else rejectAction("Search action has no handler");
    }

}
