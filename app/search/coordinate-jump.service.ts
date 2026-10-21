import {inject, Injectable} from "@angular/core";
import {AppActionService} from "../actions/app-action.service";
import type {SearchJump, SearchTarget} from "../actions/omnibar";
import {
    packedTileIdFromMortonString,
    packedTileIdFromParsedNdsCoordinates,
    parseMortonCoordinateString,
    parseNdsCoordinateString,
    parsePackedTileId as parsePackedTileIdValue
} from "../coords/nds-coordinate.util";
import {Rectangle} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";

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
    constructor() {
        inject(AppActionService).registerOmnibar("coordinates", (query) => this.targets(query), 30);
    }

    /** Builds static search targets for the current input value. */
    targets(inputValue: string) {
        const targetsArray: Array<SearchTarget> = [];
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
