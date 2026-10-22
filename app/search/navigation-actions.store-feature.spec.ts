import {Injector} from "@angular/core";
import {signalStore} from "@ngrx/signals";
import {firstValueFrom, of} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {SearchTarget} from "../actions/omnibar";
import {withViewerActions} from "../actions/viewer-actions.store-feature";
import {CoordinateJumpService} from "./coordinate-jump.service";
import {ExternalViewerService} from "./external-viewer.service";
import {JumpTargetService} from "./jump.service";
import {LocationNavigationService} from "./location-navigation.service";
import {withNavigationActions} from "./navigation-actions.store-feature";

const NavigationStore = signalStore(withNavigationActions(), withViewerActions());

/** Minimal provider result; the owning service supplies real labels and input validation. */
function target(id: string): SearchTarget {
    return {id, icon: "", color: "", name: id, label: id, enabled: true, validate: () => true};
}

describe("native navigation operations", () => {
    let injector: ReturnType<typeof Injector.create>;
    afterEach(() => injector?.destroy());

    it("discovers all local operations without constructing any navigation engine", () => {
        injector = Injector.create({providers: [NavigationStore]});
        const store = injector.get(NavigationStore);
        expect(store.actionCatalog.declarations
            .filter((declaration) => declaration.exposure === "omnibar")
            .map((declaration) => declaration.name)
            .sort()).toEqual([
            "omnibar_coordinates",
            "omnibar_external_viewer",
            "omnibar_feature_jump",
            "omnibar_jump_plugin",
            "omnibar_location",
            "omnibar_source_data"
        ]);
    });

    it("automatically collects lazy providers in the existing menu order and queries locations separately", async () => {
        const coordinates = vi.fn(() => ({targets: vi.fn(() => [target("coordinate")])}));
        const external = vi.fn(() => ({targets: vi.fn(() => [target("external")])}));
        const jumps = vi.fn(() => ({getJumpTargetsForValue: vi.fn(() => [target("jump")])}));
        const locations = vi.fn(() => ({searchTargets: vi.fn(() => of([target("location")]))}));
        injector = Injector.create({providers: [
            NavigationStore,
            {provide: CoordinateJumpService, useFactory: coordinates},
            {provide: ExternalViewerService, useFactory: external},
            {provide: JumpTargetService, useFactory: jumps},
            {provide: LocationNavigationService, useFactory: locations}
        ]});
        const store = injector.get(NavigationStore);
        expect([coordinates, external, jumps, locations].every((factory) => !factory.mock.calls.length)).toBe(true);

        expect(store.actionCatalog.omnibarTargets("Berlin").map((entry) => entry.id)).toEqual([
            "jump", "coordinate", "external"
        ]);
        expect(locations).not.toHaveBeenCalled();
        expect((await firstValueFrom(store.actionCatalog.asyncOmnibarTargets("Berlin"))).map((entry) => entry.id))
            .toEqual(["location"]);
        expect(injector.get(LocationNavigationService).searchTargets).toHaveBeenCalledExactlyOnceWith("Berlin");
    });

    it("runs a current external-viewer candidate synchronously and rejects a stale candidate", async () => {
        const openExternalViewer = vi.fn();
        const createExternal = vi.fn(() => ({openExternalViewer}));
        injector = Injector.create({providers: [
            NavigationStore,
            {provide: ExternalViewerService, useFactory: createExternal}
        ]});
        const store = injector.get(NavigationStore);
        let current = true;
        const candidate = store.actionCatalog.candidate(store.openExternalViewer, {
            ...target("external"),
            arguments: {providerId: "osm", location: {lat: 52.5, lon: 13.4}},
            isCurrent: () => current
        });
        expect(createExternal).not.toHaveBeenCalled();

        const running = candidate.execute!("");
        expect(openExternalViewer).toHaveBeenCalledExactlyOnceWith({
            providerId: "osm", location: {lat: 52.5, lon: 13.4}
        });
        await running;

        current = false;
        await expect(candidate.execute!("")).rejects.toThrow(/no longer available/);
        expect(openExternalViewer).toHaveBeenCalledTimes(1);
    });
});
