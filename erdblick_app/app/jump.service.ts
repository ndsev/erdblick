import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {LocateResponse} from "./visualization.model";
import {InfoMessageService} from "./info.service";
import {coreLib} from "./wasm";
import {FeatureSearchService} from "./feature.search.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {HighlightMode} from "build/libs/core/erdblick-core";
import {InspectionService} from "./inspection.service";
import {RightClickMenuService} from "./rightclickmenu.service";

export interface SearchTarget {
    icon: string;
    color: string;
    name: string;
    label: string;
    enabled: boolean;
    jump?: (value: string) => number[] | undefined;
    execute?: (value: string) => void;
    validate: (value: string) => boolean;
}

interface FeatureJumpAction {
    name: string;
    error: string|null;
    idParts: Array<{key: string, value: string|number}>;
    maps: Array<string>;
}

@Injectable({providedIn: 'root'})
export class JumpTargetService {

    markedPosition: Subject<Array<number>> = new Subject<Array<number>>();
    targetValueSubject = new BehaviorSubject<string>("");
    jumpTargets = new BehaviorSubject<Array<SearchTarget>>([]);
    extJumpTargets: Array<SearchTarget> = [];

    // Communication channels with the map selection dialog (in SearchPanelComponent).
    // The mapSelectionSubject triggers the display of the dialog, and
    // the setSelectedMap promise resolver is used by the dialog to communicate the
    // user's choice.
    mapSelectionSubject = new Subject<Array<string>>();
    setSelectedMap: ((choice: string|null)=>void)|null = null;

