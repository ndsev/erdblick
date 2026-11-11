import {Injectable, NgZone, OnDestroy, WritableSignal, inject, signal} from '@angular/core';
import {
    INFO_MESSAGE_CONFIG, InfoMessageEntry, InfoMessageInput, InfoMessageOptions,
    InfoMessagePause, InfoMessagePosition, InfoMessageRef, InfoMessageSeverity,
    InfoMessageState, InfoMessageUpdate
} from './info-message.model';

const DURATIONS: Record<InfoMessageSeverity, number> = {success: 3000, info: 5000, warn: 8000, error: 10000};
const SUMMARIES: Record<InfoMessageSeverity, string> = {success: 'Success', info: 'Info', warn: 'Warning', error: 'Error'};

/** Internal lifetime state. Presentation data remains a small, separately readable signal. */
interface MessageRecord {
    entry: InfoMessageEntry;
    state: WritableSignal<InfoMessageState>;
    options: InfoMessageOptions;
    key?: string;
    duration: number | null;
    remaining: number;
    deadline?: number;
    timer?: ReturnType<typeof setTimeout>;
    timerGeneration: number;
    presented: boolean;
    pauses: Set<InfoMessagePause>;
}

/** One admission scheduler per physical stack; sticky entries do not block admissions. */
interface MessageQueue {
    pending: string[];
    closing: Set<string>;
    nextAt: number;
    timer?: ReturnType<typeof setTimeout>;
    show?: (entry: InfoMessageEntry) => void;
}

@Injectable({providedIn: 'root'})
/** Owns notification identity, occurrence counting, paced delivery and expiry without UI dependencies. */
export class InfoMessageService implements OnDestroy {
    private readonly zone = inject(NgZone);
    private readonly config = inject(INFO_MESSAGE_CONFIG);
    private readonly records = new Map<string, MessageRecord>();
    private readonly duplicates = new Map<string, string>();
    private readonly queues = new Map<InfoMessagePosition, MessageQueue>();
    private sequence = 0;
    private hidden = false;
    private presentationEnabled = true;
    private destroyed = false;

    /** Reports an error using the shared duplicate and lifetime defaults. */
    showError(detail: string, options: InfoMessageOptions = {}): InfoMessageRef {
        return this.show({severity: 'error', detail, ...options});
    }

    /** Reports a warning using the shared duplicate and lifetime defaults. */
    showWarning(detail: string, options: InfoMessageOptions = {}): InfoMessageRef {
        return this.show({severity: 'warn', detail, ...options});
    }

    /** Reports an informational message using the shared defaults. */
    showInfo(detail: string, options: InfoMessageOptions = {}): InfoMessageRef {
        return this.show({severity: 'info', detail, ...options});
    }

    /** Reports a short success acknowledgement using the shared defaults. */
    showSuccess(detail: string, options: InfoMessageOptions = {}): InfoMessageRef {
        return this.show({severity: 'success', detail, ...options});
    }

