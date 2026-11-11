import '@angular/compiler';
import {NgZone} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {InfoMessageComponent} from '../../../app/diagnostics/info-message.component';
import {InfoMessageService} from '../../../app/diagnostics/info.service';
import {DEFAULT_INFO_MESSAGE_CONFIG, INFO_MESSAGE_CONFIG} from '../../../app/diagnostics/info-message.model';

/** Mounts the real PrimeNG adapter with deterministic immediate admissions. */
async function host() {
    TestBed.configureTestingModule({imports: [InfoMessageComponent], providers: [
        {provide: INFO_MESSAGE_CONFIG, useValue: {...DEFAULT_INFO_MESSAGE_CONFIG, gapMs: 0}}
    ]});
    const service = TestBed.inject(InfoMessageService);
    const fixture = TestBed.createComponent(InfoMessageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    return {service, fixture, root};
}

describe('InfoMessageComponent', () => {
    afterEach(() => {
        TestBed.resetTestingModule();
        document.body.classList.remove('presentation-canvas-only');
    });

    it('counts outside Angular without replacing the DOM or repeating the live announcement', async () => {
        const {service, fixture, root} = await host();
        const zone = TestBed.inject(NgZone);
        const ref = zone.runOutsideAngular(() => service.showInfo('Background message'));
        fixture.detectChanges();
        await fixture.whenStable();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[role="status"]')!.textContent).toBe('Info: Background message');
        });
        const original = root.querySelector('[data-testid="info-message"]')!;
        const announcement = root.querySelector('[role="status"]')!.textContent;
        zone.runOutsideAngular(() => {
            for (let i = 0; i < 105; ++i) service.showInfo('Background message');
        });
        fixture.detectChanges();
        await fixture.whenStable();
        expect(root.querySelector('[data-testid="info-message"]')).toBe(original);
        expect(original.getAttribute('data-count')).toBe('106');
        expect(original.querySelector('p-badge')?.textContent).toBe('99+');
        expect(original.querySelector('p-badge')?.getAttribute('aria-label')).toBe('106 occurrences');
        expect(root.querySelector('[role="status"]')!.textContent).toBe(announcement);
        const shell = original.closest('.p-toast-message')!;
        expect(shell.getAttribute('role')).toBe('presentation');
        expect(shell.getAttribute('aria-live')).toBe('off');
        ref.update({severity: 'error', detail: 'Updated condition'});
        fixture.detectChanges();
        await fixture.whenStable();
        expect(root.querySelector('[data-testid="info-message"]')).toBe(original);
        expect(original.textContent).toContain('Updated condition');
        expect(shell.className).toContain('error');
        ref.dismiss();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-testid="info-message"]')).toBeNull();
            expect(root.querySelector('[role="status"]')!.textContent).toBe('');
        });
    });

    it('retains a failed action and prevents concurrent activations', async () => {
        const {service, fixture, root} = await host();
        let reject!: (error: Error) => void;
        const run = vi.fn(() => new Promise<void>((_resolve, fail) => {reject = fail;}));
        fixture.componentRef.setInput('actions', {open: run});
        const ref = service.showWarning('Needs attention', {life: 'sticky', action: {id: 'open', label: 'Open controls'}});
        fixture.detectChanges();
        await fixture.whenStable();
        const button = root.querySelector<HTMLButtonElement>('[data-testid="info-message-action"] button')!;
        button.click();
        button.click();
        fixture.detectChanges();
        expect(run).toHaveBeenCalledOnce();
        expect(button.disabled).toBe(true);
        reject(new Error('Target is no longer available'));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(ref.active).toBe(true);
        expect(root.textContent).toContain('Target is no longer available');
        expect(button.disabled).toBe(false);
    });

    it('does not dismiss a replacement when an old action completes late', async () => {
        const {service, fixture, root} = await host();
        let finish!: () => void;
        fixture.componentRef.setInput('actions', {open: () => new Promise<void>(resolve => {finish = resolve;})});
        const options = {life: 'sticky' as const, action: {id: 'open', label: 'Open controls'}};
        const original = service.showWarning('Needs attention', options);
        fixture.detectChanges();
        await fixture.whenStable();
        root.querySelector<HTMLButtonElement>('[data-testid="info-message-action"] button')!.click();
        original.dismiss();
        const next = service.showWarning('Needs attention', options);
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(root.querySelector('[data-testid="info-message"]')?.getAttribute('data-message-id')).toBe(next.id);
        });
        finish();
        await fixture.whenStable();
        expect(next.active).toBe(true);
        expect(root.querySelector('[data-testid="info-message"]')?.getAttribute('data-count')).toBe('1');
    });

    it('keeps a missing action disabled, and independently pauses focus and pointer interaction', async () => {
        const {service, fixture, root} = await host();
        const pause = vi.spyOn(service, 'pause');
        const ref = service.showInfo('Unavailable target', {action: {id: 'missing', label: 'Open'}});
        fixture.detectChanges();
        await fixture.whenStable();
        expect(root.querySelector<HTMLButtonElement>('[data-testid="info-message-action"] button')?.disabled).toBe(true);
        const item = root.querySelector('info-message-item')!;
        item.dispatchEvent(new MouseEvent('mouseenter'));
        item.dispatchEvent(new FocusEvent('focusin'));
        item.dispatchEvent(new MouseEvent('mouseleave'));
        item.dispatchEvent(new FocusEvent('focusout', {relatedTarget: root}));
        expect(pause.mock.calls).toEqual([
            [ref.id, 'pointer', true], [ref.id, 'focus', true], [ref.id, 'pointer', false], [ref.id, 'focus', false]
        ]);
    });

    it('removes transient canvas-only messages while retaining sticky conditions', async () => {
        const {service, fixture, root} = await host();
        const transient = service.showInfo('Old slide');
        service.showWarning('Persistent condition', {life: 'sticky'});
        fixture.detectChanges();
        await fixture.whenStable();
        document.body.classList.add('presentation-canvas-only');
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(transient.active).toBe(false);
            expect(root.textContent).not.toContain('Old slide');
        });
        document.body.classList.remove('presentation-canvas-only');
        await fixture.whenStable();
        expect(root.textContent).toContain('Persistent condition');
    });
});
