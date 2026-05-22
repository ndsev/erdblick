import {Component, OnDestroy, ViewContainerRef} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {MapDataService} from "./mapdata/map.service";
import {
    AppStateService,
    DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID,
    Versions
} from "./shared/appstate.service";
import {DebugWindow, ErdblickDebugApi} from "./app.debugapi.component";
import {InfoMessageService} from "./shared/info.service";
import {environment} from "./environments/environment";
import {DialogStackService} from "./shared/dialog-stack.service";
import {Title} from "@angular/platform-browser";
import {KeyboardService} from "./shared/keyboard.service";
import {AppConfigService} from "./shared/app-config.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'app-root',
    template: `
        <dockable-layout></dockable-layout>
        @if (!environment.visualizationOnly) {
            <datasources></datasources>
            <advanced-preferences></advanced-preferences>
            <map-panel></map-panel>
            @if (stateService.isDialogOpen(diagnosticsPerformanceDialogLayoutId)) {
                <diagnostics-performance-dialog></diagnostics-performance-dialog>
            }
            @if (stateService.isDialogOpen(diagnosticsLogDialogLayoutId)) {
                <diagnostics-log-dialog></diagnostics-log-dialog>
            }
            @if (stateService.isDialogOpen(diagnosticsExportDialogLayoutId)) {
                <diagnostics-export-dialog></diagnostics-export-dialog>
            }
            <style-panel></style-panel>
            <inspection-dialogs></inspection-dialogs>
            <feature-search-dialogs></feature-search-dialogs>
            <keyboard-dialog></keyboard-dialog>
            <preferences></preferences>
            <survey></survey>
            <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        }
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
/**
 * Root application component.
 *
 * Besides rendering the top-level dialogs and panels, it wires up global
 * behaviors such as dialog stacking, drag-selection suppression, debug helpers,
 * and startup version loading.
 */
export class AppComponent implements OnDestroy {
    protected readonly diagnosticsPerformanceDialogLayoutId = DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID;
    protected readonly diagnosticsLogDialogLayoutId = DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID;
    protected readonly diagnosticsExportDialogLayoutId = DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID;

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
                private configService: AppConfigService,
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

        this.loadDistributionVersions();

        this.keyboardService.registerShortcut("Ctrl+x", this.openStatistics.bind(this), true);
    }

    /** Removes global dialog listeners installed during startup. */
    ngOnDestroy() {
        this.detachDialogFocusListener?.();
        this.detachDialogDragStartListener?.();
        this.detachDialogDragEndListener?.();
    }

    /** Keeps dialogs and the search wrapper in a deterministic z-order based on focus clicks. */
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

    /** Loads optional distribution-version metadata from the config-driven extension module. */
    private loadDistributionVersions() {
        const distribVersions = this.configService.getExtensionModuleId("distribVersions");
        if (!distribVersions) {
            this.getBasicVersion();
            return;
        }

        const distribVersionsPath = `/config/${distribVersions}.js`;
        import(/* @vite-ignore */ distribVersionsPath)
            .then((plugin) => plugin.default() as Array<Versions>)
            .then((versions: Array<Versions>) => {
                this.stateService.distributionVersions.next(versions);
                if (versions[0]?.name.trim()) {
                    this.titleService.setTitle(this.capitalizeTitle(versions[0].name.trim()));
                } else {
                    this.titleService.setTitle(this.capitalizeTitle(this.title));
                }
            })
            .catch((error) => {
                console.error(error);
                this.getBasicVersion();
            });
    }

    /** Prevents accidental text selection while PrimeNG dialogs are dragged or resized. */
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

    /** Applies or clears the global CSS state used while a dialog drag is active. */
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

    /** Loads the bundled fallback version string when distribution metadata is unavailable. */
    getBasicVersion() {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.stateService.erdblickVersion.next(`${this.title} ${data.toString()}`);
                this.titleService.setTitle(this.capitalizeTitle(this.title));
            });
    }

    /** Capitalizes the application title for use in the browser tab. */
    private capitalizeTitle(title: string) {
        return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
    }

    /** Opens the diagnostics performance dialog from the global keyboard shortcut. */
    private openStatistics() {
        this.stateService.openDialog(this.diagnosticsPerformanceDialogLayoutId);
    }

    protected readonly environment = environment;
}
