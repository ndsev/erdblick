import {
    AfterViewInit,
    Component,
    computed,
    ElementRef,
    input,
    InputSignal,
    OnDestroy,
    Signal,
    ViewChild
} from "@angular/core";
import {KeyboardService} from "../shared/keyboard.service";
import {AppModeService} from "../shared/app-mode.service";
import {CesiumMath} from "../integrations/cesium";
import {MapView} from "./view";
import {AppStateService} from "../shared/appstate.service";
import {toObservable, toSignal} from "@angular/core/rxjs-interop";
import {Observable, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {SceneMode} from "../integrations/cesium";

@Component({
    selector: 'erdblick-view-ui',
    template: `
        @if (!appModeService.isVisualizationOnly) {
            <div class="view-ui-container" [ngClass]="{'mirrored': isPrimary()}">
                <div class="navigation-controls">
                    <div class="nav-control-group">
                        <p-button icon="pi pi-plus" (onClick)="mapView()?.zoomIn()" [rounded]="true" severity="secondary"
                                  size="small" pTooltip="Zoom In (Q)" class="move-button"></p-button>
                        <p-button icon="pi pi-minus" (onClick)="mapView()?.zoomOut()" [rounded]="true" severity="secondary"
                                  size="small" pTooltip="Zoom Out (E)" class="move-button"></p-button>
                    </div>
                    <div class="nav-control-group">
                        <p-button icon="pi pi-arrow-up" (onClick)="mapView()?.moveUp()" [rounded]="true" severity="secondary"
                                  size="small" pTooltip="Move Up (W)" class="move-button"></p-button>
                        <div class="nav-horizontal">
                            <p-button icon="pi pi-arrow-left" (onClick)="mapView()?.moveLeft()" [rounded]="true"
                                      severity="secondary" size="small" pTooltip="Move Left (A)" class="move-button"></p-button>
                            <p-button icon="pi pi-arrow-right" (onClick)="mapView()?.moveRight()" [rounded]="true"
                                      severity="secondary" size="small" pTooltip="Move Right (D)" class="move-button"></p-button>
                        </div>
                        <p-button icon="pi pi-arrow-down" (onClick)="mapView()?.moveDown()" [rounded]="true"
                                  severity="secondary" size="small" pTooltip="Move Down (S)" class="move-button"></p-button>
                    </div>
                </div>
                <div class="compass-circle" (click)="mapView()?.resetOrientation()" pTooltip="Reset Orientation (R)">
                    <div class="compass-label north">N</div>
                    <div class="compass-label east">E</div>
                    <div class="compass-label south">S</div>
                    <div class="compass-label west">W</div>
                    <div class="compass-needle" #compassNeedle (click)="mapView()?.resetOrientation()"></div>
                </div>
                <div class="scene-mode-toggle">
                    <p-selectButton [options]="projectionOptions" [(ngModel)]="projection"
                                    (ngModelChange)="toggleSceneMode()" optionLabel="mode">
                        <ng-template #item let-item>
                            <span class="material-symbols-outlined">{{ item.icon }}</span>
                        </ng-template>
                    </p-selectButton>
                </div>
            </div>
        }
    `,
    styles: [``],
    standalone: false
})
export class ErdblickViewUIComponent implements AfterViewInit, OnDestroy {
    @ViewChild('compassNeedle', {static: false}) needleRef!: ElementRef<HTMLElement>;

    mapView: InputSignal<MapView | undefined> = input<MapView | undefined>(undefined);
    is2D: InputSignal<boolean> = input<boolean>(false);
    private readonly numViews: Signal<number>;
    readonly isPrimary = computed(() => {
        const mapView = this.mapView();
        if (!mapView) {
            return false;
        }
        return this.numViews() > 1 && mapView.viewIndex === 0;
    });
    projectionOptions: {icon: string, mode: string}[] = [
        { icon: '3d', mode: '3D projection' },
        { icon: '2d', mode: '2D projection' },
    ];
    projection: {icon: string, mode: string} = this.projectionOptions[0];

    private mapViewSubscription = new Subscription();
    private mapView$: Observable<MapView | undefined>;

    constructor(public appModeService: AppModeService,
                public stateService: AppStateService,
                private keyboardService: KeyboardService) {
        this.numViews = toSignal(this.stateService.numViewsState, {initialValue: this.stateService.numViewsState.getValue()});
        this.mapView$ = toObservable(this.mapView);
    }

    ngAfterViewInit(): void {
        const needle = this.needleRef.nativeElement;
        this.mapViewSubscription.add(this.mapView$.pipe(
            filter(mv=> mv !== undefined)).subscribe(mapView => {
                this.projection = mapView?.getSceneMode() === SceneMode.SCENE2D ?
                    { icon: '2d', mode: '2D projection' } :
                    { icon: '3d', mode: '3D projection' };
                let currentRotationDeg = 0;
                mapView.viewer.clock.onTick.addEventListener(() => {
                    if (needle && mapView.isAvailable()) {
                        let headingDeg = CesiumMath.toDegrees(mapView.viewer.camera.heading);
                        headingDeg = (headingDeg % 360 + 360) % 360; // Normalize the heading to [0, 360)

                        // Calculate the shortest rotation direction (avoid needle spinning unnecessarily)
                        let delta = headingDeg - currentRotationDeg;
                        if (delta > 180) {
                            delta -= 360;
                        } else if (delta < -180) {
                            delta += 360;
                        }

                        // Apply a smoothing factor (adjusts speed; lower means slower/smoother)
                        currentRotationDeg += delta * 0.4;
                        currentRotationDeg = (currentRotationDeg % 360 + 360) % 360;
                        needle.style.transform = `rotate(${currentRotationDeg}deg)`;
                    }
                });
            })
        );

        this.keyboardService.registerShortcut('t', this.toggleSceneMode.bind(this), true);
    }

    ngOnDestroy(): void {
        this.mapViewSubscription.unsubscribe();
    }

    toggleSceneMode() {
        const mapView = this.mapView();
        if (!mapView) {
            return;
        }
        this.stateService.focusedView = mapView.viewIndex;
        const currentMode = this.stateService.mode2dState.getValue(mapView.viewIndex);
        this.stateService.setProjectionMode(mapView.viewIndex, !currentMode);
    }
}
