import {Component} from "@angular/core";
import {CoordinatesService} from "./coordinates.service";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {CesiumMath} from "./cesium";
import {ClipboardService} from "./clipboard.service";
import {coreLib} from "./wasm";
import {InspectionService} from "./inspection.service";
import {KeyValue} from "@angular/common";

interface PanelOption {
    name: string,
    level?: number
}

@Component({
    selector: "coordinates-panel",
    template: `
        <div class="coordinates-container" [ngClass]="{'elevated': inspectionService.isInspectionPanelVisible }">
            <p-button (click)="toggleMarker()" label="" [pTooltip]="markerButtonTooltip" tooltipPosition="bottom"
                      [style]="{'padding-left': '0', 'padding-right': '0', width: '2em', height: '2em', 'box-shadow': 'none'}">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">{{ markerButtonIcon }}</span>
            </p-button>
            <p-card *ngIf="longitude !== undefined && latitude !== undefined" class="coordinates-panel">
                <p-multiSelect dropdownIcon="pi pi-list-check" [options]="displayOptions" [(ngModel)]="selectedOptions"
                               (ngModelChange)="updateSelectedOptions()" optionLabel="name" placeholder=""
                               class="coordinates-select" appendTo="body"/>
                <div class="coordinates-entries">
                    <div class="coordinates-entry" *ngIf="isSelectedOption('WGS84')">
                        <span class="name-span" (click)="copyToClipboard([longitude, latitude])">WGS84:</span>
                        <span class="coord-span">{{ longitude.toFixed(8) }}</span>
                        <span class="coord-span">{{ latitude.toFixed(8) }}</span>
                    </div>
                    <ng-container *ngFor="let coords of auxiliaryCoordinates | keyvalue">
                        <div *ngIf="isSelectedOption(coords.key)" class="coordinates-entry">
                            <span class="name-span" (click)="copyToClipboard(coords.value)">{{ coords.key }}:</span>
                            <span *ngFor="let component of coords.value" class="coord-span">{{ component }}</span>
                        </div>
                    </ng-container>
                    <ng-container *ngFor="let tileId of mapgetTileIds | keyvalue: compareLevels">
                        <div *ngIf="isSelectedOption(tileId.key)" class="coordinates-entry">
                            <span class="name-span"
                                  (click)="clipboardService.copyToClipboard(tileId.value.toString())">{{ tileId.key }}
                                :</span>
                            <span class="coord-span">{{ tileId.value }}</span>
                        </div>
                    </ng-container>
                    <ng-container *ngFor="let tileId of auxiliaryTileIds | keyvalue: compareLevels">
                        <div *ngIf="isSelectedOption(tileId.key)" class="coordinates-entry">
                            <span class="name-span"
                                  (click)="clipboardService.copyToClipboard(tileId.value.toString())">{{ tileId.key }}
                                :</span>
                            <span class="coord-span">{{ tileId.value }}</span>
                        </div>
                    </ng-container>
                </div>
            </p-card>
            <p-button *ngIf="isMarkerEnabled && markerPosition"
                      (click)="mapService.moveToWgs84PositionTopic.next(markerPosition)"
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
        }
        
        .coord-span {
            text-align: right;
            font-family: monospace;
        }

        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 4em;
                padding-bottom: 0;
            }
        }
    `]
})
export class CoordinatesPanelComponent {

    longitude: number | undefined = undefined;
    latitude: number | undefined = undefined;
    isMarkerEnabled: boolean = false;
    markerPosition: {x: number, y: number} | null = null;
    auxiliaryCoordinates: Map<string, Array<number>> = new Map<string, Array<number>>();
    mapgetTileIds: Map<string, bigint> = new Map<string, bigint>();
    auxiliaryTileIds: Map<string, bigint> = new Map<string, bigint>();
    markerButtonIcon: string = "location_off";
    markerButtonTooltip: string = "Enable marker placement";
    displayOptions: Array<PanelOption> = [{name: "WGS84"}];
    selectedOptions: Array<PanelOption> = [{name: "WGS84"}];

