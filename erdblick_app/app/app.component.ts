import {Component} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {ParametersService} from "./parameters.service";
import {OverlayPanel} from "primeng/overlaypanel";
import {StyleService} from "./style.service";

@Component({
    selector: 'app-root',
    template: `
        <erdblick-view></erdblick-view>
        <map-panel></map-panel>
        <p-toast position="bottom-center" key="tc"></p-toast>
        <p-overlayPanel #searchoverlay>
            <search-menu-items></search-menu-items>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" 
                   (click)="toggleOverlay(searchValue, searchoverlay, $event)" 
                   (ngModelChange)="setTargetValue(searchValue)"/>
        </span>
        <pref-components></pref-components>
        <inspection-panel></inspection-panel>
        <div id="info">
            {{title}} {{version}}
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
    firstParamUpdate: boolean = true;

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
        this.activatedRoute.queryParams.subscribe((params: Params) => {
            this.parametersService.parseAndApplyParams(params, this.firstParamUpdate);
            if (this.firstParamUpdate) {
                this.firstParamUpdate = false;
                this.mapService.update();
                this.styleService.reapplyAllStyles();
            }
            setTimeout(() => { this.parametersService.viewportToBeUpdated.next(true) }, 1000);
        });

        this.parametersService.parameters.subscribe(parameters => {
            const entries = [...Object.entries(parameters)];
            entries.forEach(entry => entry[1] = JSON.stringify(entry[1]));
            this.updateQueryParams(Object.fromEntries(entries));
        });
    }

    toggleOverlay(value: string, searchOverlay: OverlayPanel, event: any) {
        if (value) {
            searchOverlay.show(event);
            return;
        }
        searchOverlay.toggle(event);
    }

    setTargetValue(value: string) {
        this.jumpToTargetService.targetValueSubject.next(value);
    }

    updateQueryParams(params: Params): void {
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl: true
        });
    }
}
