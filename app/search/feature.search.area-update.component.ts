import {Component} from "@angular/core";
import {environment} from "../environments/environment";
import {AppStateService} from "../shared/appstate.service";
import {FeatureSearchService} from "./feature.search.service";

@Component({
    selector: "feature-search-area-update",
    template: `
        @if (!environment.visualizationOnly
            && (searchService.areaUpdateAvailable | async)
            && !stateService.featureSearchAutoArea) {
            <div class="feature-search-area-update">
                <p-button icon="pi pi-refresh"
                          label="Update Search in Area"
                          data-testid="update-search-in-area-button"
                          (onClick)="searchService.updateSearchInArea()"/>
            </div>
        }
    `,
    standalone: false
})
export class FeatureSearchAreaUpdateComponent {
    protected readonly environment = environment;

    constructor(public searchService: FeatureSearchService,
                public stateService: AppStateService) {}
}
