import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {HttpClient} from "@angular/common/http";

export interface JumpTarget {
    name: string;
    label: string;
    enabled: boolean;
    jump: (value: string) => number[] | undefined;
    validate: (value: string) => boolean;
}

@Injectable({providedIn: 'root'})
export class JumpTargetService {

    targetValueSubject = new Subject<string>();
    availableOptions = new Subject<Array<JumpTarget>>();

    constructor(private httpClient: HttpClient) {
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
                                    this.availableOptions.next(jumpTargets);
                                }).catch((error) => {
                                    this.availableOptions.next([]);
                                    console.log(error);
                                });
                                return;
                            }
                        }
                        this.availableOptions.next([]);
                    } catch (error) {
                        this.availableOptions.next([]);
                        console.log(error);
                    }
                },
                error: error => {
                    this.availableOptions.next([]);
                    console.log(error);
                }
            });
    }
}