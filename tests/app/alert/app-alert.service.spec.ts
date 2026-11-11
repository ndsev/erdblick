import '@angular/compiler';
import {Component, NO_ERRORS_SCHEMA, ViewChild, ViewContainerRef} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppAlertService} from '../../../app/alert/app-alert.service';
import {AlertDialogComponent} from '../../../app/alert/alert.component';
import {ConfirmDialogComponent} from '../../../app/alert/confirm-dialog.component';
import {AppDialogComponent} from '../../../app/layout/app-dialog.component';
import {ClipboardService} from '../../../app/clipboard/clipboard.service';
import {InfoMessageService} from '../../../app/diagnostics/info.service';

@Component({template: '<ng-template #dialogs />'})
class DialogHost {
    @ViewChild('dialogs', {read: ViewContainerRef, static: true}) container!: ViewContainerRef;
}

/** Exercises real dynamic components without starting the application's layout controllers. */
function setup() {
    TestBed.configureTestingModule({imports: [DialogHost]});
    for (const component of [AlertDialogComponent, ConfirmDialogComponent]) {
        TestBed.overrideComponent(component, {
            remove: {imports: [AppDialogComponent]}, add: {schemas: [NO_ERRORS_SCHEMA]}
        });
    }
    const fixture = TestBed.createComponent(DialogHost);
    fixture.detectChanges();
    const alerts = TestBed.inject(AppAlertService);
    const messages = TestBed.inject(InfoMessageService);
    const release = alerts.registerDefaultContainer(fixture.componentInstance.container);
    return {fixture, alerts, messages, release, container: fixture.componentInstance.container};
}

afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('AppAlertService', () => {
    it('preserves selectable clipboard fallback and ends the default host on release', () => {
        const {fixture, alerts, messages, release, container} = setup();
        const toast = vi.spyOn(messages, 'showError');
        vi.stubGlobal('isSecureContext', false);
        new ClipboardService(messages, alerts).copyToClipboard('first line\nsecond line');
        fixture.detectChanges();
        const alert = fixture.debugElement.query(By.directive(AlertDialogComponent)).componentInstance as AlertDialogComponent;
        expect(alert.headerText()).toBe('Clipboard Content');
        expect(alert.messageText()).toBe('first line\nsecond line');
        expect(alert.selected()).toBe(true);
        const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
        expect(textarea.readOnly).toBe(true);
        expect(textarea.selectionEnd - textarea.selectionStart).toBe(textarea.value.length);
        expect(toast).not.toHaveBeenCalled();
        alert.close();
        expect(container.length).toBe(0);
        release();
        alerts.showAlertDialogDefault('Fallback', 'Host is gone');
        expect(toast).toHaveBeenCalledExactlyOnceWith('Host is gone');
    });

    it('falls back to the modal when an asynchronous clipboard write rejects', async () => {
        const {fixture, alerts, messages} = setup();
        vi.stubGlobal('isSecureContext', true);
        vi.stubGlobal('navigator', {
            userAgent: navigator.userAgent,
            clipboard: {writeText: vi.fn().mockRejectedValue(new Error('Denied'))}
        });
        const success = vi.spyOn(messages, 'showSuccess');
        new ClipboardService(messages, alerts).copyToClipboard('copy me');
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(fixture.debugElement.query(By.directive(AlertDialogComponent))).not.toBeNull();
        });
        const alert = fixture.debugElement.query(By.directive(AlertDialogComponent)).componentInstance as AlertDialogComponent;
        expect(alert.messageText()).toBe('copy me');
        expect(success).not.toHaveBeenCalled();
    });

    it('settles confirmation exactly once on acceptance and on container destruction', async () => {
        const {fixture, alerts, container} = setup();
        const accepted = alerts.showConfirmDialog(container, 'Close?', 'Unsaved work');
        fixture.detectChanges();
        const confirm = fixture.debugElement.query(By.directive(ConfirmDialogComponent)).componentInstance as ConfirmDialogComponent;
        confirm.accept();
        confirm.reject();
        await expect(accepted).resolves.toBe(true);
        expect(container.length).toBe(0);
        const abandoned = alerts.showConfirmDialog(container, 'Close?', 'Unsaved work');
        fixture.destroy();
        await expect(abandoned).resolves.toBe(false);
    });

    it('cancels dialogs owned by a released host without unregistering its replacement', async () => {
        const {fixture, alerts, container, release} = setup();
        const pending = alerts.showConfirmDialog(container, 'Pending', 'Cancel on release');
        const replacement = TestBed.createComponent(DialogHost);
        replacement.detectChanges();
        alerts.registerDefaultContainer(replacement.componentInstance.container);
        release();
        await expect(pending).resolves.toBe(false);
        alerts.showAlertDialogDefault('Replacement', 'Still available');
        expect(replacement.componentInstance.container.length).toBe(1);
        expect(container.length).toBe(0);
        fixture.destroy();
        alerts.ngOnDestroy();
        expect(replacement.componentInstance.container.length).toBe(0);
    });
});
