import {Component} from "@angular/core";
import {WOF_LOCATION_ATTRIBUTION} from "./location-policy.model";

/** Source and license links shared by location preferences and the consent dialog. */
@Component({
    selector: "location-attribution",
    template: `
        <a [href]="credit.url" target="_blank" rel="noopener noreferrer">{{ credit.name }}</a>
        · <a [href]="credit.licenseUrl" target="_blank" rel="noopener noreferrer">License</a>
    `,
    standalone: false
})
export class LocationAttributionComponent {
    readonly credit = WOF_LOCATION_ATTRIBUTION;
}
