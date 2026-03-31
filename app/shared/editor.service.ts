import {Injectable} from '@angular/core';
import {BehaviorSubject, Observable, Subject} from 'rxjs';

export type EditorLanguage = 'yaml' | 'json';

export interface EditorSessionConfig {
    id: string;
    source: string;
    readOnly?: boolean;
    language?: EditorLanguage;
}

export interface EditorSession {
    id: string;
    source$: BehaviorSubject<string>;
    saveRequested$: Subject<void>;
    language: EditorLanguage;
    readOnly: boolean;
}

@Injectable()
export class EditorService {

    private readonly sessions = new Map<string, EditorSession>();
    readonly sessionChanged$ = new Subject<string>();

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

    hasSession(id: string): boolean {
        return this.sessions.has(id);
    }

    getSession(id: string): EditorSession | undefined {
        return this.sessions.get(id);
    }

    getSessionSource(id: string): string {
        return this.sessions.get(id)?.source$.getValue() ?? '';
    }

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

    requestSave(id: string): void {
        const session = this.sessions.get(id);
        session?.saveRequested$.next();
    }

    onSaveRequested(id: string): Observable<void> | undefined {
        return this.sessions.get(id)?.saveRequested$.asObservable();
    }

    closeSession(id: string): void {
        const session = this.sessions.get(id);
        if (!session) {
            return;
        }
        this.disposeSession(session);
        this.sessions.delete(id);
        this.sessionChanged$.next(id);
    }

    private disposeSession(session: EditorSession): void {
        session.saveRequested$.complete();
        session.source$.complete();
    }
}
