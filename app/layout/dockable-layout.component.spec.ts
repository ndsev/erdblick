import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {stateOwners, testPersistence} from "../../test/state-owners";
import {DockableLayoutComponent} from "./dockable-layout.component";

describe("Map attribution", () => {
    it.each([false, true])("keeps the full first notice, including notices loaded before the layout: %s", alreadyLoaded => {
        const notice = "Derived from Swiss survey data; copyright and additional licensing terms";
        const mapInfo = {
            legalInformationPerMap: new Map<string, Set<string>>(),
            legalInformationUpdated: new Subject<boolean>()
        };
        if (alreadyLoaded) mapInfo.legalInformationPerMap.set("Example map", new Set([notice]));
        const persistence = testPersistence();
        const owners = stateOwners(persistence);
        const layout = new DockableLayoutComponent(
            persistence,
            {} as never,
            {} as never,
            {sessionsChanged: new Subject<void>()} as never,
            {markForCheck: vi.fn()} as never,
            {} as never,
            mapInfo as never,
            owners.layout,
            owners.inspectionState.model
        );
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
