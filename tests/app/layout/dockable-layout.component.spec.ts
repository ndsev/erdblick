import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {Subject} from "rxjs";
import {stateOwners, testPersistence} from "../../support/state-owners";
import {DockableLayoutComponent} from "../../../app/layout/dockable-layout.component";
import {LegalInfoService} from "../../../app/mapdata/legalinfo.service";

describe("Map attribution", () => {
    it.each([false, true])("keeps complete map and imagery notices, including before layout creation: %s", alreadyLoaded => {
        const notice = "Derived from Swiss survey data; copyright and additional licensing terms";
        const mapInfo = {
            legalInformationPerMap: new Map<string, Set<string>>(),
            legalInformationUpdated: new Subject<boolean>()
        };
        if (alreadyLoaded) mapInfo.legalInformationPerMap.set("Example map", new Set([notice]));
        const persistence = testPersistence();
        const owners = stateOwners(persistence);
        const legalInfo = new LegalInfoService(mapInfo as never, owners.configService, owners.viewSettings, persistence);
        const layout = new DockableLayoutComponent(
            persistence,
            {} as never,
            {} as never,
            {sessionsChanged: new Subject<void>()} as never,
            {markForCheck: vi.fn()} as never,
            {} as never,
            legalInfo,
            owners.layout,
            owners.inspectionState.state
        );
        const values: string[] = [];
        const subscription = layout["copyright$"].subscribe(value => values.push(value));
        try {
            const imagery = "© OpenStreetMap contributors";
            expect(values).toEqual([alreadyLoaded ? `${notice} · ${imagery}` : imagery]);
            mapInfo.legalInformationPerMap.set("Example map", new Set([notice, "Additional notice"]));
            mapInfo.legalInformationUpdated.next(true);
            expect(values.at(-1)).toBe(`${notice} · Additional notice · ${imagery}`);
        } finally {
            subscription.unsubscribe();
            layout.ngOnDestroy();
        }
    });
});
