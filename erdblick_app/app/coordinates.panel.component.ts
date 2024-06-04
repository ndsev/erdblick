import {Component} from "@angular/core";
import {CoordinatesService} from "./coordinates.service";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {CesiumMath} from "./cesium";
import {InfoMessageService} from "./info.service";

@Component({
    selector: "coordinates-panel",
    template: `
        <div class="coordinates-container">
            <p-button (click)="toggleMarker()" label="" [pTooltip]="markerButtonTooltip" tooltipPosition="bottom"
                      [style]="{'padding-left': '0', 'padding-right': '0', width: '2em', height: '2em', 'box-shadow': 'none'}">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">{{markerButtonIcon}}</span>
            </p-button>
            <p-card *ngIf="isMarkerEnabled && longitude && latitude" xmlns="http://www.w3.org/1999/html"
                    class="coordinates-panel">
                <div>
                    <div class="coordinates-entry">
                        <span class="name-span" (click)="copyToClipboard([longitude, latitude])">WGS84:</span>
                        <span class="coord-span">{{ longitude.toFixed(8) }}</span>
                        <span class="coord-span">{{ latitude.toFixed(8) }}</span>
                    </div>
                    <div *ngFor="let coords of auxillaryCoordinates | keyvalue" class="coordinates-entry">
                        <span class="name-span" (click)="copyToClipboard(coords.value)">{{ coords.key }}:</span>
                        <span *ngFor="let component of coords.value" class="coord-span">{{ component }}</span>
                    </div>
                </div>
            </p-card>
            <p-button *ngIf="isMarkerEnabled && markerPosition" (click)="mapService.moveToWgs84PositionTopic.next(markerPosition)"
                      label="" pTooltip="Focus on marker" tooltipPosition="bottom"
                      [style]="{'padding-left': '0', 'padding-right': '0', width: '2em', height: '2em', 'box-shadow': 'none'}">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
            </p-button>
        </div>
        
    `,
    styles: [`
        .name-span {
            width: 4em;
            cursor: pointer;
            text-decoration: underline dotted;
        }
        
        .coord-span {
            width: 7em;
            text-align: right;
        }
    `]
})
export class CoordinatesPanelComponent {

    longitude: number = 0;
    latitude: number = 0;
    isMarkerEnabled: boolean = false;
    markerPosition: {x: number, y: number} | null = null;
    auxillaryCoordinates: Map<string, Array<number>> = new Map<string, Array<number>>();
    markerButtonIcon: string = "location_on";
    markerButtonTooltip: string = "Enable marker placement";

    constructor(public mapService: MapService,
                public coordinatesService: CoordinatesService,
                public messageService: InfoMessageService,
                public parametersService: ParametersService) {
        this.parametersService.parameters.subscribe(parameters => {
            this.isMarkerEnabled = parameters.marker;
            if (this.isMarkerEnabled && parameters.marked_position.length == 2) {
                this.markerButtonIcon = "wrong_location";
                this.markerButtonTooltip = "Reset marker";
                this.longitude = parameters.marked_position[0];
                this.latitude = parameters.marked_position[1];
                this.markerPosition = {x: this.longitude, y: this.latitude};
                if (this.coordinatesService.auxillaryCoordinatesFun) {
                    this.auxillaryCoordinates =
                        this.coordinatesService.auxillaryCoordinatesFun(this.longitude, this.latitude).reduce(
                            (map: Map<string, Array<number>>, [key, value]: [string, Array<number>]) => {
                                map.set(key, value);
                                return map;
                            }, new Map<string, Array<number>>());
                }
            } else {
                if (this.isMarkerEnabled) {
                    this.markerButtonIcon = "location_off";
                    this.markerButtonTooltip = "Disable marker placement";
                }
                this.longitude = 0;
                this.latitude = 0;
                this.markerPosition = null;
            }
        });
        this.coordinatesService.mouseMoveCoordinates.subscribe(coordinates => {
            if (this.isMarkerEnabled && !this.markerPosition && coordinates) {
                this.longitude = CesiumMath.toDegrees(coordinates.longitude);
                this.latitude = CesiumMath.toDegrees(coordinates.latitude);
                if (this.coordinatesService.auxillaryCoordinatesFun) {
                    this.auxillaryCoordinates =
                        this.coordinatesService.auxillaryCoordinatesFun(this.longitude, this.latitude).reduce(
                            (map: Map<string, Array<number>>, [key, value]: [string, Array<number>]) => {
                                map.set(key, value);
                                return map;
                            }, new Map<string, Array<number>>());
                }
            }
        });
    }

    toggleMarker() {
        if (!this.isMarkerEnabled) {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.markerButtonIcon = "location_off";
            this.markerButtonTooltip = "Disable marker placement";
        } else if (!this.markerPosition) {
            this.isMarkerEnabled = false;
            this.parametersService.setMarkerState(false);
            this.markerButtonIcon = "location_on";
            this.markerButtonTooltip = "Enable marker placement";
        } else if (this.markerPosition) {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.parametersService.setMarkerPosition(null);
            this.markerButtonIcon = "location_off";
            this.markerButtonTooltip = "Disable marker placement";
        } else {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.parametersService.setMarkerPosition(null);
            this.markerButtonIcon = "wrong_location";
            this.markerButtonTooltip = "Reset marker";
        }
    }

    copyToClipboard(coordArray: Array<number>) {
        navigator.clipboard.writeText(coordArray.join(" ")).then(
            () => {
                this.messageService.showSuccess("Copied content to clipboard!");
            },
            () => {
                this.messageService.showError("Could not copy content to clipboard.");
            },
        );
    }
}