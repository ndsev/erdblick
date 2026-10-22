import {inject, Injectable} from "@angular/core";
import {rejectAction} from "../actions/action-utils";
import {normalizeSearchJumpResult, SearchJump, SearchJumpResult, SearchTarget} from "../actions/omnibar";
import {
    packedTileIdFromMortonString,
    packedTileIdFromParsedNdsCoordinates,
    parseMortonCoordinateString,
    parseNdsCoordinateString,
    parsePackedTileId as parsePackedTileIdValue
} from "../coords/nds-coordinate.util";
import {GeoMath, Rectangle} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {MapViewService} from "../mapview/map-view.service";
import {ViewIdentity} from "../mapview/view-id";
import {AppStore} from "../shared/app.store";
import {InfoMessageService} from "../shared/info.service";
import {coordinateParserSchema, type NavigationActionInput} from "./navigation-actions.store-feature";

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
/** Owns the six coordinate/tile interpretations offered by the omnibar. */
@Injectable({providedIn: "root"})
export class CoordinateJumpService {
    private readonly messageService = inject(InfoMessageService);
    private readonly store = inject(AppStore);
    private readonly views = inject(MapViewService);

    /** Revalidates the selected coordinate interpretation against the current query before navigation. */
    jumpCoordinates({parser, query, target}: NavigationActionInput<"jumpCoordinates">): void {
        const interpretation = this.interpretations(query).find((candidate) => candidate.id === parser);
        if (!interpretation || !interpretation.validate(query)) rejectAction("Invalid coordinate input", "invalid_arguments");
        this.navigate(interpretation.jump(query), target);
    }

    /** Bind each parser choice to the same validated navigation operation and a live view lifetime. */
    targets(query: string): SearchTarget[] {
        const target = this.store.captureView(this.store.focusedView())!;
        return this.interpretations(query).map(({jump, ...presentation}) =>
            this.store.actionCatalog.candidate(this.store.jumpCoordinates, {
                ...presentation,
                arguments: (input) => ({
                    parser: coordinateParserSchema.parse(presentation.id),
                    query: input,
                    target
                }),
                isCurrent: () => this.store.isCurrent(target),
                saveToHistory: () => true
            })
        );
    }

    /** Publish a parsed coordinate/plugin jump through ordinary camera and marker owners. */
    navigate(result: SearchJumpResult | undefined, target: ViewIdentity, label?: string | null): void {
        if (result === undefined) rejectAction("Could not parse coordinates from the input", "invalid_arguments");
        const index = this.store.requireCurrentView(target);
        const jump = normalizeSearchJumpResult(result);
        const coordinates = jump.target;
        if (Array.isArray(coordinates)) {
            const [lat, lon] = coordinates;
            const alt = coordinates[2] || this.store.views.cameraViewData()[target.id].destination.alt;
            this.views.moveToWgs84PositionTopic.next({x: lon, y: lat, z: alt, targetView: index});
            if (label) this.views.showLocationLabelTopic.next({targetView: index, x: lon, y: lat, label});
        } else {
            this.views.moveToRectangleTopic.next({
                targetView: index,
                rectangle: {
                    west: GeoMath.toDegrees(coordinates.west),
                    south: GeoMath.toDegrees(coordinates.south),
                    east: GeoMath.toDegrees(coordinates.east),
                    north: GeoMath.toDegrees(coordinates.north)
                }
            });
        }
        if (jump.markerPosition) {
            const [lat, lon, alt = 0] = jump.markerPosition;
            this.store.setMarkerControl({enabled: true, position: {lat, lon, alt}});
        }
    }

