import {StyleField} from './style-authoring-schema.adapter';
import {StyleDocumentEdit, StyleDocumentModel, StylePath} from './style-document.model';

export type StyleRuleAction =
    | {kind: 'open'; path: StylePath; key: string; target: HTMLElement}
    | {kind: 'edit'; edit: StyleDocumentEdit}
    | {kind: 'remove-structure'; path: StylePath; label: string; target: HTMLElement}
    | {kind: 'draft-edit'; edit: StyleDocumentEdit}
    | {kind: 'problem'; path: string; message: string}
    | {kind: 'save' | 'dismiss' | 'delete'};

/** One source-backed property draft, shared by all rule depths in a document. */
export class StylePropertyDraft {
    model: StyleDocumentModel;
    readonly isNew: boolean;
    readonly problems = new Map<string, string>();
    error = '';

    /** Captures an immutable baseline; a new field's seed is staged only in this draft. */
    constructor(readonly base: StyleDocumentModel, readonly rulePath: StylePath, readonly key: string,
                readonly field: StyleField, readonly returnFocus: HTMLElement, seed: unknown) {
        this.model = base;
        this.isNew = !base.has(this.path);
        if (this.isNew) this.edit({op: 'set', path: this.path, value: seed, remove: field.exclusive});
    }
    get path(): StylePath { return [...this.rulePath, this.key]; }
    get dirty(): boolean { return this.isNew || this.model.source !== this.base.source || this.problems.size > 0 || !!this.error; }
    get canSave(): boolean { return !this.error && this.problems.size === 0; }

    /** Patches only the temporary AST; malformed primitive input is retained by its control. */
    edit(edit: StyleDocumentEdit): void {
        try {
            this.model = new StyleDocumentModel(this.model.edit(edit));
            this.error = '';
        } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    }

    /** Rejects stale commits instead of replacing newer source with an old snapshot. */
    commit(currentSource: string, remove = false): string {
        if (currentSource !== this.base.source) throw new Error('The source changed. Dismiss this panel and reopen the property.');
        if (remove) return this.base.edit({op: 'remove', path: this.path});
        if (!this.canSave) throw new Error('Correct the unfinished input before saving.');
        return this.model.source;
    }
}
