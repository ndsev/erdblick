import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {LocateResponse} from "./visualization.model";
import {InfoMessageService} from "./info.service";

export interface JumpTarget {
    name: string;
    label: string;
    enabled: boolean;
    jump: (value: string) => number[] | undefined;
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

    targetValueSubject = new BehaviorSubject<string>("");
    jumpTargets = new BehaviorSubject<Array<JumpTarget>>([]);
    extJumpTargets: Array<JumpTarget> = [];

    // Communication channels with the map selection dialog (in SearchPanelComponent).
    // The mapSelectionSubject triggers the display of the dialog, and
    // the setSelectedMap promise resolver is used by the dialog to communicate the
    // user's choice.
    mapSelectionSubject = new Subject<Array<string>>();
    setSelectedMap: ((choice: string|null)=>void)|null = null;

    constructor(private httpClient: HttpClient,
                private mapService: MapService,
                private messageService: InfoMessageService) {
        this.httpClient.get("/config.json", {responseType: 'json'}).subscribe(
            {
                next: (data: any) => {
                    try {
                        if (data && data["extensionModules"] && data["extensionModules"]["jumpTargets"]) {
                            let jumpTargetsConfig = data["extensionModules"]["jumpTargets"];
                            if (jumpTargetsConfig !== undefined) {
                                // Using string interpolation so webpack can trace imports from the location
                                import(`../../config/${jumpTargetsConfig}.js`).then(function (plugin) {
                                    return plugin.default() as Array<JumpTarget>;
                                }).then((jumpTargets: Array<JumpTarget>) => {
                                    this.extJumpTargets = jumpTargets;
                                    this.update();
                                }).catch((error) => {
                                    console.log(error);
                                });
                                return;
                            }
                        }
                    } catch (error) {
                        console.log(error);
                    }
                },
                error: error => {
                    console.log(error);
                }
            });

        // Filter out feature jump targets based on search value.
        this.targetValueSubject.subscribe(value => {
            this.update();
        })
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
                    jump: (value: string) => { this.jumpToFeature(fjt).then(); return null; },
                    validate: (value: string) => { return !fjt.error; },
                }
            });
        }
        this.jumpTargets.next([...this.extJumpTargets, ...featureJumpTargetsConverted]);
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