    /** Builds static search targets for the current input value. */
    private interpretations(inputValue: string) {
        const targetsArray: Array<
            Omit<SearchTarget, "jump"> & {jump: (value: string) => SearchJumpResult | undefined}
        > = [];
        const value = inputValue.trim();

        /////////// Jump to packed tile id
        let label = "packedTileId = ?";
        const packedTileIdValid = parsePackedTileIdValue(value) !== undefined;
        if (packedTileIdValid) {
            label = `packedTileId = ${value}`;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:packed-tile-id",
            icon: "pi-table",
            color: "green",
            name: "PackedTileId",
            label: label,
            enabled: packedTileIdValid,
            jump: (value: string) => {
                return this.parsePackedTileId(value);
            },
            validate: (value: string) => {
                return parsePackedTileIdValue(value) !== undefined;
            }
        });

        /////////// Jump to NDS x-y
        label = "x = ? | y = ? | (level = ?)";
        const ndsXyValid = this.validateNdsCoordinates(value, true);
        if (ndsXyValid) {
            label = this.parseNdsCoordinates(value, true)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-x-y",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS X-Y Coordinates",
            label: label,
            enabled: ndsXyValid,
            jump: (value: string) => this.parseNdsCoordinates(value, true),
            validate: (value: string) => {
                return this.validateNdsCoordinates(value, true);
            }
        });

        /////////// Jump to NDS y-x
        label = "y = ? | x = ? | (level = ?)";
        const ndsYxValid = this.validateNdsCoordinates(value, false);
        if (ndsYxValid) {
            label = this.parseNdsCoordinates(value, false)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-y-x",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS Y-X Coordinates",
            label: label,
            enabled: ndsYxValid,
            jump: (value: string) => this.parseNdsCoordinates(value, false),
            validate: (value: string) => {
                return this.validateNdsCoordinates(value, false);
            }
        });

        /////////// Jump to Morton code
        label = "mortonCode = ? | (level = ?)";
        const mortonValid = this.validateMortonCoordinates(value);
        if (mortonValid) {
            label = this.parseMortonCoordinates(value)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:morton-code",
            icon: "pi-map-marker",
            color: "green",
            name: "Morton Code Coordinates",
            label: label,
            enabled: mortonValid,
            jump: (value: string) => this.parseMortonCoordinates(value),
            validate: (value: string) => {
                return this.validateMortonCoordinates(value);
            }
        });

        /////////// Jump to lon-lat
        label = "lon = ? | lat = ? | (level = ?)";
        const lonLatValid = this.validateWGS84(value, true);
        if (lonLatValid) {
            label = this.parseWgs84Coordinates(value, true)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lon-lat",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lon-Lat Coordinates",
            label: label,
            enabled: lonLatValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, true),
            validate: (value: string) => {
                return this.validateWGS84(value, true);
            }
        });

        /////////// Jump to lat-lon
        label = "lat = ? | lon = ? | (level = ?)";
        const latLonValid = this.validateWGS84(value, false);
        if (latLonValid) {
            label = this.parseWgs84Coordinates(value, false)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lat-lon",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lat-Lon Coordinates",
            label: label,
            enabled: latLonValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, false),
            validate: (value: string) => {
                return this.validateWGS84(value, false);
            }
        });

        return targetsArray;
    }

    /**
     * Parses decimal or degree-minute-second WGS84 coordinate strings, optionally with a tile level.
     */
    parseWgs84Coordinates(coordinateString: string, isLonLat: boolean): ParsedCoordinateJump | undefined {
        let lon = 0;
        let lat = 0;
        let level = 0;
        let isMatched = false;
        coordinateString = coordinateString.trim();

        // WGS (decimal)
        let exp = /^[^\d-]*(-?\d+(?:\.\d*)?)[^\d-]+(-?\d+(?:\.\d*)?)[^\d\.]*(\d+)?[^\d]*$/g;
        let matches = [...coordinateString.matchAll(exp)];
        if (matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 3) {
                if (isLonLat) {
                    lon = Number(matchResults[1]);
                    lat = Number(matchResults[2]);
                } else {
                    lon = Number(matchResults[2]);
                    lat = Number(matchResults[1]);
                }

                if (matchResults.length >= 4 && matchResults[3] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[3].toString()), 14));
                }
                isMatched = true;
            }
        }

        // WGS (degree)
        if (!isMatched) {
            if (isLonLat) {
                exp =
                    /((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])\s*((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])[^\d\.]*(\d+)?[^\d]*$/g;
            } else {
                exp =
                    /((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])\s*((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])[^\d\.]*(\d+)?[^\d]*$/g;
            }
            matches = [...coordinateString.matchAll(exp)];
        }
        if (!isMatched && matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 9) {
                let degreeLon = isLonLat ? Number(matchResults[1]) : Number(matchResults[5]);
                let minutesLon = isLonLat ? Number(matchResults[2]) : Number(matchResults[6]);
                let secondsLon = isLonLat ? Number(matchResults[3]) : Number(matchResults[7]);
                let degreeLat = isLonLat ? Number(matchResults[5]) : Number(matchResults[1]);
                let minutesLat = isLonLat ? Number(matchResults[6]) : Number(matchResults[2]);
                let secondsLat = isLonLat ? Number(matchResults[7]) : Number(matchResults[3]);

                lat = degreeLat + (minutesLat * 60.0 + secondsLat) / 3600.0;
                if (matchResults[4][0] == "S") {
                    lat = -lat;
                }

                lon = degreeLon + (minutesLon * 60.0 + secondsLon) / 3600.0;
                if (matchResults[8][0] == "W") {
                    lon = -lon;
                }

                if (matchResults.length >= 10 && matchResults[9] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[9].toString()), 14));
                }

                isMatched = true;
            }
        }

        if (isMatched) {
            if (level) {
                const tileId = coreLib.getTileIdFromPosition(lon, lat, level);
                return {
                    target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                    label: isLonLat
                        ? `lon = ${lon} | lat = ${lat} | level = ${level}`
                        : `lat = ${lat} | lon = ${lon} | level = ${level}`,
                    markerPosition: [lat, lon]
                };
            }
            return {
                target: [lat, lon, 0],
                label: isLonLat ? `lon = ${lon} | lat = ${lat}` : `lat = ${lat} | lon = ${lon}`,
                markerPosition: [lat, lon]
            };
        }
        return undefined;
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

    /** Builds the search-action label for parsed NDS coordinate input. */
    private ndsCoordinateLabel(parsed: ParsedNdsCoordinateLabel, isXyOrder: boolean): string {
        const ordered = isXyOrder ? `x = ${parsed.x} | y = ${parsed.y}` : `y = ${parsed.y} | x = ${parsed.x}`;
        return parsed.level === undefined ? ordered : `${ordered} | level = ${parsed.level}`;
    }

    /** Builds the search-action label for parsed Morton-code input. */
    private mortonCoordinateLabel(parsed: ParsedNdsCoordinateLabel): string {
        const base = `x = ${parsed.x} | y = ${parsed.y}`;
        return parsed.level === undefined ? base : `${base} | level = ${parsed.level}`;
    }

    /**
     * Validates coordinate inputs by parsing them and checking geographic bounds.
     */
    validateWGS84(value: string, isLonLat: boolean = false) {
        const result = this.parseWgs84Coordinates(value, isLonLat);
        if (result) {
            return (
                result.markerPosition[0] >= -90 &&
                result.markerPosition[0] <= 90 &&
                result.markerPosition[1] >= -180 &&
                result.markerPosition[1] <= 180
            );
        }
        return false;
    }

    /** Validates integer NDS coordinate input accepted by the built-in NDS jump targets. */
    validateNdsCoordinates(value: string, isXyOrder: boolean) {
        return this.parseNdsCoordinates(value, isXyOrder) !== undefined;
    }

    /** Validates Morton-code input accepted by the built-in Morton jump target. */
    validateMortonCoordinates(value: string) {
        return this.parseMortonCoordinates(value) !== undefined;
    }
}
