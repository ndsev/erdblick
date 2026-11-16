/** Standalone documents supported by the editor workspace. */
export type EditorDocumentKind = 'style' | 'presets' | 'datasources' | 'preferences';

/** Presentation reset hook for the optional full-UI editor workspace. */
export const EDITOR_PRESENTATION_RESET_EVENT = 'erdblick-editors-presentation-reset';

/** Safe restoration metadata; source text and permissions are deliberately absent. */
export interface EditorDocumentDescriptor {
    id: string;
    kind: EditorDocumentKind;
    target?: string;
    sourceUrl?: string;
}

/** A diagnostic location is valid only for the source revision that produced it. */
export interface EditorDocumentLocation {
    line: number;
    column?: number;
    sourceHash?: string;
}

/** Commands exposed by a document without moving its domain logic into the shell. */
export interface EditorDocumentController {
    readonly title: string;
    readonly dirty: boolean;
    readonly busy: boolean;
    readonly saveLabel: string;
    readonly saveEnabled: boolean;
    readonly error: string;
    readonly enabled?: boolean;
    setEnabled?(enabled: boolean): void;
    save(): Promise<boolean>;
    activate?(location?: EditorDocumentLocation): void;
}

/** Stable, session-scoped commands injected into a retained document component. */
export interface EditorDocumentRef {
    readonly descriptor: EditorDocumentDescriptor;
    readonly id: string;
    changed(): void;
    close(event?: Event): void;
    rename(target: string, sourceUrl?: string): void;
    conflictingEditors(snapshot: Record<string, unknown>): string[];
}
