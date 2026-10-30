import "@angular/compiler";
import {Subject} from "rxjs";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {SearchDialogsComponent} from "../../../app/search/search-dialogs.component";

describe("SearchDialogsComponent", () => {
    it("notifies zoneless rendering of asynchronous session changes and unsubscribes on teardown", () => {
        const sessionsChanged = new Subject<void>();
        const cdr = {markForCheck: vi.fn()};
        const host = new SearchDialogsComponent({sessionsChanged} as never, cdr as never);
        sessionsChanged.next();
        expect(cdr.markForCheck).toHaveBeenCalledTimes(1);
        host.ngOnDestroy();
        sessionsChanged.next();
        expect(cdr.markForCheck).toHaveBeenCalledTimes(1);
    });
});