    constructor(public mapService: MapService,
                public coordinatesService: CoordinatesService,
                public clipboardService: ClipboardService,
                public inspectionService: InspectionService,
                public parametersService: ParametersService) {
        for (let level = 0; level <= 15; level++) {
            this.displayOptions.push({name: `Mapget TileId (level ${level})`});
        }
        this.parametersService.parameters.subscribe(parameters => {
            this.isMarkerEnabled = parameters.marker;
            if (parameters.markedPosition.length == 2) {
                this.longitude = parameters.markedPosition[0];
                this.latitude = parameters.markedPosition[1];
                if (this.isMarkerEnabled) {
                    this.markerPosition = {x: this.longitude, y: this.latitude};
                    this.markerButtonIcon = "wrong_location";
                    this.markerButtonTooltip = "Reset marker";
                }
                this.updateValues();
            } else {
                if (this.isMarkerEnabled) {
                    this.markerButtonIcon = "location_on";
                    this.markerButtonTooltip = "Disable marker placement";
                }
                this.markerPosition = null;
                this.updateValues();
            }
            this.restoreSelectedOptions();
        });

        this.coordinatesService.mouseMoveCoordinates.subscribe(coordinates => {
            if (!this.markerPosition && coordinates) {
                this.longitude = CesiumMath.toDegrees(coordinates.longitude);
                this.latitude = CesiumMath.toDegrees(coordinates.latitude);
                this.updateValues();
            }
            this.restoreSelectedOptions();
        });
    }

    private restoreSelectedOptions() {
        for (const option of this.parametersService.getCoordinatesAndTileIds()) {
            if (!this.isSelectedOption(option) && this.displayOptions.some(val => val.name == option)) {
                this.selectedOptions.push({name: option});
            }
        }
    }

    private updateValues() {
        if (this.coordinatesService.auxiliaryCoordinatesFun) {
            if (this.longitude !== undefined && this.latitude !== undefined) {
                this.auxiliaryCoordinates =
                    this.coordinatesService.auxiliaryCoordinatesFun(this.longitude, this.latitude).reduce(
                        (map: Map<string, Array<number>>, [key, value]: [string, Array<number>]) => {
                            map.set(key, value);
                            return map;
                        }, new Map<string, Array<number>>());
                for (const key of this.auxiliaryCoordinates.keys()) {
                    if (!this.displayOptions.some(val => val.name == key)) {
                        this.displayOptions.push({name: `${key}`});
                    }
                }
            }
        }
        if (this.longitude !== undefined && this.latitude !== undefined) {
            for (let level = 0; level <= 15; level++) {
                this.mapgetTileIds.set(`Mapget TileId (level ${level})`,
                    coreLib.getTileIdFromPosition(this.longitude, this.latitude, level));

            }
        }
        if (this.coordinatesService.auxiliaryTileIdsFun) {
            if (this.longitude !== undefined && this.latitude !== undefined) {
                for (let level = 0; level <= 15; level++) {
                const levelData: Map<string, bigint> =
                    this.coordinatesService.auxiliaryTileIdsFun(this.longitude, this.latitude, level).reduce(
                        (map: Map<string, bigint>, [key, value]: [string, bigint]) => {
                            map.set(key, value);
                            return map;
                        }, new Map<string, bigint>());

                levelData.forEach((value, key) => {
                    this.auxiliaryTileIds.set(`${key} (level ${level})`, value);
                });
                }
                for (const key of this.auxiliaryTileIds.keys()) {
                    if (!this.displayOptions.some(val => val.name == key)) {
                        this.displayOptions.push({name: key});
                    }
                }
            }
        }
    }

    toggleMarker() {
        if (!this.isMarkerEnabled) {
            this.isMarkerEnabled = true;
            this.parametersService.setMarkerState(true);
            this.parametersService.setMarkerPosition(null);
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
            this.markerPosition = null;
            this.parametersService.setMarkerState(true);
            this.parametersService.setMarkerPosition(null);
            this.markerButtonIcon = "wrong_location";
            this.markerButtonTooltip = "Reset marker";
        }
    }

    copyToClipboard(coordArray: Array<number>) {
        this.clipboardService.copyToClipboard(coordArray.join(" "));
    }

    isSelectedOption(name: string) {
        return this.selectedOptions.some(val => val.name == name);
    }

    updateSelectedOptions() {
        this.parametersService.setCoordinatesAndTileIds(this.selectedOptions.reduce(
            (array: Array<string>, option) => {
            array.push(option.name);
            return array;
        }, new Array<string>()));
    }

    compareLevels(a: KeyValue<string, bigint> , b: KeyValue<string, bigint>): number {
        const aLevel = parseInt(a.key.match(/\d+/)?.[0] ?? '0', 10);
        const bLevel = parseInt(b.key.match(/\d+/)?.[0] ?? '0', 10);

        return aLevel - bLevel;
    }
}