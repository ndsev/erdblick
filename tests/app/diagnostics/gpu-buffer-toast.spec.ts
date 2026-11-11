import '@angular/compiler';
import {Component, NO_ERRORS_SCHEMA} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpClient} from '@angular/common/http';
import {By} from '@angular/platform-browser';
import {InfoMessageComponent} from '../../../app/diagnostics/info-message.component';
import {GPU_BUFFER_EXHAUSTED_NOTICE} from '../../../app/mapview/gpu-buffer-notice.model';
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
            imports: [InfoMessageComponent, PreferencesStub],
            schemas: [NO_ERRORS_SCHEMA],
            providers: [
                ...[AppActionRegistry, AppStateService, DiagnosticsFacadeService, DiagnosticsState,
                    DialogStackService, MapDataService, MapTileStreamService, MapStyleService,
                    TileSubsetLayerRenderService].map(provide => ({provide, useValue: {}})),
                {provide: HttpClient, useValue: {get: () => EMPTY}},
                {provide: KeyboardService, useValue: {registerShortcut: vi.fn()}},
                {provide: LayoutService, useValue: {isDialogOpen: () => false}},
                {provide: AppConfigService, useValue: {
                    getExtensionModuleId: () => undefined,
                    snapshot: {serverConfig: {styleEditingEnabled: true, mapPresets: {write: true}}}
                }}
            ]
        });
        const fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        const info = TestBed.inject(InfoMessageService);
        const root: HTMLElement = fixture.nativeElement;
        const preferences: PreferencesStub = fixture.debugElement.query(By.directive(PreferencesStub)).componentInstance;

        info.showError('Keep this notice', {scope: 'other', life: 'sticky'});
        for (let index = 0; index < 10; ++index) info.show(GPU_BUFFER_EXHAUSTED_NOTICE);
        fixture.detectChanges();
        await fixture.whenStable();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelectorAll('[data-message-scope="gpu-buffer-exhausted"]')).toHaveLength(1);
        });

        expect(root.querySelector('[data-message-scope="gpu-buffer-exhausted"]')?.getAttribute('data-count')).toBe('10');
        root.querySelector<HTMLButtonElement>('[data-message-scope="gpu-buffer-exhausted"] button')!.click();
        fixture.detectChanges();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-message-scope="gpu-buffer-exhausted"]')).toBeNull();
        });
        expect(preferences.openRendering).toHaveBeenCalledOnce();
        expect(root.textContent).toContain('Keep this notice');
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-message-scope="source-style-editing"]')).not.toBeNull();
            expect(root.querySelector('[data-message-scope="map-preset-editing"]')).not.toBeNull();
        });
        root.querySelector<HTMLButtonElement>('[data-message-scope="source-style-editing"] button')!.click();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-message-scope="source-style-editing"]')).toBeNull();
        });
        expect(root.querySelector('[data-message-scope="map-preset-editing"]')?.getAttribute('data-count')).toBe('1');

        info.show(GPU_BUFFER_EXHAUSTED_NOTICE);
        info.show(GPU_BUFFER_EXHAUSTED_NOTICE);
        fixture.detectChanges();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelectorAll('[data-message-scope="gpu-buffer-exhausted"]')).toHaveLength(1);
        });
        expect(root.querySelector('[data-message-scope="gpu-buffer-exhausted"]')?.getAttribute('data-count')).toBe('2');
        expect(root.textContent).toContain('Keep this notice');
    });
});
