import {AfterViewInit, Component, ElementRef, ViewChild} from "@angular/core";
import {KeyboardService} from "./keyboard.service";
import {AppModeService} from "./app-mode.service";
import {ViewService} from "./view.service";
import {CameraService} from "./camera.service";
import {ViewStateService} from "./view.state.service";
import {CesiumMath} from "./cesium";

@Component({
    selector: 'erdblick-view-ui',
    template: `
        <div class="navigation-controls" *ngIf="!appModeService.isVisualizationOnly">
            <div class="nav-control-group">
                <p-button icon="pi pi-plus" (onClick)="cameraService.zoomIn()" [rounded]="true" severity="secondary"
                          size="small" pTooltip="Zoom In (Q)"></p-button>
                <p-button icon="pi pi-minus" (onClick)="cameraService.zoomOut()" [rounded]="true" severity="secondary"
                          size="small" pTooltip="Zoom Out (E)"></p-button>
            </div>
            <div class="nav-control-group">
                <p-button icon="pi pi-arrow-up" (onClick)="cameraService.moveUp()" [rounded]="true" severity="secondary"
                          size="small" pTooltip="Move Up (W)"></p-button>
                <div class="nav-horizontal">
                    <p-button icon="pi pi-arrow-left" (onClick)="cameraService.moveLeft()" [rounded]="true"
                              severity="secondary" size="small" pTooltip="Move Left (A)"></p-button>
                    <p-button icon="pi pi-arrow-right" (onClick)="cameraService.moveRight()" [rounded]="true"
                              severity="secondary" size="small" pTooltip="Move Right (D)"></p-button>
                </div>
                <p-button icon="pi pi-arrow-down" (onClick)="cameraService.moveDown()" [rounded]="true"
                          severity="secondary" size="small" pTooltip="Move Down (S)"></p-button>
            </div>
            <p-button icon="pi pi-refresh" (onClick)="cameraService.resetOrientation()" [rounded]="true"
                      severity="secondary" size="small" pTooltip="Reset View (R)"></p-button>
        </div>
        <div class="compass-circle" *ngIf="!appModeService.isVisualizationOnly">
            <div class="compass-label north">N</div>
            <div class="compass-label east">E</div>
            <div class="compass-label south">S</div>
            <div class="compass-label west">W</div>
            <div class="compass-needle" #compassNeedle></div>
        </div>
        <div class="scene-mode-toggle" *ngIf="!appModeService.isVisualizationOnly">
            <p-button
                    [ngClass]="{'blue': viewStateService.is2DMode}"
                    [label]="viewStateService.is2DMode ? '2D' : '3D'"
                    [pTooltip]="viewStateService.is2DMode ? 'Switch to 3D' : 'Switch to 2D'"
                    tooltipPosition="left"
                    (onClick)="viewService.toggleSceneMode()"
                    [rounded]="true"
                    severity="secondary"
                    size="large">
            </p-button>
        </div>
    `,
    styles: [`
        .scene-mode-toggle {
            position: absolute;
            bottom: 0.5em;
            right: 1em;
            z-index: 110;
        }

        .navigation-controls {
            position: absolute;
            bottom: 4.5em;
            right: 0.5em;
            z-index: 1;
            display: flex;
            flex-direction: column;
            gap: 0.5em;
            align-items: center;
        }

        .nav-control-group {
            display: flex;
            flex-direction: column;
            gap: 0.25em;
            align-items: center;
        }

        .nav-horizontal {
            display: flex;
            gap: 0.25em;
        }
    `],
    standalone: false
})
export class ErdblickViewUIComponent implements AfterViewInit {
    @ViewChild('compassNeedle', {static: false}) needleRef!: ElementRef<HTMLElement>;

    constructor(public viewStateService: ViewStateService,
                public viewService: ViewService,
                public cameraService: CameraService,
                public appModeService: AppModeService,
                private keyboardService: KeyboardService) {
    }

    ngAfterViewInit() {
        this.viewStateService.isViewerInit.subscribe(initialised => {
            if (initialised && this.needleRef) {
                const needle = this.needleRef.nativeElement;
                let currentRotationDeg = 0;
                this.viewStateService.viewer.clock.onTick.addEventListener(() => {
                    if (needle && this.viewStateService.isAvailable() && this.viewStateService.isNotDestroyed()) {
                        let headingDeg = CesiumMath.toDegrees(this.viewStateService.viewer.camera.heading);
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

            }
        });
        this.keyboardService.registerShortcut('t', this.viewService.toggleSceneMode.bind(this), true);
    }
}
