import {AfterViewInit, Component, Directive, ElementRef, HostListener, Renderer2, ViewChild} from "@angular/core";
import {Cartesian3} from "./cesium";
import {InfoMessageService} from "./info.service";
import {SearchTarget, JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {coreLib} from "./wasm";
import {ParametersService} from "./parameters.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {FeatureSearchService} from "./feature.search.service";
import {FeatureSearchComponent} from "./feature.search.component";
import {Dialog} from "primeng/dialog";
import {KeyboardService} from "./keyboard.service";

interface ExtendedSearchTarget extends SearchTarget {
    index: number;
}

@Directive({
    selector: '[onEnterClick]'
})
export class OnEnterClickDirective {
    constructor(private el: ElementRef, private renderer: Renderer2) {}

    @HostListener('keydown', ['$event'])
    handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            this.renderer.selectRootElement(this.el.nativeElement).click();
        }
    }
}

@Component({
    selector: 'search-panel',
    template: `
        <div class="search-wrapper">
            <div class="search-input">
                <!-- Expand on dialog show and collapse on dialog hide -->
                <textarea #textarea class="single-line" rows="1" pInputTextarea
                          [(ngModel)]="searchInputValue"
                          (click)="showSearchOverlay($event)"
                          (ngModelChange)="setSearchValue(searchInputValue)"
                          (keydown)="onKeydown($event)"
                          placeholder="Search">
                </textarea>
            </div>
            <div class="resizable-container" #searchcontrols>
                <p-dialog #actionsdialog class="search-menu-dialog" showHeader="false" [(visible)]="searchMenuVisible"
                          [position]="'top'" [draggable]="false" [resizable]="false" [appendTo]="searchcontrols" >
                    <div>
                        <div class="search-menu" *ngFor="let item of activeSearchItems">
                            <div onEnterClick (click)="targetToHistory(item.index)" class="search-option-wrapper"
                               [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle {{ item.color }}">
                                    <i class="pi {{ item.icon }}"></i>
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                        <div class="search-menu" *ngFor="let item of visibleSearchHistory; let i = index" >
                            <div onEnterClick (click)="selectHistoryEntry(i)" class="search-option-wrapper" tabindex="0">
                                <div class="icon-circle violet">
                                    <i class="pi pi-history"></i>
                                </div>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.input }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                        <div class="search-menu" *ngFor="let item of inactiveSearchItems; let i = index">
                            <div onEnterClick (click)="targetToHistory(i)" class="search-option-wrapper"
                                 [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle grey">
                                    <i class="pi {{ item.icon }}"></i>
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </p-dialog>
            </div>
        </div>
        
        <p-dialog header="Which map is the feature located in?" [(visible)]="mapSelectionVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" class="map-selection-dialog">
            <div *ngFor="let map of mapSelection; let i = index" style="width: 100%">
                <p-button [label]="map" type="button" (click)="setSelectedMap(map)"/>
            </div>
            <p-button label="Cancel" (click)="setSelectedMap(null)" severity="danger"/>
        </p-dialog>
        <feature-search></feature-search>
    `,
    styles: [`
        .item-disabled {
            color: darkgrey;
            pointer-events: none;
        }
    `]
})
export class SearchPanelComponent implements AfterViewInit {

    searchItems: Array<SearchTarget> = [];
    activeSearchItems: Array<ExtendedSearchTarget> = [];
    inactiveSearchItems: Array<SearchTarget> = [];
    searchInputValue: string = "";
    searchMenuVisible: boolean = false;
    searchHistory: Array<any> = [];
    visibleSearchHistory: Array<any> = [];

    mapSelectionVisible: boolean = false;
    mapSelection: Array<string> = [];

    @ViewChild('textarea') textarea!: ElementRef;
    @ViewChild('actionsdialog') dialog!: Dialog;
    cursorPosition: number = 0;

