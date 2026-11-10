import '@angular/compiler';
import {Component, NO_ERRORS_SCHEMA} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpClient} from '@angular/common/http';
import {By} from '@angular/platform-browser';
import {MessageService} from 'primeng/api';
import {ToastModule} from 'primeng/toast';
import {EMPTY} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppComponent} from '../../../app/app.component';
import {AppActionRegistry} from '../../../app/action/action-registry.service';
import {AppStateService} from '../../../app/appstate/appstate.service';
import {AppConfigService} from '../../../app/config/appconfig.service';
import {DiagnosticsFacadeService} from '../../../app/diagnostics/diagnostics-facade.service';
import {DiagnosticsState} from '../../../app/diagnostics/diagnostics.state';
import {InfoMessageService} from '../../../app/diagnostics/info.service';
import {KeyboardService} from '../../../app/keyboard/keyboard.service';
import {DialogStackService} from '../../../app/layout/dialog-stack.service';
import {LayoutService} from '../../../app/layout/layout.service';
import {MapDataService} from '../../../app/mapdata/mapdata.service';
import {MapTileStreamService} from '../../../app/mapdata/map-tile-stream.service';
import {MapStyleService} from '../../../app/mapstyle/mapstyle.service';
import {TileSubsetLayerRenderService} from '../../../app/mapview/deck/tile-subset-layer-render.service';

/** Records the toast's navigation request without starting the preferences or map controllers. */
@Component({selector: 'preferences', template: ''})
class PreferencesStub {
    readonly openRendering = vi.fn();
}

describe('GPU warning toast', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('keeps one warning, dismisses it on navigation, and allows a later warning', async () => {
        TestBed.configureTestingModule({
            declarations: [AppComponent],
            imports: [ToastModule, PreferencesStub],
            schemas: [NO_ERRORS_SCHEMA],
            providers: [
                MessageService,
                ...[AppActionRegistry, AppStateService, DiagnosticsFacadeService, DiagnosticsState,
                    DialogStackService, MapDataService, MapTileStreamService, MapStyleService,
                    TileSubsetLayerRenderService].map(provide => ({provide, useValue: {}})),
                {provide: HttpClient, useValue: {get: () => EMPTY}},
                {provide: KeyboardService, useValue: {registerShortcut: vi.fn()}},
                {provide: LayoutService, useValue: {isDialogOpen: () => false}},
                {provide: AppConfigService, useValue: {
                    getExtensionModuleId: () => undefined,
                    snapshot: {serverConfig: {styleEditingEnabled: false, mapPresets: {write: false}}}
                }}
            ]
        });
        const fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        const info = TestBed.inject(InfoMessageService);
        const root: HTMLElement = fixture.nativeElement;
        const preferences: PreferencesStub = fixture.debugElement.query(By.directive(PreferencesStub)).componentInstance;

        info.showBackendConnectionError('Keep this notice');
        for (let index = 0; index < 10; ++index) info.showGpuBufferExhausted();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(root.querySelectorAll('[data-testid="gpu-buffer-warning"]')).toHaveLength(1);

        root.querySelector<HTMLButtonElement>('.gpu-buffer-action')!.click();
        fixture.detectChanges();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-testid="gpu-buffer-warning"]')).toBeNull();
        });
        expect(preferences.openRendering).toHaveBeenCalledOnce();
        expect(root.textContent).toContain('Keep this notice');

        info.showGpuBufferExhausted();
        info.showGpuBufferExhausted();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(root.querySelectorAll('[data-testid="gpu-buffer-warning"]')).toHaveLength(1);
        expect(root.textContent).toContain('Keep this notice');
    });
});
