import {Component} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {ActivatedRoute, NavigationEnd, Params, Router} from "@angular/router";
import {ParametersService} from "./parameters.service";
import {StyleService} from "./style.service";
import {filter} from "rxjs";

@Component({
    selector: 'app-root',
    template: `
        <erdblick-view></erdblick-view>
        <map-panel></map-panel>
        <p-toast position="top-center" key="tc"></p-toast>
        <search-panel #searchoverlay></search-panel>
        <pref-components></pref-components>
        <inspection-panel></inspection-panel>
        <coordinates-panel></coordinates-panel>
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
    `]
})
export class AppComponent {

    title: string = 'erdblick';
    version: string = "v0.3.0";
    searchValue: string = ""

    constructor(private httpClient: HttpClient,
                private router: Router,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public styleService: StyleService,
                public jumpToTargetService: JumpTargetService,
                public parametersService: ParametersService) {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });
        this.init();
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
            const entries = [...Object.entries(parameters)];
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
}
