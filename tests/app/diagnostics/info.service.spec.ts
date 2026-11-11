import '@angular/compiler';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {InfoMessageService} from '../../../app/diagnostics/info.service';
import {DEFAULT_INFO_MESSAGE_CONFIG, INFO_MESSAGE_CONFIG, InfoMessageEntry} from '../../../app/diagnostics/info-message.model';

describe('InfoMessageService lifecycle', () => {
    let service: InfoMessageService;
    let displayed: InfoMessageEntry[];

    /** Models a mounted renderer without depending on PrimeNG animations. */
    const attach = () => service.attachHost('top-center', entry => {
        displayed.push(entry);
        service.presented(entry.id);
    });

    beforeEach(() => {
        vi.useFakeTimers();
        TestBed.configureTestingModule({providers: [InfoMessageService]});
        service = TestBed.inject(InfoMessageService);
        displayed = [];
    });
    afterEach(() => {
        TestBed.resetTestingModule();
        vi.useRealTimers();
    });

    it.each([['success', 3000], ['info', 5000], ['warn', 8000], ['error', 10000]] as const)(
        'gives a displayed %s message its default %i ms lifetime', (severity, duration) => {
            attach();
            const ref = service.show({severity, detail: 'Notice'});
            vi.advanceTimersByTime(duration - 1);
            expect(ref.active).toBe(true);
            vi.advanceTimersByTime(1);
            expect(ref.active).toBe(false);
            expect(displayed[0].state().phase).toBe('closing');
        });

    it('increments the same instance and restarts its full duration on every repeat', () => {
        attach();
        const first = service.showError('Failed');
        const entry = displayed[0];
        vi.advanceTimersByTime(7000);
        expect(service.showError('Failed').id).toBe(first.id);
        expect(displayed).toEqual([entry]);
        expect(entry.state().count).toBe(2);
        vi.advanceTimersByTime(9999);
        expect(first.active).toBe(true);
        vi.advanceTimersByTime(1);
        expect(first.active).toBe(false);
    });

    it('supports explicit keep-deadline and duplicate opt-outs', () => {
        attach();
        const first = service.showSuccess('Done', {restartOnRepeat: false});
        vi.advanceTimersByTime(2000);
        service.showSuccess('Done', {restartOnRepeat: false});
        expect(displayed[0].state().count).toBe(2);
        vi.advanceTimersByTime(1000);
        expect(first.active).toBe(false);
        const separate = service.showSuccess('Done', {duplicates: 'allow'});
        expect(service.showSuccess('Done', {duplicates: 'allow'}).id).not.toBe(separate.id);
    });

    it('keeps scopes, severities, details and action identities distinct', () => {
        const inputs = [
            {scope: 'metadata'}, {scope: 'stream'},
            {action: {id: 'a', label: 'Open'}}, {action: {id: 'b', label: 'Open'}}
        ];
        const ids = inputs.map(options => service.showError('Failed', options).id);
        ids.push(service.showWarning('Failed').id, service.showError('Other failure').id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('restarts at one during exit and ignores an old close callback after the replacement appears', () => {
        attach();
        const first = service.showError('Failed');
        service.showError('Failed');
        first.dismiss();
        const next = service.showError('Failed');
        expect(next.id).not.toBe(first.id);
        expect(service.entry(next.id)?.state().count).toBe(1);
        vi.advanceTimersByTime(1000);
        expect(displayed).toHaveLength(1);
        service.closed(first.id);
        vi.advanceTimersByTime(199);
        expect(displayed).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(displayed).toHaveLength(2);
        first.dismiss();
        service.closed(first.id);
        expect(next.active).toBe(true);
        expect(service.showError('Failed').id).toBe(next.id);
        expect(displayed[1].state().count).toBe(2);
    });

    it('counts sticky repeats, updates conditions without counting and clears only an owned reference', () => {
        attach();
        const metadata = service.showError('Metadata unavailable', {scope: 'metadata', life: 'sticky'});
        const stream = service.showError('Stream unavailable', {scope: 'stream', life: 'sticky'});
        vi.advanceTimersByTime(200);
        expect(metadata.update({detail: 'Metadata retrying'})).toBe(true);
        expect(service.entry(metadata.id)?.state().count).toBe(1);
        service.showError('Metadata retrying', {scope: 'metadata', life: 'sticky'});
        expect(service.entry(metadata.id)?.state().count).toBe(2);
        metadata.dismiss();
        expect(metadata.update({detail: 'Unchanged condition refresh'})).toBe(false);
        vi.advanceTimersByTime(60000);
        expect(stream.active).toBe(true);
    });

    it('rejects an update that would silently combine two active identities', () => {
        const first = service.showInfo('First');
        const second = service.showInfo('Second');
        expect(first.update({detail: 'Second'})).toBe(false);
        expect(service.entry(first.id)?.state().detail).toBe('First');
        expect(service.showInfo('Second').id).toBe(second.id);
    });

    it('holds startup reports until mounted and cancels a resolved pending condition', () => {
        const cancelled = service.showWarning('Resolved before startup', {life: 'sticky'});
        const pending = service.showSuccess('Loaded');
        service.showSuccess('Loaded');
        cancelled.dismiss();
        vi.advanceTimersByTime(60000);
        expect(pending.active).toBe(true);
        attach();
        expect(displayed).toHaveLength(1);
        expect(displayed[0].state().count).toBe(2);
        vi.advanceTimersByTime(2999);
        expect(pending.active).toBe(true);
        vi.advanceTimersByTime(1);
        expect(pending.active).toBe(false);
    });

    it('spaces queued admissions, coalesces pending repeats and never postpones a scheduled admission', () => {
        attach();
        service.showWarning('Persistent', {life: 'sticky'});
        const second = service.showInfo('Second');
        vi.advanceTimersByTime(100);
        service.showInfo('Second');
        service.showInfo('Third');
        vi.advanceTimersByTime(99);
        expect(displayed).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(displayed[1].id).toBe(second.id);
        expect(displayed[1].state().count).toBe(2);
        vi.advanceTimersByTime(200);
        expect(displayed).toHaveLength(3);
    });

    it('preserves unread time across independent pointer, focus and document pauses', () => {
        attach();
        const ref = service.showSuccess('Done');
        vi.advanceTimersByTime(1000);
        service.pause(ref.id, 'pointer', true);
        service.pause(ref.id, 'focus', true);
        vi.advanceTimersByTime(10000);
        service.pause(ref.id, 'pointer', false);
        service.setDocumentHidden(true);
        service.pause(ref.id, 'focus', false);
        vi.advanceTimersByTime(10000);
        service.setDocumentHidden(false);
        vi.advanceTimersByTime(1999);
        expect(ref.active).toBe(true);
        vi.advanceTimersByTime(1);
        expect(ref.active).toBe(false);
    });

    it('resets the full remaining duration on a repeat while paused', () => {
        attach();
        const ref = service.showSuccess('Done');
        vi.advanceTimersByTime(2000);
        service.pause(ref.id, 'action', true);
        service.showSuccess('Done');
        vi.advanceTimersByTime(10000);
        expect(ref.active).toBe(true);
        service.pause(ref.id, 'action', false);
        vi.advanceTimersByTime(2999);
        expect(ref.active).toBe(true);
        vi.advanceTimersByTime(1);
        expect(ref.active).toBe(false);
    });

    it('does not drain hidden queues, and starts lifetime when they are shown', () => {
        attach();
        service.setDocumentHidden(true);
        const ref = service.showSuccess('Done');
        vi.advanceTimersByTime(10000);
        expect(displayed).toHaveLength(0);
        service.setDocumentHidden(false);
        expect(displayed).toHaveLength(1);
        vi.advanceTimersByTime(2999);
        expect(ref.active).toBe(true);
    });

    it('drops transient presentation messages but preserves persistent conditions', () => {
        const transient = service.showSuccess('Old slide');
        const persistent = service.showWarning('Persistent', {life: 'sticky'});
        service.setPresentationEnabled(false);
        expect(transient.active).toBe(false);
        expect(service.showSuccess('Hidden slide').active).toBe(false);
        attach();
        expect(displayed).toHaveLength(0);
        service.setPresentationEnabled(true);
        expect(displayed.map(entry => entry.id)).toEqual([persistent.id]);
    });

    it('ends host-owned instances and releases every timer before remounting', () => {
        const detach = attach();
        const old = service.showInfo('First');
        service.showInfo('Queued');
        detach();
        expect(old.active).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        attach();
        const next = service.showInfo('First');
        expect(next.id).not.toBe(old.id);
        expect(service.entry(next.id)?.state().count).toBe(1);
        service.ngOnDestroy();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('InfoMessageService configuration', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('can disable presentation without retaining startup messages', () => {
        TestBed.configureTestingModule({providers: [{provide: INFO_MESSAGE_CONFIG,
            useValue: {...DEFAULT_INFO_MESSAGE_CONFIG, enabled: false}}]});
        const service = TestBed.inject(InfoMessageService);
        const ref = service.showError('Hidden', {life: 'sticky'});
        const show = vi.fn();
        service.attachHost('top-center', show);
        expect(ref.active).toBe(false);
        expect(show).not.toHaveBeenCalled();
    });

    it('supports immediate delivery and reports overflow without dropping sticky owner conditions', () => {
        TestBed.configureTestingModule({providers: [{provide: INFO_MESSAGE_CONFIG,
            useValue: {...DEFAULT_INFO_MESSAGE_CONFIG, gapMs: 0, maxPending: 2}}]});
        const service = TestBed.inject(InfoMessageService);
        service.showInfo('First');
        service.showInfo('Second');
        expect(service.showInfo('Dropped').active).toBe(false);
        service.showInfo('Also dropped');
        service.showWarning('Keep condition', {life: 'sticky'});
        const displayed: InfoMessageEntry[] = [];
        service.attachHost('top-center', entry => displayed.push(entry));
        expect(displayed).toHaveLength(4);
        expect(displayed.find(entry => entry.state().scope === 'notification-overflow')?.state().count).toBe(2);
        expect(displayed.at(-1)?.state().detail).toBe('Keep condition');
    });
});
