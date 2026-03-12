import {Component, OnDestroy, ViewContainerRef} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService, Versions} from "./shared/appstate.service";
import {DebugWindow, ErdblickDebugApi} from "./app.debugapi.component";
import {InfoMessageService} from "./shared/info.service";
import {environment} from "./environments/environment";
import {DialogStackService} from "./shared/dialog-stack.service";
import {Title} from "@angular/platform-browser";
import {KeyboardService} from "./shared/keyboard.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'app-root',
    template: `
        <dockable-layout></dockable-layout>
        @if (!environment.visualizationOnly) {
            <datasources></datasources>
            <map-panel></map-panel>
            @if (stateService.diagnosticsPerformanceDialogVisible) {
                <diagnostics-performance-dialog></diagnostics-performance-dialog>
            }
            @if (stateService.diagnosticsLogDialogVisible) {
                <diagnostics-log-dialog></diagnostics-log-dialog>
            }
            @if (stateService.diagnosticsExportDialogVisible) {
                <diagnostics-export-dialog></diagnostics-export-dialog>
            }
            <style-panel></style-panel>
            <feature-search></feature-search>
            <keyboard-dialog></keyboard-dialog>
            <preferences></preferences>
            <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        }
        <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        <legal-dialog></legal-dialog>
        <about-dialog></about-dialog>
        <router-outlet></router-outlet>
    `,
    styles: [`
        .dialog-content {
            margin-bottom: 0.5em;
        }

        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class AppComponent implements OnDestroy {

    title: string = "erdblick";
    private detachDialogFocusListener?: () => void;
    private detachDialogDragStartListener?: () => void;
    private detachDialogDragEndListener?: () => void;
    private dialogDragActive = false;

    constructor(public stateService: AppStateService,
                private httpClient: HttpClient,
                private mapService: MapDataService,
                private keyboardService: KeyboardService,
                private viewContainerRef: ViewContainerRef,
                private infoMessageService: InfoMessageService,
                private dialogStack: DialogStackService,
                private titleService: Title) {
        // Register a default container for alert dialogs
        this.infoMessageService.registerDefaultContainer(this.viewContainerRef);
        this.titleService.setTitle(this.capitalizeTitle(this.title));
        this.bindDialogFocusStacking();
        this.bindDialogDragSelectionGuard();
        window.ebDebug = new ErdblickDebugApi(
            this.mapService,
            this.stateService
        );

        this.httpClient.get("config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["distribVersions"]) {
                        let distribVersions = data["extensionModules"]["distribVersions"];
                        if (distribVersions !== undefined) {
                            const distribVersionsPath = `/config/${distribVersions}.js`;
                            // Using string interpolation so webpack can trace imports, and tell Vite to leave the absolute path untouched
                            import(/* @vite-ignore */ distribVersionsPath)
                                .then((plugin) => plugin.default() as Array<Versions>)
                                .then((versions: Array<Versions>) => {
                                    this.stateService.distributionVersions.next(versions);
                                    if (versions[0].name.trim()) {
                                        this.titleService.setTitle(this.capitalizeTitle(versions[0].name.trim()));
                                    } else {
                                        this.titleService.setTitle(this.capitalizeTitle(this.title));
                                    }
                                })
                                .catch((error) => {
                                    console.error(error);
                                    this.getBasicVersion();
                                });
                            return;
                        } else {
                            this.getBasicVersion();
                        }
                    } else {
                        this.getBasicVersion();
                    }
                } catch (error) {
                    console.error(error);
                    this.getBasicVersion();
                }
            },
            error: error => {
                console.error(error);
                this.getBasicVersion();
            }
        });

        this.keyboardService.registerShortcut("Ctrl+x", this.openStatistics.bind(this), true);
    }

    ngOnDestroy() {
        this.detachDialogFocusListener?.();
        this.detachDialogDragStartListener?.();
        this.detachDialogDragEndListener?.();
    }

    private bindDialogFocusStacking() {
        const handler = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target) {
                return;
            }
            const dialogElement = target.closest('.p-dialog') as HTMLElement | null;
            if (dialogElement) {
                if (dialogElement.closest('.search-menu-dialog')) {
                    const mainBar = document.querySelector('.main-bar') as HTMLElement | null;
                    if (mainBar) {
                        this.dialogStack.bringToFront(mainBar);
                    }
                    const wrapper = dialogElement.closest('.search-wrapper') as HTMLElement | null;
                    this.dialogStack.bringToFront(wrapper ?? dialogElement);
                    return;
                }
                this.dialogStack.bringToFront(dialogElement);
                return;
            }

            const mainBar = target.closest('.main-bar') as HTMLElement | null;
            const searchWrapper = target.closest('.search-wrapper') as HTMLElement | null;
            if (mainBar) {
                this.dialogStack.bringToFront(mainBar);
            }
            if (searchWrapper) {
                this.dialogStack.bringToFront(searchWrapper);
            }
        };
        document.addEventListener('mousedown', handler, true);
        this.detachDialogFocusListener = () => {
            document.removeEventListener('mousedown', handler, true);
        };
    }

    private bindDialogDragSelectionGuard() {
        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) {
                return;
            }
            const target = event.target as HTMLElement | null;
            if (!target) {
                return;
            }
            const header = target.closest('.p-dialog-header') as HTMLElement | null;
            const resizeHandle = target.closest('.p-resizable-handle') as HTMLElement | null;
            if (!header && !resizeHandle) {
                return;
            }
            const dialog = (header ?? resizeHandle)?.closest('.p-dialog') as HTMLElement | null;
            if (!dialog) {
                return;
            }
            this.setDialogDragSelection(true);
        };

        const handlePointerEnd = () => {
            this.setDialogDragSelection(false);
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        window.addEventListener('pointerup', handlePointerEnd, true);
        window.addEventListener('pointercancel', handlePointerEnd, true);
        window.addEventListener('blur', handlePointerEnd);

        this.detachDialogDragStartListener = () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
        };
        this.detachDialogDragEndListener = () => {
            window.removeEventListener('pointerup', handlePointerEnd, true);
            window.removeEventListener('pointercancel', handlePointerEnd, true);
            window.removeEventListener('blur', handlePointerEnd);
        };
    }

    private setDialogDragSelection(active: boolean) {
        if (this.dialogDragActive === active) {
            return;
        }
        this.dialogDragActive = active;
        if (active) {
            document.body?.classList.add('dialog-dragging');
            window.getSelection()?.removeAllRanges();
            return;
        }
        document.body?.classList.remove('dialog-dragging');
    }

    getBasicVersion() {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.stateService.erdblickVersion.next(`${this.title} ${data.toString()}`);
                this.titleService.setTitle(this.capitalizeTitle(this.title));
            });
    }

    private capitalizeTitle(title: string) {
        return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
    }

    private openStatistics() {
        this.stateService.diagnosticsPerformanceDialogVisible = true;
    }

    protected readonly environment = environment;
}
