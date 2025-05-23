import {Component} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {ActivatedRoute, NavigationEnd, Params, Router} from "@angular/router";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {filter} from "rxjs";
import {AppModeService} from "./app-mode.service";

@Component({
    selector: 'app-root',
    template: `
        <erdblick-view></erdblick-view>
        <map-panel *ngIf="!appModeService.isVisualizationOnly"></map-panel>
        <p-toast position="top-center" key="tc"></p-toast>
        <search-panel *ngIf="!appModeService.isVisualizationOnly"></search-panel>
        <inspection-panel *ngIf="!appModeService.isVisualizationOnly"></inspection-panel>
        <pref-components *ngIf="!appModeService.isVisualizationOnly"></pref-components>
        <coordinates-panel *ngIf="!appModeService.isVisualizationOnly"></coordinates-panel>
        <stats-dialog *ngIf="!appModeService.isVisualizationOnly"></stats-dialog>
        <legal-dialog></legal-dialog>
        <div *ngIf="copyright.length" id="copyright-info" (click)="openLegalInfo()">
            {{ copyright }}
        </div>
        <div id="info">
            {{ title }} {{ version }}
        </div>
        <router-outlet></router-outlet>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class AppComponent {

    title: string = "erdblick";
    version: string = "";
    copyright: string = "";

    constructor(private httpClient: HttpClient,
                private router: Router,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public appModeService: AppModeService,
                public parametersService: ParametersService) {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });
        this.init();
        this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = "";
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '.concat(firstSet.values().next().value as string).slice(0, 14).concat('…');
            }
        });
    }

    init() {
        this.router.events.subscribe()
        // Forward URL parameter changes to the ParameterService.
        this.router.events.pipe(
            // Filter the events to only include NavigationEnd events
            filter(event => event instanceof NavigationEnd)
        ).subscribe((event) => {
            this.parametersService.parseAndApplyQueryParams(this.activatedRoute.snapshot.queryParams);
        });

        // Forward ParameterService updates to the URL.
        this.parametersService.parameters.subscribe(parameters => {
            // Only forward new parameters into the query, if we have
            // parsed the initial values.
            if (!this.parametersService.initialQueryParamsSet) {
                return;
            }
            const entries = [...Object.entries(parameters)].filter(value =>
                this.parametersService.isUrlParameter(value[0])
            );
            entries.forEach(entry => entry[1] = JSON.stringify(entry[1]));
            this.updateQueryParams(Object.fromEntries(entries), this.parametersService.replaceUrl);
        });
    }

    updateQueryParams(params: Params, replaceUrl: boolean): void {
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl: replaceUrl
        });
    }

    openLegalInfo() {
        this.parametersService.legalInfoDialogVisible = true;
    }
}