    /** Counts an active/pending duplicate or enqueues a fresh instance with count one. */
    show(input: InfoMessageInput): InfoMessageRef {
        const duration = input.life === 'sticky' ? null : input.life ?? DURATIONS[input.severity];
        if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) {
            throw new RangeError('Notification lifetime must be positive, or sticky.');
        }
        if (this.destroyed || !this.config.enabled || (!this.presentationEnabled && duration !== null)) {
            return this.reference(`info-message-${++this.sequence}`);
        }
        const value: InfoMessageState = {
            severity: input.severity, summary: input.summary ?? SUMMARIES[input.severity], detail: input.detail,
            scope: input.scope ?? '', action: input.action, count: 1, phase: 'pending'
        };
        const key = this.duplicateKey(value, input);
        const previous = key ? this.records.get(this.duplicates.get(key) ?? '') : undefined;
        if (previous) {
            previous.state.update(state => ({...state, count: state.count + 1}));
            if (previous.options.restartOnRepeat !== false) {
                this.cancelExpiry(previous);
                previous.remaining = previous.duration ?? 0;
                this.armExpiry(previous);
            }
            return this.reference(previous.entry.id);
        }
        const position = input.position ?? 'top-center';
        const queue = this.queue(position);
        const pendingTransientCount = queue.pending.filter(id => this.records.get(id)?.duration !== null).length;
        if (duration !== null && input.scope !== 'notification-overflow' && pendingTransientCount >= this.config.maxPending) {
            // Reserve one aggregate notice beyond the transient limit. Persistent owner conditions are retained.
            this.showWarning('Some notifications were skipped because the notification queue is full.', {
                scope: 'notification-overflow', dedupeKey: position, position
            });
            return this.reference(`info-message-${++this.sequence}`);
        }
        const id = `info-message-${++this.sequence}`;
        const state = signal(value);
        const record: MessageRecord = {
            entry: {id, position, state: state.asReadonly()}, state, options: {...input}, key,
            duration, remaining: duration ?? 0, timerGeneration: 0, presented: false, pauses: new Set()
        };
        this.records.set(id, record);
        if (key) this.duplicates.set(key, id);
        queue.pending.push(id);
        this.drain(position);
        return this.reference(id);
    }

    /** Installs one renderer after its PrimeNG hosts have subscribed; early messages can then be delivered. */
    attachHost(position: InfoMessagePosition, show: (entry: InfoMessageEntry) => void): () => void {
        const queue = this.queue(position);
        if (queue.show) throw new Error(`A notification host is already registered at ${position}.`);
        queue.show = show;
        this.drain(position);
        return () => {
            if (queue.show !== show) return;
            queue.show = undefined;
            clearTimeout(queue.timer);
            queue.timer = undefined;
            for (const record of [...this.records.values()]) {
                if (record.entry.position === position) this.remove(record);
            }
            queue.nextAt = 0;
        };
    }

    /** Starts lifetime only once the item's content has mounted, rather than during queueing. */
    presented(id: string): void {
        const record = this.records.get(id);
        if (!record || record.presented || record.state().phase !== 'visible') return;
        record.presented = true;
        this.armExpiry(record);
    }

    /** Looks up the stable signal associated with a PrimeNG message ID. */
    entry(id: string): InfoMessageEntry | undefined {
        return this.records.get(id)?.entry;
    }

    /** Ends logical identity immediately; the renderer subsequently finishes its exit animation. */
    dismiss(id: string): void {
        const record = this.records.get(id);
        if (!record || record.state().phase === 'closing') return;
        this.unindex(record);
        this.cancelExpiry(record);
        if (record.state().phase === 'pending') {
            this.remove(record);
            this.drain(record.entry.position);
            return;
        }
        this.queue(record.entry.position).closing.add(id);
        record.state.update(state => ({...state, phase: 'closing'}));
    }

    /** Completes only the instance named by an animation callback, never a newer matching toast. */
    closed(id: string): void {
        const record = this.records.get(id);
        if (!record || record.state().phase !== 'closing') return;
        const position = record.entry.position;
        this.remove(record);
        this.queue(position).nextAt = Date.now() + this.config.gapMs;
        this.drain(position);
    }

    /** Independently pauses pointer, keyboard focus and pending-action lifetimes. */
    pause(id: string, reason: InfoMessagePause, paused: boolean): void {
        const record = this.records.get(id);
        if (!record) return;
        this.suspendExpiry(record);
        if (paused) record.pauses.add(reason);
        else record.pauses.delete(reason);
        this.armExpiry(record);
    }

    /** Hidden documents retain remaining time and do not drain pending notifications. */
    setDocumentHidden(hidden: boolean): void {
        if (this.hidden === hidden) return;
        for (const record of this.records.values()) this.suspendExpiry(record);
        this.hidden = hidden;
        this.resumeDelivery();
    }

    /** Canvas-only presentation discards transient notices while retaining owner-controlled sticky conditions. */
    setPresentationEnabled(enabled: boolean): void {
        if (this.presentationEnabled === enabled) return;
        for (const record of this.records.values()) this.suspendExpiry(record);
        this.presentationEnabled = enabled;
        if (!enabled) {
            for (const record of [...this.records.values()]) {
                if (record.duration !== null) this.dismiss(record.entry.id);
            }
        }
        this.resumeDelivery();
    }

    /** Releases all pending admission/expiry callbacks and message references with the application. */
    ngOnDestroy(): void {
        this.destroyed = true;
        for (const queue of this.queues.values()) clearTimeout(queue.timer);
        for (const record of [...this.records.values()]) this.remove(record);
        this.queues.clear();
    }

    /** Creates a lightweight handle that cannot retain a closed message's content or UI components. */
    private reference(id: string): InfoMessageRef {
        const isActive = () => {
            const phase = this.records.get(id)?.state().phase;
            return phase === 'pending' || phase === 'visible';
        };
        return {
            id,
            get active() { return isActive(); },
            update: patch => this.update(id, patch),
            dismiss: () => this.dismiss(id)
        };
    }

    /** Updates content without counting or renewing expiry; a conflicting identity leaves both instances intact. */
    private update(id: string, patch: InfoMessageUpdate): boolean {
        const record = this.records.get(id);
        if (!record || record.state().phase === 'closing') return false;
        const next: InfoMessageState = {...record.state(), ...patch, action: patch.action === null ? undefined : patch.action ?? record.state().action};
        const key = this.duplicateKey(next, record.options);
        const collision = key ? this.duplicates.get(key) : undefined;
        if (collision && collision !== id) return false;
        this.unindex(record);
        record.key = key;
        if (key) this.duplicates.set(key, id);
        record.state.set(next);
        return true;
    }

    /** Exact tuples preserve semantic distinctions; explicit keys are scoped assertions by a producer. */
    private duplicateKey(state: InfoMessageState, options: InfoMessageOptions): string | undefined {
        if (options.duplicates === 'allow') return undefined;
        return JSON.stringify(options.dedupeKey !== undefined
            ? [state.scope, 'explicit', options.dedupeKey]
            : [state.scope, 'content', state.severity, state.summary, state.detail, state.action?.id, state.action?.label]);
    }

    /** Creates the small scheduler state for a physical stack on first use. */
    private queue(position: InfoMessagePosition): MessageQueue {
        let queue = this.queues.get(position);
        if (!queue) {
            queue = {pending: [], closing: new Set(), nextAt: 0};
            this.queues.set(position, queue);
        }
        return queue;
    }

    /** Admits the first available item now, then spaces subsequent admissions without postponing an existing timer. */
    private drain(position: InfoMessagePosition): void {
        const queue = this.queue(position);
        if (this.destroyed || this.hidden || !this.presentationEnabled || !queue.show || queue.closing.size || queue.timer) return;
        if (!queue.pending.length) return;
        const delay = Math.max(0, queue.nextAt - Date.now());
        if (delay > 0) {
            queue.timer = this.zone.runOutsideAngular(() => setTimeout(() => {
                queue.timer = undefined;
                this.drain(position);
            }, delay));
            return;
        }
        const record = this.records.get(queue.pending.shift()!);
        if (record) {
            record.state.update(state => ({...state, phase: 'visible'}));
            queue.nextAt = Date.now() + this.config.gapMs;
            this.zone.run(() => queue.show?.(record.entry));
        }
        this.drain(position);
    }

    /** Arms one expiry generation, so a stale callback cannot dismiss a refreshed instance. */
    private armExpiry(record: MessageRecord): void {
        if (!record.presented || record.state().phase !== 'visible' || record.duration === null ||
            record.pauses.size || this.hidden || !this.presentationEnabled) return;
        const generation = ++record.timerGeneration;
        record.deadline = Date.now() + record.remaining;
        record.timer = this.zone.runOutsideAngular(() => setTimeout(() => {
            if (record.timerGeneration === generation) this.dismiss(record.entry.id);
        }, record.remaining));
    }

    /** Stops a timer while retaining its unread duration for a pause. */
    private suspendExpiry(record: MessageRecord): void {
        if (record.deadline !== undefined) record.remaining = Math.max(0, record.deadline - Date.now());
        this.cancelExpiry(record);
    }

    /** Invalidates even a callback already queued by the event loop. */
    private cancelExpiry(record: MessageRecord): void {
        clearTimeout(record.timer);
        record.timer = undefined;
        record.deadline = undefined;
        ++record.timerGeneration;
    }

    /** Resumes eligible clocks and queues after a visibility-policy change. */
    private resumeDelivery(): void {
        for (const record of this.records.values()) this.armExpiry(record);
        for (const [position, queue] of this.queues) {
            clearTimeout(queue.timer);
            queue.timer = undefined;
            this.drain(position);
        }
    }

    /** Removes the duplicate mapping only if it still names this exact instance. */
    private unindex(record: MessageRecord): void {
        if (record.key && this.duplicates.get(record.key) === record.entry.id) this.duplicates.delete(record.key);
    }

    /** Releases internal state after pending cancellation, host teardown, or physical dismissal. */
    private remove(record: MessageRecord): void {
        this.unindex(record);
        this.cancelExpiry(record);
        const queue = this.queue(record.entry.position);
        queue.pending = queue.pending.filter(id => id !== record.entry.id);
        queue.closing.delete(record.entry.id);
        record.state.update(state => ({...state, phase: 'closed'}));
        this.records.delete(record.entry.id);
    }
}
