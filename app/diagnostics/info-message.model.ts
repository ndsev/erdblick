import {InjectionToken, Signal} from '@angular/core';

export type InfoMessageSeverity = 'success' | 'info' | 'warn' | 'error';
export type InfoMessagePosition = 'top-center' | 'top-right';
export type InfoMessagePhase = 'pending' | 'visible' | 'closing' | 'closed';
export type InfoMessagePause = 'pointer' | 'focus' | 'action';

/** An application-owned action; handlers belong to the UI host, never the message store. */
export interface InfoMessageAction {
    id: string;
    label: string;
}

/** Optional policy shared by the four severity convenience methods. */
export interface InfoMessageOptions {
    summary?: string;
    scope?: string;
    dedupeKey?: string;
    position?: InfoMessagePosition;
    life?: number | 'sticky';
    duplicates?: 'count' | 'allow';
    restartOnRepeat?: boolean;
    action?: InfoMessageAction;
}

/** A notification report, independent of PrimeNG and domain controllers. */
export interface InfoMessageInput extends InfoMessageOptions {
    severity: InfoMessageSeverity;
    detail: string;
}

/** Content changes are explicit updates, not additional occurrences. Identity and policy stay fixed. */
export type InfoMessageUpdate = Partial<Pick<InfoMessageInput, 'severity' | 'summary' | 'detail'>> & {
    action?: InfoMessageAction | null;
};

/** Read-only state rendered by one stable toast instance. */
export interface InfoMessageState {
    severity: InfoMessageSeverity;
    summary: string;
    detail: string;
    scope: string;
    action?: InfoMessageAction;
    count: number;
    phase: InfoMessagePhase;
}

/** The renderer retains this signal, so repeated reports never replace a PrimeNG message. */
export interface InfoMessageEntry {
    id: string;
    position: InfoMessagePosition;
    state: Signal<InfoMessageState>;
}

/** A reference affects only its original instance, even after a matching message reopens. */
export interface InfoMessageRef {
    readonly id: string;
    readonly active: boolean;
    update(patch: InfoMessageUpdate): boolean;
    dismiss(): void;
}

/** Host configuration; queue pacing can be disabled explicitly with a zero gap. */
export interface InfoMessageConfig {
    enabled: boolean;
    gapMs: number;
    maxPending: number;
}

export const DEFAULT_INFO_MESSAGE_CONFIG: Readonly<InfoMessageConfig> = {
    enabled: true, gapMs: 200, maxPending: 50
};

export const INFO_MESSAGE_CONFIG = new InjectionToken<Readonly<InfoMessageConfig>>('InfoMessageConfig', {
    providedIn: 'root', factory: () => DEFAULT_INFO_MESSAGE_CONFIG
});

export type InfoMessageActions = Readonly<Record<string, (() => void | Promise<void>) | undefined>>;
