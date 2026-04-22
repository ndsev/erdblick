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
    readonly sessionChanged$ = new Subject<string>();

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

    /** Closes and disposes one editor session. */
    closeSession(id: string): void {
        const session = this.sessions.get(id);
        if (!session) {
            return;
        }
        this.disposeSession(session);
        this.sessions.delete(id);
        this.sessionChanged$.next(id);
    }

    /** Completes the reactive resources owned by one editor session. */
    private disposeSession(session: EditorSession): void {
        session.saveRequested$.complete();
        session.source$.complete();
    }
}