    constructor(private httpClient: HttpClient,
                private mapService: MapService,
                private messageService: InfoMessageService,
                private sidePanelService: SidePanelService,
                private inspectionService: InspectionService,
                private menuService: RightClickMenuService,
                private searchService: FeatureSearchService) {
        this.httpClient.get("/config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["jumpTargets"]) {
                        let jumpTargetsConfig = data["extensionModules"]["jumpTargets"];
                        if (jumpTargetsConfig !== undefined) {
                            // Using string interpolation so webpack can trace imports from the location
                            import(`../../config/${jumpTargetsConfig}.js`).then(function (plugin) {
                                return plugin.default() as Array<SearchTarget>;
                            }).then((jumpTargets: Array<SearchTarget>) => {
                                this.extJumpTargets = jumpTargets;
                                this.update();
                            }).catch((error) => {
                                console.error(error);
                            });
                            return;
                        }
                    }
                } catch (error) {
                    console.error(error);
                }
            },
            error: error => {
                console.error(error);
            }
        });

        // Filter out feature jump targets based on search value.
        this.targetValueSubject.subscribe(_ => {
            this.update();
        })
    }

    getFeatureMatchTarget(): SearchTarget {
        let simfilError = '';
        try {
            coreLib.validateSimfilQuery(this.targetValueSubject.getValue());
        } catch (e: any) {
            const parsingError = e.message.split(':', 2);
            simfilError = parsingError.length > 1 ? parsingError[1] : parsingError[0];
        }
        let label = "Match features with a filter expression";
        if (simfilError) {
            label += `<br><span class="search-option-warning">${simfilError}</span>`;
        }
        return {
            icon: "pi-bolt",
            color: "blue",
            name: "Search Loaded Features",
            label: label,
            enabled: false,
            execute: (value: string) => {
                this.sidePanelService.panel = SidePanelState.FEATURESEARCH;
                this.searchService.run(value);
            },
            validate: (_: string) => {
                return !simfilError;
            }
        }
    }

    validateMapgetTileId(value: string) {
        return value.length > 0 && !/\s/g.test(value.trim()) && !isNaN(+value.trim());
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

    getInspectTileSourceDataTarget() {
        const searchString = this.targetValueSubject.getValue();
        let label = "tileId = ? | (mapId = ?) | (sourceLayerId = ?)";

        const matchSourceDataElements = (value: string) => {
            const regex = /^\s*(\d+)\s*(?:[,\s;]+)?\s*([^\s,;]*)\s*(?:[,\s;]+)?\s*([^\s,;]*)?\s*$/;
            const match = value.match(regex);
            let tileId: bigint | null = null;
            let mapId = null;
            let sourceLayerId = null;
            let valid = true;

            if (match) {
                const [_, bigintStr, str1, str2] = match;
                try {
                    tileId = BigInt(bigintStr);
                    valid = this.validateMapgetTileId(tileId.toString());
                } catch {
                    valid = false;
                }

                // TODO: check whether the mapId and layerId are valid
                if (str1) {
                    mapId = str1;
                }
                if (str2) {
                    sourceLayerId = str2;
                }
            } else {
                valid = false;
            }

            if (!tileId || !valid) {
                return null;
            }



            return [tileId, mapId, sourceLayerId]
        }

        const matches = matchSourceDataElements(searchString);
        if (matches) {
            const [tileId, mapId, sourceLayerId] = matches;
            if (tileId) {
                label = `tileId = ${tileId}`;
                if (mapId) {
                    label = `${label} | mapId = ${mapId}`;
                    if (sourceLayerId) {
                        label = `${label} | sourceLayerId = ${sourceLayerId}`;
                    } else {
                        label = `${label} | (sourceLayerId = ?)`;
                    }
                } else {
                    label = `${label} | (mapId = ?) | (sourceLayerId = ?)`
                }
            } else {
                label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
            }
        }

        return {
            icon: "pi-database",
            color: "red",
            name: "Inspect Mapget Tile",
            label: label,
            enabled: false,
            execute: (value: string) => {
                const matches = matchSourceDataElements(value);
                if (matches) {
                    const [tileId, mapId, sourceLayerId] = matches;
                    try {
                        if (tileId) {
                            if (mapId) {
                                if (sourceLayerId) {
                                    this.inspectionService.loadSourceDataInspection(
                                        Number(tileId),
                                        String(mapId),
                                        String(sourceLayerId)
                                    )
                                } else {
                                    this.menuService.customTileAndMapId.next([String(tileId), String(mapId)]);
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
            validate: (value: string) => {
                const matches = matchSourceDataElements(value);
                return matches && matches.length && matches[0];
            }
        }
    }

    update() {
        let featureJumpTargets = this.mapService.tileParser?.filterFeatureJumpTargets(this.targetValueSubject.getValue());
        let featureJumpTargetsConverted = [];
        if (featureJumpTargets) {
            featureJumpTargetsConverted = featureJumpTargets.map((fjt: FeatureJumpAction) => {
                let label = fjt.idParts.map(idPart => `${idPart.key}=${idPart.value}`).join(" | ")
                if (fjt.error) {
                    label += `<br><span class="search-option-warning">${fjt.error}</span>`;
                }
                return {
                    icon: "pi-arrow-down-left-and-arrow-up-right-to-center",
                    color: "orange",
                    name: `Jump to ${fjt.name}`,
                    label: label,
                    enabled: !fjt.error,
                    execute: (_: string) => {
                        if (fjt.name.toLowerCase().includes("tileid")) {

                        }
                        this.highlightByJumpTarget(fjt).then();
                    },
                    validate: (_: string) => { return !fjt.error; },
                }
            });
        }

        this.jumpTargets.next([
            this.getFeatureMatchTarget(),
            this.getInspectTileSourceDataTarget(),
            ...featureJumpTargetsConverted,
            ...this.extJumpTargets
        ]);
    }

    async highlightByJumpTargetFilter(mapId: string, featureId: string, mode: HighlightMode=coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
        let featureJumpTargets = this.mapService.tileParser?.filterFeatureJumpTargets(featureId) as Array<FeatureJumpAction>;
        const validIndex = featureJumpTargets.findIndex(action => !action.error);
        if (validIndex == -1) {
            console.error(`Error highlighting ${featureId}!`);
            return;
        }
        await this.highlightByJumpTarget(featureJumpTargets[validIndex], false, mapId, mode);
    }

    async highlightByJumpTarget(action: FeatureJumpAction, moveCamera: boolean=true, mapId?:string|null, mode: HighlightMode=coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
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
        if (!mapId) {
            return;
        }

        // Locate the feature.
        let resolveMe = {requests: [{
            typeId: action.name,
            mapId: mapId,
            featureId: action.idParts.map((kv) => [kv.key, kv.value]).flat()
        }]};
        let response = await fetch("/locate", {
            body: JSON.stringify(resolveMe),
            method: "POST"
        }).catch((err)=>console.error(`Error during /locate call: ${err}`));
        if (!response) {
            return;
        }
        let extRefsResolved = await response.json() as LocateResponse;
        if (extRefsResolved.responses[0].length < 1) {
            this.messageService.showError("Could not locate feature!")
            return;
        }
        let selectThisFeature = extRefsResolved.responses[0][0];

        // Set feature-to-select on MapService.
        const featureId = `${selectThisFeature.typeId}.${selectThisFeature.featureId.filter((_, index) => index % 2 === 1).join('.')}`;
        await this.mapService.highlightFeatures([{
            mapTileKey: selectThisFeature.tileId,
            featureId: featureId
        }], moveCamera, mode).then();
    }
}
