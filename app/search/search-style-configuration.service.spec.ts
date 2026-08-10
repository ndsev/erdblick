import {BehaviorSubject} from "rxjs";
import {describe, expect, it} from "vitest";

import {
    DEFAULT_SEARCH_STYLE_CONFIGURATION_STATE,
    SearchStyleConfigurationStateV1
} from "../shared/search-style-configuration-state";
import {SearchStyleConfigurationService} from "./search-style-configuration.service";

class AppStateStub {
    readonly searchStyleConfigurationsState = new BehaviorSubject(DEFAULT_SEARCH_STYLE_CONFIGURATION_STATE);
    featureSearches: any[] = [{id: "search", searchStyleRules: []}];

    get searchStyleConfigurations() {
        return this.searchStyleConfigurationsState.getValue();
    }

    set searchStyleConfigurations(value: SearchStyleConfigurationStateV1) {
        this.searchStyleConfigurationsState.next(value);
    }

    patchFeatureSearch(id: string, patch: Record<string, unknown>) {
        const entry = this.featureSearches.find(item => item.id === id);
        if (!entry) {
            return undefined;
        }
        Object.assign(entry, patch);
        return entry;
    }
}

describe("SearchStyleConfigurationService", () => {
    it("applies saved rules as a detached copy with revision provenance", () => {
        const state = new AppStateStub();
        const service = new SearchStyleConfigurationService(state as any);
        const created = service.create("Roads", [{
            geometry: "line",
            filter: [],
            color: {mode: "solid", color: "#112233"}
        }])!;

        expect(service.applyToFeatureSearch(created.id, "search")).toBe(true);
        const applied = state.featureSearches[0];
        expect(applied.searchStyleConfigurationId).toBe(created.id);
        expect(applied.searchStyleConfigurationRevision).toBe(1);

        applied.searchStyleRules[0].color.color = "#ffffff";
        expect(service.get(created.id)!.rules[0].color).toEqual({
            mode: "solid",
            color: "#112233"
        });
    });

    it("rejects a configuration that exceeds the bounded local-library budget", () => {
        const state = new AppStateStub();
        const service = new SearchStyleConfigurationService(state as any);
        const created = service.create("Oversized", [{
            geometry: "line",
            filter: [{field: "x".repeat(600_000), op: "=", value: true}],
            color: {mode: "solid", color: "#112233"}
        }]);

        expect(created).toBeUndefined();
        expect(state.searchStyleConfigurations.configurations).toHaveLength(0);
    });
});
