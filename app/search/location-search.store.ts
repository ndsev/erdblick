/**
 * The saved limit on displayed place-search results. The codec preserves the
 * existing config/storage key and clamps incoming values. Network requests
 * and result selection remain in the location-search controllers.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { AppStateService } from "../state/app-state.service";
import {
    clampLocationSearchResultLimit,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT
} from "./location-search.model";

@Injectable({ providedIn: "root" })
export class LocationSearchStore {
    constructor(private readonly persistence: AppStateService) { }

    readonly locationSearchResultLimitState = this.persistence.registerState<number>({
        name: 'locationSearchResultLimit',
        defaultValue: DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
        schema: z.coerce.number().int().min(1).max(MAX_LOCATION_SEARCH_RESULT_LIMIT),
        toStorage: (value: number) => clampLocationSearchResultLimit(value),
        fromStorage: (payload: any): number => clampLocationSearchResultLimit(payload)
    });

    get locationSearchResultLimit() { return this.locationSearchResultLimitState.getValue(); }

    set locationSearchResultLimit(val: number) { this.locationSearchResultLimitState.next(clampLocationSearchResultLimit(val)); }
}
