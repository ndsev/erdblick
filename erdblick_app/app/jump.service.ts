import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {LocateResponse} from "./visualization.model";
import {SidePanelService} from "./panel.service";

export interface JumpTarget {
    name: string;
    label: string;
    enabled: boolean;
    jump: (value: string) => number[] | undefined;
    validate: (value: string) => boolean;
}

@Injectable({providedIn: 'root'})
export class JumpTargetService {

    targetValueSubject = new BehaviorSubject<string>("");
    jumpTargets = new BehaviorSubject<Array<JumpTarget>>([]);
    extJumpTargets: Array<JumpTarget> = [];

    constructor(private httpClient: HttpClient, private mapService: MapService) {
        httpClient.get("/config.json", {responseType: 'json'}).subscribe(
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
            featureJumpTargetsConverted = featureJumpTargets.map((fjt: any) => {
                return {
                    name: `Jump to ${fjt.name}`,
                    label: JSON.stringify(fjt.idParts) + "<br>" + fjt.error,
                    enabled: !fjt.error,
                    jump: (value: string) => { return; },
                    validate: (value: string) => { return !fjt.error; },
                }
            });
        }
        this.jumpTargets.next([...this.extJumpTargets, ...featureJumpTargetsConverted]);
    }
}