import {DOCUMENT} from '@angular/common';
import {AfterViewInit, ChangeDetectionStrategy, Component, OnDestroy, inject, input, signal} from '@angular/core';
import {MessageService, ToastMessageOptions} from 'primeng/api';
import {ToastModule} from 'primeng/toast';
import {InfoMessageItemComponent} from './info-message-item.component';
import {InfoMessageActions, InfoMessageEntry, InfoMessagePosition} from './info-message.model';
import {InfoMessageService} from './info.service';

@Component({
    selector: 'info-message',
    standalone: true,
    imports: [ToastModule, InfoMessageItemComponent],
    providers: [MessageService],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @for (position of positions; track position) {
            <p-toast [position]="position" [key]="position" [baseZIndex]="9500"
                     [style]="{'max-height': 'calc(100dvh - 2rem)', 'overflow-y': 'auto', 'overscroll-behavior': 'contain'}"
                     [pt]="toastPassThrough" (onClose)="closed($event.message)"
                     [breakpoints]="{'600px': {width: 'calc(100vw - 2rem)', right: '1rem', left: '1rem', transform: 'none'}}">
                <ng-template #headless let-message let-closeFn="closeFn">
                    @if (entryFor(message); as entry) {
                        <info-message-item [entry]="entry" [closeToast]="closeFn" [actions]="actions()" />
                    }
                </ng-template>
            </p-toast>
        }
        <div class="info-message-announcement" role="status" aria-live="polite" aria-atomic="true">{{ announcement()?.text }}</div>
        <div class="info-message-announcement" role="alert" aria-atomic="true">{{ alertAnnouncement()?.text }}</div>
    `,
    styles: [`
        .info-message-announcement { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    `]
})
/** Sole PrimeNG notification host; the application service owns delivery, counting and time. */
export class InfoMessageComponent implements AfterViewInit, OnDestroy {
    readonly actions = input<InfoMessageActions>({});
    protected readonly positions: InfoMessagePosition[] = ['top-center', 'top-right'];
    // Badge updates are deliberately silent. Only a newly displayed message enters a live region.
    protected readonly toastPassThrough = {message: {role: 'presentation', 'aria-live': 'off', 'aria-atomic': 'false'}};
    protected readonly announcement = signal<{id: string; text: string} | null>(null);
    protected readonly alertAnnouncement = signal<{id: string; text: string} | null>(null);
    private readonly messages = inject(InfoMessageService);
    private readonly bus = inject(MessageService);
    private readonly document = inject(DOCUMENT);
    private readonly detachHosts: Array<() => void> = [];
    private observer?: MutationObserver;
    private destroyed = false;
    private readonly onVisibility = () => this.messages.setDocumentHidden(this.document.hidden);
    private readonly onPresentation = () => this.messages.setPresentationEnabled(!this.document.body.classList.contains('presentation-canvas-only'));

    /** Subscribes only after the child p-toast instances can receive their first queued message. */
    ngAfterViewInit(): void {
        this.onVisibility();
        this.onPresentation();
        this.document.addEventListener('visibilitychange', this.onVisibility);
        this.observer = new MutationObserver(this.onPresentation);
        this.observer.observe(this.document.body, {attributes: true, attributeFilter: ['class']});
        queueMicrotask(() => {
            if (this.destroyed) return;
            for (const position of this.positions) {
                this.detachHosts.push(this.messages.attachHost(position, entry => this.display(entry)));
            }
        });
    }

    /** Keeps the PrimeNG any-typed payload at this boundary; no domain data is read from it. */
    protected entryFor(message: ToastMessageOptions): InfoMessageEntry | undefined {
        return typeof message.id === 'string' ? this.messages.entry(message.id) : undefined;
    }

    /** Routes an animation completion by immutable instance ID, never by text or channel. */
    protected closed(message: ToastMessageOptions): void {
        if (typeof message.id !== 'string') return;
        this.messages.closed(message.id);
        for (const target of [this.announcement, this.alertAnnouncement]) {
            if (target()?.id === message.id) target.set(null);
        }
    }

    /** Emits one permanently sticky PrimeNG carrier; application timers close it through the headless callback. */
    private display(entry: InfoMessageEntry): void {
        const value = entry.state();
        this.bus.add({id: entry.id, key: entry.position, sticky: true,
            get severity() { return entry.state().severity; }});
        const target = value.severity === 'error' ? this.alertAnnouncement : this.announcement;
        target.set(null);
        queueMicrotask(() => {
            if (!this.destroyed && entry.state().phase === 'visible') {
                target.set({id: entry.id, text: `${value.summary}: ${value.detail}`});
            }
        });
    }

    /** Removes subscriptions and retires displayed instances before a future host can attach. */
    ngOnDestroy(): void {
        this.destroyed = true;
        this.observer?.disconnect();
        this.document.removeEventListener('visibilitychange', this.onVisibility);
        for (const detach of this.detachHosts) detach();
    }
}
