import {Component} from "@angular/core";
import {Cartesian3} from "cesium";
import {InfoMessageService} from "./info.service";
import {JumpTarget, JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {coreLib} from "./wasm";
import {ParametersService} from "./parameters.service";


@Component({
    selector: 'search-menu-items',
    template: `
        <div class="search-menu-wrapper">
            <div class="search-menu" *ngFor="let item of searchItems">
                <p-divider></p-divider>
                <p (click)="jumpToWGS84(item.jump(value))" class="search-option" [ngClass]="{'item-disabled': !item.enabled }"><span>{{item.name}}</span><br>{{item.label}}</p>
            </div>
        </div>
    `,
    styles: [`
        .item-disabled {
            color: lightgrey;
            pointer-events: none;
        }
    `]
})
export class SearchMenuComponent {

    searchItems: Array<JumpTarget> = [];
    value: string = "";

    constructor(public mapService: MapService,
                public parametersService: ParametersService,
                private messageService: InfoMessageService,
                private jumpToTargetService: JumpTargetService) {

        this.jumpToTargetService.targetValueSubject.subscribe((event: string) => {
            this.value = event;
            this.validateMenuItems();
        });

        this.jumpToTargetService.availableOptions.subscribe((jumpTargets: Array<JumpTarget>) => {
            this.searchItems = [
                ...jumpTargets,
                ...[
                    {
                        name: "Tile ID",
                        label: "Jump to Tile by its Mapget ID",
                        enabled: false,
                        jump: (value: string) => { return this.parseMapgetTileId(value) },
                        validate: (value: string) => { return this.validateMapgetTileId(value) }
                    },
                    {
                        name: "WGS84 Lat-Lon Coordinates",
                        label: "Jump to WGS84 Coordinates",
                        enabled: false,
                        jump: (value: string) => { return this.parseWgs84Coordinates(value, false) },
                        validate: (value: string) => { return this.validateWGS84(value, false) }
                    },
                    {
                        name: "WGS84 Lon-Lat Coordinates",
                        label: "Jump to WGS84 Coordinates",
                        enabled: false,
                        jump: (value: string) => { return this.parseWgs84Coordinates(value, true) },
                        validate: (value: string) => { return this.validateWGS84(value, true) }
                    },
                    {
                        name: "Open WGS84 Lat-Lon in Google Maps",
                        label: "Open Location in External Map Service",
                        enabled: false,
                        jump: (value: string) => { return this.openInGM(value) },
                        validate: (value: string) => { return this.validateWGS84(value, false) }
                    },
                    {
                        name: "Open WGS84 Lat-Lon in Open Street Maps",
                        label: "Open Location in External Map Service",
                        enabled: false,
                        jump: (value: string) => { return this.openInOSM(value) },
                        validate: (value: string) => { return this.validateWGS84(value, false) }
                    }
                ]
            ];
        });
    }

    parseMapgetTileId(value: string): number[] | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        try {
            let wgs84TileId = BigInt(value);
            let position = coreLib.getTilePosition(wgs84TileId);
            return [position.x, position.y, position.z]
        } catch (e) {
            this.messageService.showError("Possibly malformed TileId: " + (e as Error).message.toString());
        }
        return undefined;
    }

    parseWgs84Coordinates(coordinateString: string, isLonLat: boolean): number[] | undefined {
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
        if (isLonLat) {
            exp = /((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])\s*((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])[^\d\.]*(\d+)?[^\d]*$/g
        } else {
            exp = /((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])\s*((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])[^\d\.]*(\d+)?[^\d]*$/g;
        }
        matches = [...coordinateString.matchAll(exp)];
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
                if (matchResults[4][0] == 'S') {
                    lat = -lat;
                }

                lon = degreeLon + (minutesLon * 60.0 + secondsLon) / 3600.0;
                if (matchResults[8][0] == 'W') {
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
            return [lat, lon, level];
        }
        return undefined;
    }

    jumpToWGS84(coordinates: number[] | undefined) {
        if (coordinates === undefined) {
            this.messageService.showError("Could not parse coordinates from the input.");
            return;
        }
        let lat = coordinates[0];
        let lon = coordinates[1];
        let alt = coordinates.length > 2 && coordinates[2] > 0 ? coordinates[2] : 15000;
        let position = Cartesian3.fromDegrees(lon, lat, alt);
        let orientation = this.parametersService.collectCameraOrientation();
        if (orientation) {
            this.parametersService.cameraViewData.next({
                destination: position,
                orientation: orientation
            });
        }
    }

    openInGM(value: string): number[] | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return undefined;
        }
        let result = this.parseWgs84Coordinates(value, false);
        if (result !== undefined) {
            let lat = result[0];
            let lon = result[1];
            window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`, "_blank");
            return result;
        }
        return undefined;
    }

    openInOSM(value: string): number[] | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        let result = this.parseWgs84Coordinates(value, false);
        if (result !== undefined) {
            let lat = result[0];
            let lon = result[1];
            window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=16`, "_blank");
            return result;
        }
        return undefined;
    }

    validateMenuItems() {
        this.searchItems.forEach(item =>
            item.enabled = this.value != "" && item.validate(this.value)
        );
    }

    validateMapgetTileId(value: string) {
        return value.length > 0 && !/\s/g.test(value.trim());
    }

    validateWGS84(value: string, isLonLat: boolean = false) {
        const coords = this.parseWgs84Coordinates(value, isLonLat);
        return coords !== undefined && coords[0] >= -90 && coords[0] <= 90 && coords[1] >= -180 && coords[1] <= 180;
    }
}