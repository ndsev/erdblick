import {DrawingState} from '../drawing/drawing.state';
import {ChangeDetectorRef} from '@angular/core';
import {MapViewService} from './mapview.service';
import {
    AfterViewInit,
    Component,
    computed,
    ElementRef,
    input,
    InputSignal,
    NgZone,
    OnDestroy,
    Signal,
    ViewChild
} from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { Observable, Subscription } from "rxjs";
import { filter } from "rxjs/operators";
import { AppModeService } from "../config/appmode.service";
import { AppStateService } from "../appstate/appstate.service";
import { KeyboardService } from "../keyboard/keyboard.service";
import { MapViewState } from "./mapview.state";
import { IRenderView } from "./render-view.model";

@Component({
    selector: 'erdblick-view-ui',
    template: `
        @if (!appModeService.isVisualizationOnly) {
            <button type="button" class="map-scale-toggle" [class.mirrored]="isPrimary()" [attr.aria-pressed]="scaleEnabled" (click)="toggleScale()">Map scale</button>
            @if (scaleEnabled && scale; as bar) { <div data-testid="map-scale" class="map-scale-bar" [class.mirrored]="isPrimary()" title="Local ground distance at this bar; varies with position and pitch">
                <span>{{bar.label}}</span>
                <div [style.width.px]="bar.width" style="height:5px;border:1px solid currentColor;border-top:0"></div>
            </div> }
            <div class="view-ui-container" [ngClass]="{'mirrored': isPrimary()}" [attr.data-testid]="viewUiTestId()">
                @if (!mapView()?.isFirstPersonViewActive()) {
                    <div class="navigation-controls">
                        <div class="nav-control-group">
                            <p-button icon="pi pi-plus" data-testid="zoom-in-button" (onClick)="mapView()?.zoomIn()" [rounded]="true" severity="secondary"
                                      size="small" pTooltip="Zoom In (Q)" class="move-button"></p-button>
                            <p-button icon="pi pi-minus" (onClick)="mapView()?.zoomOut()" [rounded]="true" severity="secondary"
                                      size="small" pTooltip="Zoom Out (E)" class="move-button"></p-button>
                        </div>
                        <div class="nav-control-group">
                            <p-button icon="pi pi-arrow-up" data-testid="move-up-button" (onClick)="mapView()?.moveUp()" [rounded]="true" severity="secondary"
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
                }
                <div class="compass-circle" (click)="mapView()?.resetOrientation()" pTooltip="Reset Orientation (R)">
                    <div class="compass-label north">N</div>
                    <div class="compass-label east">E</div>
                    <div class="compass-label south">S</div>
                    <div class="compass-label west">W</div>
                    <div class="compass-needle" #compassNeedle (click)="mapView()?.resetOrientation()"></div>
                </div>
                <div class="scene-mode-toggle" data-testid="scene-mode-toggle">
                    <p-selectButton [options]="projectionOptions" [(ngModel)]="projection"
                                    (ngModelChange)="toggleSceneMode()" optionLabel="mode">
                        <ng-template #item let-item>
                            <!-- <span class="material-symbols-outlined">{{ item.icon }}</span> -->
                            <span>{{ item.label }}</span>
                        </ng-template>
                    </p-selectButton>
                </div>
            </div>
        }
    `,
    standalone: false
})
/**
 * Overlay UI for one render view.
 * It hosts movement controls, projection toggles, and the animated compass bound to the active renderer.
 */
export class ErdblickViewUIComponent implements AfterViewInit, OnDestroy {
    @ViewChild('compassNeedle', { static: false }) needleRef!: ElementRef<HTMLElement>;

    mapView: InputSignal<IRenderView | undefined> = input<IRenderView | undefined>(undefined);
    is2D: InputSignal<boolean> = input<boolean>(false);
    private readonly numViews: Signal<number>;
    readonly isPrimary = computed(() => {
        const mapView = this.mapView();
        if (!mapView) {
            return false;
        }
        return this.numViews() > 1 && mapView.viewIndex === 0;
    });
    projectionOptions: { icon: string, label: string, mode: string }[] = [
        { icon: '3d', label: '3D', mode: '3D projection' },
        { icon: '2d', label: '2D', mode: '2D projection' },
    ];
    projection: { icon: string, label: string, mode: string } = this.projectionOptions[0];

