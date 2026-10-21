import "@angular/compiler";
import {Component, input, OnDestroy} from "@angular/core";
import {TestBed} from "@angular/core/testing";
import {SplitterModule} from "primeng/splitter";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {ViewerUiService} from "../actions/viewer-ui.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppLayoutService} from "../shared/app-layout.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MapViewStateService} from "./map-view-state.service";
import {MapViewService} from "./map-view.service";
import {MapViewContainerComponent} from "./view.container.component";

let nextInstance = 0;
const destroyedInstances: number[] = [];

/** Real splitter panels with lightweight children so layout lifecycle needs no WebGL context. */
@Component({
    selector: "map-view",
    template: `<span class="test-view" [attr.data-view-id]="viewId()" [attr.data-instance]="instance"></span>`
})
class TestMapViewComponent implements OnDestroy {
    readonly viewId = input.required<string>();
    readonly instance = ++nextInstance;

    ngOnDestroy(): void {
        destroyedInstances.push(this.instance);
    }
}

afterEach(() => TestBed.resetTestingModule());

describe("map splitter view membership", () => {
    it("displays the new ID order and retires old panels on same-count reorder", async () => {
        destroyedInstances.length = 0;
        const owners = ownerTestInjector([
            MapViewStateService, MapViewService, AppLayoutService,
            {provide: AppConfigService, useValue: {}},
            {provide: MapTileStreamService, useValue: {}},
            {provide: MapInfoService, useValue: {
                maps: {maps: new Map()}, layerStateChanged: new Subject<string>(),
                reapplySyncOptionsForAllViews: vi.fn()
            }}
        ]);
        const views = owners.get(MapViewStateService);
        views.numViews = 2;
        const [left, right] = views.viewIds();
        await TestBed.configureTestingModule({
            declarations: [MapViewContainerComponent],
            imports: [SplitterModule, TestMapViewComponent],
            providers: [
                {provide: MapViewStateService, useValue: views},
                {provide: MapViewService, useValue: owners.get(MapViewService)},
                {provide: AppLayoutService, useValue: owners.get(AppLayoutService)},
                {provide: KeyboardService, useValue: {registerShortcut() {}, unregisterShortcut() {}}},
                {provide: ViewerUiService, useValue: {registerResizeTarget: () => () => {}}}
            ]
        }).compileComponents();
        const component = TestBed.createComponent(MapViewContainerComponent);
        component.detectChanges();
        const panels = () => Array.from(component.nativeElement.querySelectorAll(".test-view")) as HTMLElement[];
        expect(panels().map(panel => panel.dataset["viewId"])).toEqual([left, right]);
        const instances = panels().map(panel => Number(panel.dataset["instance"]));

        views.reorderViews([right, left]);
        component.detectChanges();

        expect(panels().map(panel => panel.dataset["viewId"])).toEqual([right, left]);
        expect(destroyedInstances).toEqual(expect.arrayContaining(instances));
        expect(panels().every(panel => !instances.includes(Number(panel.dataset["instance"])))).toBe(true);
        component.destroy();
    });
});
