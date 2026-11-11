import {ChangeDetectorRef, Component, OnDestroy} from "@angular/core";
import {Subscription} from "rxjs";
import {SearchService} from "./search.service";

@Component({
    selector: "feature-search-dialogs",
    template: `
        @for (session of searchService.getUndockedSessions(); track session.id) {
            <feature-search [searchId]="session.id"></feature-search>
        }
    `,
    standalone: false
})
/** Renders all feature-search sessions that are currently floating dialogs. */
export class SearchDialogsComponent implements OnDestroy {
    private readonly sessionsSubscription: Subscription;

    constructor(public searchService: SearchService, cdr: ChangeDetectorRef) {
        // Async scene imports and MCP actions need an explicit zoneless render notification.
        this.sessionsSubscription = searchService.sessionsChanged.subscribe(() => cdr.markForCheck());
    }

    /** Removes the structural UI notification when the floating host is destroyed. */
    ngOnDestroy(): void {
        this.sessionsSubscription.unsubscribe();
    }
}