    private mapViewSubscription = new Subscription();
    private mapView$: Observable<IRenderView | undefined>;
    private compassTickByView = new WeakMap<IRenderView, () => void>();

    /** Bridges the current renderer input signal into subscriptions used by the compass and projection toggle. */
    constructor(public appModeService: AppModeService,
        public stateService: AppStateService,
        private keyboardService: KeyboardService,
        private ngZone: NgZone,
        public readonly viewSettings: MapViewState, private readonly views: MapViewService, cdr: ChangeDetectorRef, private readonly drawingState: DrawingState) {
        this.numViews = toSignal(this.viewSettings.numViewsState, { initialValue: this.viewSettings.numViewsState.getValue() });
        this.mapView$ = toObservable(this.mapView);
        this.mapViewSubscription.add(drawingState.unit.subscribe(() => cdr.markForCheck()));
        this.mapViewSubscription.add(views.scaleChanged.subscribe(() => cdr.markForCheck()));
    }

    get scaleEnabled(): boolean { return this.viewSettings.viewScaleState.getValue(this.mapView()?.viewIndex ?? 0); }
    get scale() {
        const bar = this.views.mapScales.get(this.viewSettings.viewIdAt(this.mapView()?.viewIndex ?? 0));
        if (!bar) return undefined;
        if (this.drawingState.unit.value === 'meters') return {...bar,label:bar.meters >= 1000 ? bar.meters/1000+' km' : bar.meters+' m'};
        const miles = bar.meters/1609.344, power = 10**Math.floor(Math.log10(miles)), ratio = miles/power;
        const rounded = (ratio>=5?5:ratio>=2?2:1)*power;
        return {width:bar.width*rounded/miles,label:Number(rounded.toPrecision(5))+' mi'};
    }
    toggleScale(): void { this.viewSettings.viewScaleState.next(this.mapView()?.viewIndex ?? 0, !this.scaleEnabled); }

    /** Hooks the compass needle to the renderer tick loop and registers the projection-toggle shortcut. */
    ngAfterViewInit(): void {
        const needle = this.needleRef.nativeElement;
        this.mapViewSubscription.add(this.mapView$.pipe(
            filter(mv => mv !== undefined)).subscribe(mapView => {
                this.projection = this.is2D() ?
                    { icon: '2d', label: '2D', mode: '2D projection' } :
                    { icon: '3d', label: '3D', mode: '3D projection' };
                let currentRotationDeg = 0;
                const oldTick = this.compassTickByView.get(mapView);
                if (oldTick) {
                    this.ngZone.runOutsideAngular(() => mapView.offTick(oldTick));
                }
                const tick = () => {
                    if (needle && mapView.isAvailable()) {
                        let headingDeg = mapView.getCameraHeadingDegrees();
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
                };
                this.compassTickByView.set(mapView, tick);
                this.ngZone.runOutsideAngular(() => mapView.onTick(tick));
            })
        );

        this.keyboardService.registerShortcut('t', this.toggleSceneMode.bind(this), true);
    }

    /** Unsubscribes the compass tick from the current renderer when the UI overlay is destroyed. */
    ngOnDestroy(): void {
        const mapView = this.mapView();
        if (mapView) {
            const tick = this.compassTickByView.get(mapView);
            if (tick) {
                this.ngZone.runOutsideAngular(() => mapView.offTick(tick));
                this.compassTickByView.delete(mapView);
            }
        }
        this.mapViewSubscription.unsubscribe();
    }

    /** Toggles the selected renderer between 2D and 3D mode through persisted app state. */
    toggleSceneMode() {
        const mapView = this.mapView();
        if (!mapView) {
            return;
        }
        this.viewSettings.focusedView = mapView.viewIndex;
        const currentMode = this.viewSettings.mode2dState.getValue(mapView.viewIndex);
        this.viewSettings.setProjectionMode(mapView.viewIndex, !currentMode);
    }

    /** Builds a stable test id for view UI controls. */
    viewUiTestId(): string {
        const mapView = this.mapView();
        return `view-ui-container-${mapView ? mapView.viewIndex : 'unknown'}`;
    }
}
