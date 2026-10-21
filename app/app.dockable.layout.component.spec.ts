import {runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../test/owner-test-injector";
import {AppLayoutService} from "./shared/app-layout.service";
import {InspectionStateService} from "./inspection/inspection-state.service";
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {BehaviorSubject, Subject} from "rxjs";
import {DockableLayoutComponent} from "./app.dockable.layout.component";

describe("Map attribution", () => {
    it.each([false, true])("keeps the full first notice, including notices loaded before the layout: %s", alreadyLoaded => {
        const notice = "Derived from Swiss survey data; copyright and additional licensing terms";
        const mapInfo = {
            legalInformationPerMap: new Map<string, Set<string>>(),
            legalInformationUpdated: new Subject<boolean>()
        };
        if (alreadyLoaded) mapInfo.legalInformationPerMap.set("Example map", new Set([notice]));
        const injector = ownerTestInjector([AppLayoutService, InspectionStateService]);
        const layout = runInInjectionContext(injector, () => new DockableLayoutComponent(
            {isDockOpen: false, dockOpenState: new BehaviorSubject(false)} as never,
            {} as never,
            {} as never,
            {sessionsChanged: new Subject<void>()} as never,
            {markForCheck: vi.fn()} as never,
            {} as never,
            mapInfo as never
        ));
        const values: string[] = [];
        const subscription = layout["copyright$"].subscribe(value => values.push(value));
        try {
            expect(values).toEqual([alreadyLoaded ? `© ${notice}` : ""]);
            mapInfo.legalInformationPerMap.set("Example map", new Set([notice, "Additional notice"]));
            mapInfo.legalInformationUpdated.next(true);
            expect(values.at(-1)).toBe(`© ${notice}`);
        } finally {
            subscription.unsubscribe();
            layout.ngOnDestroy();
        }
    });
});
