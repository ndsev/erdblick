import {Injectable} from '@angular/core';
import {BehaviorSubject, Observable, Subject} from 'rxjs';

/** Enumerates the editor modes supported by the shared code editor wrapper. */
export type EditorLanguage = 'yaml' | 'json';

/** Describes the initial state for one shared editor session. */
export interface EditorSessionConfig {
    id: string;
    source: string;
    readOnly?: boolean;
    language?: EditorLanguage;
}

/** Line-oriented navigation target for one shared editor session. */
export interface EditorRevealLocation {
    line: number;
    column?: number;
    length?: number;
}

/** Internal editor navigation request with an id so stale pending requests can be ignored. */
export interface EditorRevealRequest extends EditorRevealLocation {
    sessionId: string;
    requestId: number;
}

/** Represents a live shared editor session with reactive source and save channels. */
export interface EditorSession {
    id: string;
    source$: BehaviorSubject<string>;
    saveRequested$: Subject<void>;
    language: EditorLanguage;
    readOnly: boolean;
}

@Injectable()
/**
 * Owns transient editor sessions so multiple dialogs can share the same CodeMirror wrapper
 * without each dialog managing editor state itself.
 */
export class EditorService {

    private readonly sessions = new Map<string, EditorSession>();
    private readonly pendingRevealRequests = new Map<string, EditorRevealRequest>();
    private nextRevealRequestId = 0;
    readonly sessionChanged$ = new Subject<string>();
    readonly revealRequested$ = new Subject<EditorRevealRequest>();

    /** Creates or replaces an editor session and broadcasts that the session set changed. */
    createSession(config: EditorSessionConfig): EditorSession {
        const existingSession = this.sessions.get(config.id);
        if (existingSession) {
            this.disposeSession(existingSession);
        }

        const session: EditorSession = {
            id: config.id,
            source$: new BehaviorSubject<string>(config.source),
            saveRequested$: new Subject<void>(),
            language: config.language ?? 'yaml',
            readOnly: config.readOnly ?? false
        };
        this.sessions.set(session.id, session);
        this.sessionChanged$.next(session.id);
        return session;
    }

    /** Returns whether an editor session with the given id currently exists. */
    hasSession(id: string): boolean {
        return this.sessions.has(id);
    }

    /** Looks up one active editor session by id. */
    getSession(id: string): EditorSession | undefined {
        return this.sessions.get(id);
    }

    /** Returns the current source text for one editor session. */
    getSessionSource(id: string): string {
        return this.sessions.get(id)?.source$.getValue() ?? '';
    }

    /** Pushes new source text into an existing session if it actually changed. */
    updateSessionSource(id: string, source: string): void {
        const session = this.sessions.get(id);
        if (!session) {
            return;
        }
        if (session.source$.getValue() === source) {
            return;
        }
        session.source$.next(source);
    }

    /** Emits a save request for the given editor session. */
    requestSave(id: string): void {
        const session = this.sessions.get(id);
        session?.saveRequested$.next();
    }

    /** Exposes the save-request stream for one active editor session. */
    onSaveRequested(id: string): Observable<void> | undefined {
        return this.sessions.get(id)?.saveRequested$.asObservable();
    }

    /** Requests focus, scroll, and line highlighting for an active or soon-to-exist editor. */
    revealLocation(id: string, location: EditorRevealLocation): void {
        const line = Number.isFinite(location.line) ? Math.max(1, Math.floor(location.line)) : 1;
        const column = location.column !== undefined && Number.isFinite(location.column)
            ? Math.max(1, Math.floor(location.column))
            : undefined;
        const length = location.length !== undefined && Number.isFinite(location.length)
            ? Math.max(1, Math.floor(location.length))
            : undefined;
        const request: EditorRevealRequest = {
            sessionId: id,
            requestId: ++this.nextRevealRequestId,
            line,
            column,
            length
        };
        this.pendingRevealRequests.set(id, request);
        this.revealRequested$.next(request);
    }

    /** Returns and clears the latest pending reveal request for one session. */
    consumePendingRevealRequest(id: string): EditorRevealRequest | undefined {
        const request = this.pendingRevealRequests.get(id);
        if (request) {
            this.pendingRevealRequests.delete(id);
        }
        return request;
    }

    /** Clears a pending reveal request after it was applied from the live event stream. */
    clearPendingRevealRequest(id: string, requestId: number): void {
        const request = this.pendingRevealRequests.get(id);
        if (request?.requestId === requestId) {
            this.pendingRevealRequests.delete(id);
        }
    }

    /** Closes and disposes one editor session. */
    closeSession(id: string): void {
        const session = this.sessions.get(id);
        if (!session) {
            return;
        }
        this.disposeSession(session);
        this.sessions.delete(id);
        this.pendingRevealRequests.delete(id);
        this.sessionChanged$.next(id);
    }

    /** Completes the reactive resources owned by one editor session. */
    private disposeSession(session: EditorSession): void {
        session.saveRequested$.complete();
        session.source$.complete();
    }
}
