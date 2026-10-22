/**
 * Version labels shown by the About dialog and diagnostics. These AppState
 * values keep their deployed storage keys; fetching deployment configuration
 * and loading extension modules remain in AppConfigService.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { AppStateService } from "../state/app-state.service";

@Injectable({ providedIn: "root" })
export class AppConfigStore {
    constructor(private readonly persistence: AppStateService) { }

    readonly distributionVersions = this.persistence.registerState<Versions[]>({
        name: 'distributionVersions',
        defaultValue: [],
        schema: z.array(z.record(z.string(), z.string()))
    });

    readonly erdblickVersion = this.persistence.registerState<string>({
        name: 'erdblickVersion',
        defaultValue: "",
        schema: z.string()
    });
}

/** Published version labels retain their deployed persistence keys. */
export interface Versions {
    name: string;
    tag: string;
    whatsnew?: string;
}
