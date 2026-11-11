/** Attribution follows the same effective backgrounds that the renderer uses. */
import "@angular/compiler";
import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";
import { AppConfigService } from "../../../app/config/appconfig.service";
import { LegalInfoService } from "../../../app/mapdata/legalinfo.service";
import { MapViewState } from "../../../app/mapview/mapview.state";
import { DEFAULT_BACKGROUND_LAYERS } from "../../../app/mapview/background-layer.model";
import { testPersistence } from "../../support/state-owners";

/** Real view state and configuration publication, without network or rendering. */
function fixture() {
    const persistence = testPersistence();
    const views = new MapViewState(persistence);
    persistence.sealRegistration();
    const config = new AppConfigService({} as never);
    const maps = {
        legalInformationPerMap: new Map<string, Set<string>>(),
        legalInformationUpdated: new Subject<boolean>()
    };
    const legal = new LegalInfoService(maps as never, config, views, persistence);
    return { persistence, views, config, maps, legal };
}

describe("LegalInfoService", () => {
    it("credits backgrounds across split views, deduplicating shared notices at the map edge", () => {
        const f = fixture();
        f.config["configSubject"].next({
            ...f.config.snapshot,
            backgroundLayers: [
                ...DEFAULT_BACKGROUND_LAYERS,
                { ...DEFAULT_BACKGROUND_LAYERS[0], id: "survey", name: "Survey", attribution: "Survey imagery" }
            ]
        });
        f.maps.legalInformationPerMap.set("Survey map", new Set(["Survey imagery"]));
        const credits: string[] = [];
        const sources: string[][] = [];
        const creditSubscription = f.legal.attribution$.subscribe(value => credits.push(value));
        const entrySubscription = f.legal.entries$.subscribe(entries => sources.push(entries.map(entry => entry.source)));
        try {
            f.persistence.transaction(() => {
                f.views.numViews = 2;
                f.views.setBackgroundState(1, "survey", 50);
            });
            expect(credits.at(-1)).toBe("Survey imagery · © OpenStreetMap contributors");
            expect(sources.at(-1)).toEqual([
                "Survey map", "OpenStreetMap (background imagery)", "Survey (background imagery)"
            ]);
            // The completed edit publishes once, without an intermediate copied
            // background when the new view is first seeded from the old one.
            expect(sources).toHaveLength(2);

            f.views.setBackgroundState(0, "survey", 75);
            expect(credits.at(-1)).toBe("Survey imagery");
            expect(sources.at(-1)).toEqual(["Survey map", "Survey (background imagery)"]);
            f.views.setBackgroundState(0, null, 75);
            f.views.numViews = 1;
            expect(sources.at(-1)).toEqual(["Survey map"]);
        } finally {
            creditSubscription.unsubscribe();
            entrySubscription.unsubscribe();
        }
    });

    it("updates config credits and uses fallback backgrounds without crediting invisible imagery", () => {
        const f = fixture();
        const credits: string[] = [];
        const subscription = f.legal.attribution$.subscribe(value => credits.push(value));
        try {
            f.views.setBackgroundState(0, "removed", 60);
            expect(credits.at(-1)).toBe("© OpenStreetMap contributors");
            f.config["configSubject"].next({
                ...f.config.snapshot,
                defaultBackgroundLayerId: "new",
                backgroundLayers: [{
                    ...DEFAULT_BACKGROUND_LAYERS[0], id: "new", name: "New", attribution: "New imagery terms"
                }]
            });
            expect(credits.at(-1)).toBe("New imagery terms");
            f.views.setBackgroundState(0, "new", 0);
            expect(credits.at(-1)).toBe("");
            f.views.setBackgroundState(0, null, 100);
            expect(credits.at(-1)).toBe("");
        } finally {
            subscription.unsubscribe();
        }
    });
});