    public get staticTargets() {
        const targetsArray: Array<SearchTarget> = [];
        const value = this.searchInputValue.trim();
        let label = "tileId = ?";
        if (this.validateMapgetTileId(value)) {
            label = `tileId = ${value}`;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            icon: "pi-table",
            color: "green",
            name: "Mapget Tile ID",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.parseMapgetTileId(value) },
            validate: (value: string) => { return this.validateMapgetTileId(value) }
        });
        label = "lon = ? | lat = ? | (level = ?)"
        if (this.validateWGS84(value, true)) {
            const coords = this.parseWgs84Coordinates(value, true);
            if (coords !== undefined) {
                label = `lon = ${coords[0]} | lat = ${coords[1]}${coords.length === 3 && coords[3] ? ' | level = ' + coords[2] : ''}`;
            }
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lon-Lat Coordinates",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.parseWgs84Coordinates(value, true) },
            validate: (value: string) => { return this.validateWGS84(value, true) }
        });
        label = "lat = ? | lon = ? | (level = ?)"
        if (this.validateWGS84(value, false)) {
            const coords = this.parseWgs84Coordinates(value, true);
            if (coords !== undefined) {
                label = `lat = ${coords[0]} | lon = ${coords[1]}${coords.length === 3 && coords[3] ? ' | level = ' + coords[2] : ''}`;
            }
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lat-Lon Coordinates",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.parseWgs84Coordinates(value, false) },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });
        label = "lat = ? | lon = ?"
        if (this.validateWGS84(value, false)) {
            const coords = this.parseWgs84Coordinates(value, true);
            if (coords !== undefined) {
                label = `lat = ${coords[0]} | lon = ${coords[1]}`;
            }
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            icon: "pi-map-marker",
            color: "green",
            name: "Open WGS84 Lat-Lon in Google Maps",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.openInGM(value) },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });
        targetsArray.push({
            icon: "pi-map-marker",
            color: "green",
            name: "Open WGS84 Lat-Lon in Open Street Maps",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.openInOSM(value) },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });
        return targetsArray;
    }

    constructor(private renderer: Renderer2,
                public mapService: MapService,
                public parametersService: ParametersService,
                private keyboardService: KeyboardService,
                private messageService: InfoMessageService,
                private jumpToTargetService: JumpTargetService,
                private sidePanelService: SidePanelService) {

        this.keyboardService.registerShortcut("Ctrl+k", this.clickOnSearchToStart.bind(this));
        this.keyboardService.registerShortcut("Ctrl+K", this.clickOnSearchToStart.bind(this));

        this.jumpToTargetService.targetValueSubject.subscribe((event: string) => {
            this.validateMenuItems();
        });

        this.sidePanelService.observable().subscribe((panel)=>{
            this.searchMenuVisible = panel == SidePanelState.SEARCH;
        });

        this.jumpToTargetService.jumpTargets.subscribe((jumpTargets: Array<SearchTarget>) => {
            this.searchItems = [
                ...jumpTargets,
                ...this.staticTargets
            ];
        });

        jumpToTargetService.mapSelectionSubject.subscribe(maps => {
            this.mapSelection = maps;
            this.mapSelectionVisible = true;
        });

        this.parametersService.lastSearchHistoryEntry.subscribe(entry => {
            if (entry) {
                this.searchInputValue = entry[1];
                this.runTarget(entry[0]);
            }
            this.reloadSearchHistory();
        });

        this.reloadSearchHistory();
    }

    ngAfterViewInit() {
        this.dialog.onShow.subscribe(() => {
            setTimeout(() => {
                this.expandTextarea();
            }, 0);
        });

        this.dialog.onHide.subscribe(() => {
            setTimeout(() => {
                this.shrinkTextarea();
            }, 0);
        });
    }

    private reloadSearchHistory() {
        const searchHistoryString = localStorage.getItem("searchHistory");
        if (searchHistoryString) {
            const searchHistory = JSON.parse(searchHistoryString) as Array<[number, string]>;
            this.searchHistory = [];
            searchHistory.forEach(value => {
                if (0 <= value[0] && value[0] < this.searchItems.length) {
                    const item = this.searchItems[value[0]];
                    this.searchHistory.push({label: item.name, index: value[0], input: value[1]});
                }
            });
            this.visibleSearchHistory = this.searchHistory;
        }
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
        this.sidePanelService.panel = SidePanelState.NONE;
        if (coordinates === null) {
            return;
        }
        if (coordinates === undefined) {
            this.messageService.showError("Could not parse coordinates from the input.");
            return;
        }
        let lat = coordinates[0];
        let lon = coordinates[1];
        let alt = coordinates.length > 2 && coordinates[2] > 0 ? coordinates[2] : this.parametersService.parameters.getValue().alt;
        let position = Cartesian3.fromDegrees(lon, lat, alt);
        let orientation = this.parametersService.getCameraOrientation();
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
            item.enabled = this.searchInputValue != "" && item.validate(this.searchInputValue)
        );
    }

    validateMapgetTileId(value: string) {
        return value.length > 0 && !/\s/g.test(value.trim()) && !isNaN(+value.trim());
    }

    validateWGS84(value: string, isLonLat: boolean = false) {
        const coords = this.parseWgs84Coordinates(value, isLonLat);
        return coords !== undefined && coords[0] >= -90 && coords[0] <= 90 && coords[1] >= -180 && coords[1] <= 180;
    }

    showSearchOverlay(event: Event) {
        event.stopPropagation();
        this.sidePanelService.panel = SidePanelState.SEARCH;
        this.setSearchValue(this.searchInputValue);
    }

    setSearchValue(value: string) {
        this.searchInputValue = value;
        if (!value) {
            this.parametersService.setSearchHistoryState(null);
            this.jumpToTargetService.targetValueSubject.next(value);
            this.searchItems = [...this.jumpToTargetService.jumpTargets.getValue(), ...this.staticTargets];
            this.activeSearchItems = [];
            this.inactiveSearchItems = this.searchItems;
            this.visibleSearchHistory = this.searchHistory;
            return;
        }
        this.jumpToTargetService.targetValueSubject.next(value);
        this.activeSearchItems = [];
        this.inactiveSearchItems = [];
        for (let i = 0; i < this.searchItems.length; i++) {
            if (this.searchItems[i].validate(this.searchInputValue)) {
                const target = this.searchItems[i] as ExtendedSearchTarget;
                target.index = i;
                this.activeSearchItems.push(target);
            } else {
                this.inactiveSearchItems.push(this.searchItems[i]);
            }
        }
        // this.activeSearchItems = [
        //     ...this.jumpToTargetService.jumpTargets.getValue().filter(target => target.validate(value)),
        //     ...this.staticTargets.filter(target => target.validate(value))
        // ]
        this.visibleSearchHistory = Object.values(
            this.searchHistory.reduce((acc, obj) => {
                if (obj.input.includes(value)) {
                    const key = `${obj.label}-${obj.index}-${obj.input}`;
                    if (!acc[key]) {
                        acc[key] = obj;
                    }
                }
                return acc;
            }, {} as Record<string, typeof this.searchHistory[number]>)
        );
        // this.inactiveSearchItems = [
        //     ...this.jumpToTargetService.jumpTargets.getValue().filter(target => !target.validate(value)),
        //     ...this.staticTargets.filter(target => !target.validate(value))
        // ]
    }

    setSelectedMap(value: string|null) {
        this.jumpToTargetService.setSelectedMap!(value);
        this.mapSelectionVisible = false;
    }

    targetToHistory(index: number) {
        this.parametersService.setSearchHistoryState([index, this.searchInputValue]);
    }

    runTarget(index: number) {
        const item = this.searchItems[index];
        if (item.jump !== undefined) {
            const coord = item.jump(this.searchInputValue);
            this.jumpToWGS84(coord);
            if (coord !== undefined) {
                this.jumpToTargetService.markedPosition.next(coord);
            }
            return;
        }

        if (item.execute !== undefined) {
            item.execute(this.searchInputValue);
            return;
        }
    }

    onKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            if (this.searchInputValue.trim()) {
                this.parametersService.setSearchHistoryState([0, this.searchInputValue]);
            } else {
                this.parametersService.setSearchHistoryState(null);
            }
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            this.setSearchValue("");
        }
    }

    selectHistoryEntry(index: number) {
        const entry = this.searchHistory[index];
        if (entry.index !== undefined && entry.input !== undefined) {
            this.parametersService.setSearchHistoryState([entry.index, entry.input]);
        }
    }

    expandTextarea() {
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '3');
        this.renderer.removeClass(this.textarea.nativeElement, 'single-line');
        this.textarea.nativeElement.focus();
        this.textarea.nativeElement.setSelectionRange(this.cursorPosition, this.cursorPosition);
    }

    shrinkTextarea() {
        this.cursorPosition = this.textarea.nativeElement.selectionStart;
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '1');
        this.renderer.addClass(this.textarea.nativeElement, 'single-line');
    }

    clickOnSearchToStart() {
        this.setSearchValue("");
        this.cursorPosition = 0;
        this.textarea.nativeElement.click();
    }
}
