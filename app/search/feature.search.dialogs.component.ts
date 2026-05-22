import {Component} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";

@Component({
    selector: "feature-search-dialogs",
    template: `
        @for (session of searchService.getUndockedSessions(); track session.id) {
            <feature-search [searchId]="session.id"></feature-search>
        }
    `,
    styles: [``],
    standalone: false
})
/** Renders all feature-search sessions that are currently floating dialogs. */
export class FeatureSearchDialogsComponent {
    constructor(public searchService: FeatureSearchService) {}
}
