import {Component} from "@angular/core";
import {CoordinatesService} from "./coordinates.service";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {CesiumMath} from "./cesium";
import {ClipboardService} from "./clipboard.service";

interface PanelOption {
    name: string,
    level?: number
}

@Component({
    selector: "coordinates-panel",
    template: `
        <div class="coordinates-container">
            <p-button (click)="toggleMarker()" label="" [pTooltip]="markerButtonTooltip" tooltipPosition="bottom"
                      [style]="{'padding-left': '0', 'padding-right': '0', width: '2em', height: '2em', 'box-shadow': 'none'}">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">{{markerButtonIcon}}</span>
            </p-button>
            <p-card *ngIf="longitude && latitude" xmlns="http://www.w3.org/1999/html"
                    class="coordinates-panel">
                <div class="coordinates-entries">
                    <p-multiSelect dropdownIcon="pi pi-list-check" [options]="displayOptions" [(ngModel)]="selectedOptions" 
                                   optionLabel="name" placeholder="" class="coordinates-select" appendTo="body"/>
                    <div class="coordinates-entry" *ngIf="isSelectedOption('WGS84')">
                        <span class="name-span" (click)="copyToClipboard([longitude, latitude])">WGS84:</span>
                        <span class="coord-span">{{ longitude.toFixed(8) }}</span>
                        <span class="coord-span">{{ latitude.toFixed(8) }}</span>
                    </div>
                    <ng-container *ngFor="let coords of auxillaryCoordinates | keyvalue" >
                        <div *ngIf="isSelectedOption(coords.key)" class="coordinates-entry">
                            <span class="name-span" (click)="copyToClipboard(coords.value)">{{ coords.key }}:</span>
                            <span *ngFor="let component of coords.value" class="coord-span">{{ component }}</span>
                        </div>
                    </ng-container>
                    <ng-container *ngFor="let tileIds of auxillaryTileIds | keyvalue" >
                        <div *ngIf="isSelectedOption(tileIds.key)" class="coordinates-entry">
                            <span class="name-span" (click)="clipboardService.copyToClipboard(tileIds.value.toString())">{{ tileIds.key }}:</span>
                            <span class="coord-span">{{ tileIds.value }}</span>
                        </div>
                    </ng-container>
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
            cursor: pointer;
            text-decoration: underline dotted;
            text-wrap: nowrap;
            max-width: 10em;
        }
        
        .coord-span {
            text-align: right;
            font-family: "monospace";
        }
    `]
})
export class CoordinatesPanelComponent {

    longitude: number = 0;
    latitude: number = 0;
    isMarkerEnabled: boolean = false;
    markerPosition: {x: number, y: number} | null = null;
    auxillaryCoordinates: Map<string, Array<number>> = new Map<string, Array<number>>();
    auxillaryTileIds: Map<string, bigint> = new Map<string, bigint>();
    markerButtonIcon: string = "location_off";
    markerButtonTooltip: string = "Enable marker placement";
    displayOptions: Array<PanelOption> = [{name: "WGS84"}];
    selectedOptions: Array<PanelOption> = [{name: "WGS84"}];

    constructor(public mapService: MapService,
                public coordinatesService: CoordinatesService,
                public clipboardService: ClipboardService,
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
                if (this.coordinatesService.auxillaryTileIdsFun) {
                    for (let level = 0; level <= 15; level++) {
                        const levelData: Map<string, bigint> =
                            this.coordinatesService.auxillaryTileIdsFun(this.longitude, this.latitude, level).reduce(
                                (map: Map<string, bigint>, [key, value]: [string, bigint]) => {
                                    map.set(key, value);
                                    return map;
                                }, new Map<string, bigint>());

                        levelData.forEach((value, key) => {
                            // If the key already exists, you might want to decide how to handle it.
                            // For now, let's just set the value from the latest level.
                            // If you want to sum or handle differently, adjust the following line accordingly.
                            this.auxillaryTileIds.set(`${key} (level ${level})`, value);
                        });
                    }
                }
            } else {
                if (this.isMarkerEnabled) {
                    this.markerButtonIcon = "location_on";
                    this.markerButtonTooltip = "Disable marker placement";
                }
                this.longitude = 0;
                this.latitude = 0;
                this.markerPosition = null;
            }
        });
        this.coordinatesService.mouseMoveCoordinates.subscribe(coordinates => {
            if (!this.markerPosition && coordinates) {
                this.longitude = CesiumMath.toDegrees(coordinates.longitude);
                this.latitude = CesiumMath.toDegrees(coordinates.latitude);
                if (this.coordinatesService.auxillaryCoordinatesFun) {
                    this.auxillaryCoordinates =
                        this.coordinatesService.auxillaryCoordinatesFun(this.longitude, this.latitude).reduce(
                            (map: Map<string, Array<number>>, [key, value]: [string, Array<number>]) => {
                                map.set(key, value);
                                return map;
                            }, new Map<string, Array<number>>());
                    for (const key of this.auxillaryCoordinates.keys()) {
                        if (!this.displayOptions.some(val => val.name == key)) {
                            this.displayOptions.push({name: key});
                        }
                    }
                }
                if (this.coordinatesService.auxillaryTileIdsFun) {
                    for (let level = 0; level <= 15; level++) {
                        const levelData: Map<string, bigint> =
                            this.coordinatesService.auxillaryTileIdsFun(this.longitude, this.latitude, level).reduce(
                                (map: Map<string, bigint>, [key, value]: [string, bigint]) => {
                                    map.set(key, value);
                                    return map;
                                }, new Map<string, bigint>());

                        levelData.forEach((value, key) => {
                            // If the key already exists, you might want to decide how to handle it.
                            // For now, let's just set the value from the latest level.
                            // If you want to sum or handle differently, adjust the following line accordingly.
                            this.auxillaryTileIds.set(`${key} (level ${level})`, value);
                        });
                    }
                    for (const key of this.auxillaryTileIds.keys()) {
                        if (!this.displayOptions.some(val => val.name == key)) {
                            this.displayOptions.push({name: key});
                        }
                    }
                }
            }
        });
    }

    toggleMarker() {
        if (!this.isMarkerEnabled) {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.markerButtonIcon = "location_on";
            this.markerButtonTooltip = "Disable marker placement";
        } else if (!this.markerPosition) {
            this.isMarkerEnabled = false;
            this.parametersService.setMarkerState(false);
            this.markerButtonIcon = "location_off";
            this.markerButtonTooltip = "Enable marker placement";
        } else if (this.markerPosition) {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.parametersService.setMarkerPosition(null);
            this.markerButtonIcon = "location_on";
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
        this.clipboardService.copyToClipboard(coordArray.join(" "));
    }

    // updateDisplayedOptions(key: string, value: boolean) {
    //     this.displayOptions.set(key, value);
    // }

    isSelectedOption(name: string) {
        return this.selectedOptions.some(val => val.name == name);
    }
}