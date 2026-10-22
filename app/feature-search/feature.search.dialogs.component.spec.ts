import "@angular/compiler";
import {Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {FeatureSearchDialogsComponent} from "./feature.search.dialogs.component";

describe("FeatureSearchDialogsComponent", () => {
    it("notifies zoneless rendering of asynchronous session changes and unsubscribes on teardown", () => {
        const sessionsChanged = new Subject<void>();
        const cdr = {markForCheck: vi.fn()};
        const host = new FeatureSearchDialogsComponent({sessionsChanged} as never, cdr as never);
        sessionsChanged.next();
        expect(cdr.markForCheck).toHaveBeenCalledTimes(1);
        host.ngOnDestroy();
        sessionsChanged.next();
        expect(cdr.markForCheck).toHaveBeenCalledTimes(1);
    });
});
