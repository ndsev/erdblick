import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {LocateResponse} from "./visualization.model";
import {InfoMessageService} from "./info.service";
import {coreLib} from "./wasm";
import {FeatureSearchService} from "./feature.search.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";

export interface SearchTarget {
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
                    name: `Jump to ${fjt.name}`,
                    label: label,
                    enabled: !fjt.error,
                    execute: (_: string) => { this.jumpToFeature(fjt).then(); },
                    validate: (_: string) => { return !fjt.error; },
                }
            });
        }

        this.jumpTargets.next([
            this.getFeatureMatchTarget(),
            ...featureJumpTargetsConverted,
            ...this.extJumpTargets
        ]);
    }

    async highlightFeature(mapId: string, featureId: string) {
        let featureJumpTargets = this.mapService.tileParser?.filterFeatureJumpTargets(featureId) as Array<FeatureJumpAction>;
        const validIndex = featureJumpTargets.findIndex(action => !action.error);
        if (validIndex == -1) {
            console.error(`Error highlighting ${featureId}!`);
            return;
        }
        await this.jumpToFeature(featureJumpTargets[validIndex], false, mapId);
    }

    async jumpToFeature(action: FeatureJumpAction, moveCamera: boolean=true, mapId?:string|null) {
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
        await this.mapService.selectFeature(
            selectThisFeature.tileId,
            selectThisFeature.typeId,
            selectThisFeature.featureId,
            moveCamera);
    }
}