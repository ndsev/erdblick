import {AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal} from '@angular/core';
import {BadgeModule} from 'primeng/badge';
import {ButtonModule} from 'primeng/button';
import {InfoMessageActions, InfoMessageEntry} from './info-message.model';
import {InfoMessageService} from './info.service';

@Component({
    selector: 'info-message-item',
    standalone: true,
    imports: [BadgeModule, ButtonModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        '(mouseenter)': 'messages.pause(entry().id, "pointer", true)',
        '(mouseleave)': 'messages.pause(entry().id, "pointer", false)',
        '(focusin)': 'messages.pause(entry().id, "focus", true)',
        '(focusout)': 'onFocusOut($event)'
    },
    template: `
        <div class="info-message-content" data-testid="info-message"
             [attr.data-message-id]="entry().id" [attr.data-message-scope]="value().scope"
             [attr.data-count]="value().count" role="group" [attr.aria-label]="value().summary">
            <i [class]="'pi ' + icon() + ' info-message-icon'" aria-hidden="true"></i>
            <div class="info-message-text">
                <div class="info-message-heading">
                    <strong>{{ value().summary }}</strong>
                    <p-badge [value]="badge()" [severity]="badgeSeverity()" data-testid="info-message-count"
                             [attr.aria-label]="value().count + ' occurrences'" [title]="value().count + ' occurrences'" />
                </div>
                <div class="info-message-detail">{{ value().detail }}</div>
                @if (value().action; as action) {
                    <p-button [label]="action.label" size="small" [text]="true" [loading]="busy()"
                              [disabled]="!handler() || busy()" (onClick)="activate()"
                              data-testid="info-message-action" />
                }
                @if (actionError()) {
                    <div class="info-message-action-error" role="status">{{ actionError() }}</div>
                }
            </div>
            <button type="button" class="info-message-close" aria-label="Dismiss notification"
                    data-testid="info-message-close" (click)="messages.dismiss(entry().id)">
                <i class="pi pi-times" aria-hidden="true"></i>
            </button>
        </div>
    `,
    styles: [`
        :host { display: block; }
        .info-message-content { display: flex; align-items: flex-start; gap: .75rem; padding: 1rem; }
        .info-message-icon { font-size: 1.25rem; margin-top: .15rem; }
        .info-message-text { flex: 1; min-width: 0; }
        .info-message-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
        .info-message-detail, .info-message-action-error { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: .35rem; }
        .info-message-action-error { font-weight: 500; }
        .info-message-close { border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; padding: .35rem; }
        .info-message-close:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    `]
})
/** Adapts one headless PrimeNG item to application-owned lifecycle, count and action state. */
export class InfoMessageItemComponent implements AfterViewInit, OnDestroy {
    readonly entry = input.required<InfoMessageEntry>();
    readonly closeToast = input.required<(event: Event) => void>();
    readonly actions = input<InfoMessageActions>({});
    protected readonly messages = inject(InfoMessageService);
    private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
    protected readonly value = computed(() => this.entry().state());
    protected readonly busy = signal(false);
    protected readonly actionError = signal('');
    protected readonly badge = computed(() => this.value().count > 99 ? '99+' : String(this.value().count));
    protected readonly badgeSeverity = computed(() => {
        const severity = this.value().severity;
        return severity === 'error' ? 'danger' : severity;
    });
    protected readonly icon = computed(() => ({success: 'pi-check-circle', info: 'pi-info-circle', warn: 'pi-exclamation-triangle', error: 'pi-times-circle'})[this.value().severity]);
    protected readonly handler = computed(() => this.actions()[this.value().action?.id ?? '']);
    private destroyed = false;
    private closeRequested = false;

    /** Connects logical dismissal to PrimeNG's public per-item close callback. */
    constructor() {
        effect(() => {
            if (this.value().phase === 'closing' && !this.closeRequested) {
                this.closeRequested = true;
                this.closeToast()(new Event('notification-dismiss'));
            }
        });
    }

    /** A queued message receives its full lifetime only once its content exists. */
    ngAfterViewInit(): void {
        this.messages.presented(this.entry().id);
    }

    /** Retains a focus pause while focus moves between controls inside this item. */
    protected onFocusOut(event: FocusEvent): void {
        if (!(event.relatedTarget instanceof Node) || !this.element.nativeElement.contains(event.relatedTarget)) {
            this.messages.pause(this.entry().id, 'focus', false);
        }
    }

    /** Runs one UI-owned action and closes only this instance after successful completion. */
    protected async activate(): Promise<void> {
        const action = this.value().action;
        const handler = this.handler();
        if (this.busy() || !handler || !action || this.value().phase !== 'visible') return;
        this.busy.set(true);
        this.actionError.set('');
        const id = this.entry().id;
        this.messages.pause(id, 'action', true);
        try {
            await handler();
            if (!this.destroyed && this.value().action?.id === action.id) this.messages.dismiss(id);
        } catch (error) {
            if (!this.destroyed) this.actionError.set(error instanceof Error ? error.message : String(error));
        } finally {
            if (!this.destroyed) {
                this.busy.set(false);
                this.messages.pause(id, 'action', false);
            }
        }
    }

    /** Prevents late action completions from mutating a retired component. */
    ngOnDestroy(): void {
        this.destroyed = true;
    }
}
