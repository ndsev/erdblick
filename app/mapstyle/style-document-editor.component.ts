import {Component, EventEmitter, Input, OnChanges, OnDestroy, Output, TemplateRef} from "@angular/core";
import {z} from "zod";
import {coreLib, ErdblickCore_, uint8ArrayToWasmOrThrow} from "../integrations/wasm.adapter";
import {styleAuthoringSchema} from "./style-authoring-schema.adapter";
import {StyleDocumentEdit, StyleDocumentModel} from "./style-document.model";
import {StyleRecordEditorComponent} from "./style-record-editor.component";
import {StyleFieldInputComponent, StyleInputProblem} from "./style-field-input.component";

import {StylePropertyDraft, StyleRuleAction} from './style-property-draft.controller';
import {styleFieldSeed} from './style-rule.presentation';
import {AppConfirmPopupComponent} from '../alert/app-confirm-popup.component';
import {AppConfirmPopupService} from '../alert/app-confirm-popup.service';

const reportSchema = z.object({valid: z.boolean(), issues: z.array(z.object({
    message: z.string(), severity: z.string(), rulePath: z.string().optional(), property: z.string().optional()
}))});

@Component({
    selector: "style-document-editor",
    standalone: true,
    imports: [StyleFieldInputComponent, StyleRecordEditorComponent, AppConfirmPopupComponent],
    template: `
        <div class="style-form" data-testid="style-document-editor">
            @if (parseError) { <p class="style-form-error" role="alert">{{ parseError }}</p> }
            @if (notice) { <p class="style-form-notice" role="status">{{ notice }}</p> }
            @if (editError) { <p class="style-form-error" role="alert">{{ editError }}</p> }
            @if (issues.length) {
                <ul class="style-form-issues" aria-label="Style validation">
                    @for (issue of issues; track $index) {
                        <li [class.style-form-error]="issue.severity === 'error'">
                            {{ issue.rulePath }}{{ issue.property ? ' · ' + issue.property : '' }}: {{ issue.message }}
                        </li>
                    }
                </ul>
            }
            @if (model) {
                <fieldset [disabled]="!!parseError && !draft" class="style-form-body">
                    <style-record-editor [model]="model" [catalog]="catalog" [skipMetadata]="skipMetadata" [metadataHeader]="metadataHeader" [ruleDraft]="draft" [propertyTemplate]="propertyEditor"
                        (edit)="apply($event)" (problem)="onProblem($event)" (ruleAction)="onRuleAction($event)"/>
                </fieldset>
            }
            <ng-template #propertyEditor let-panel let-scope="scope">
                @if (panel.field.kind === 'record') {
                    @if (panel.model.isRecord(panel.path)) {
                        <style-record-editor [model]="panel.model" [catalog]="catalog" [record]="panel.field.record" [path]="panel.path" [scope]="scope"
                            (edit)="onRuleAction({kind: 'draft-edit', edit: $event})" (problem)="onRuleAction({kind: 'problem', path: $event.path, message: $event.message})"/>
                    } @else {
                        <small class="style-form-error">Expected a record.</small>
                        <button type="button" (click)="replaceDraftRecord()">Replace with editable record</button>
                    }
                } @else {
                    <style-field-input [model]="panel.model" [field]="panel.field" [path]="panel.path" [scope]="scope"
                        (edit)="onRuleAction({kind: 'draft-edit', edit: $event})" (problem)="onRuleAction({kind: 'problem', path: $event.path, message: $event.message})"/>
                }
            </ng-template>
            <app-confirm-popup key="style-rule-remove" [baseZIndex]="32000"/>
        </div>
    `
})
/** GUI for the complete native style model, sharing the editor's authoritative YAML source. */
export class StyleDocumentEditorComponent implements OnChanges, OnDestroy {
    @Input() source = "";
    @Input() skipMetadata = false;
    @Input() metadataHeader?: TemplateRef<unknown>;
    @Output() sourceChange = new EventEmitter<string>();
    @Output() invalidChange = new EventEmitter<boolean>();
    @Output() panelChange = new EventEmitter<{open: boolean; dirty: boolean}>();
    draft?: StylePropertyDraft;
    notice = '';
    private focusFrame?: number;
    readonly catalog = styleAuthoringSchema();
    model?: StyleDocumentModel;
    parseError = "";
    editError = "";
    issues: z.infer<typeof reportSchema>["issues"] = [];
    private inputProblems = new Map<string, string>();
    private validationTimer?: ReturnType<typeof setTimeout>;
    private nativeValid = false;

    constructor(private readonly confirmation: AppConfirmPopupService) {}

    /** Handles rule actions at every depth through a single field draft. */
    onRuleAction(action: StyleRuleAction): void {
        if (action.kind === 'dismiss') { this.dismissPanel(); return; }
        if (!this.model || this.parseError) return;
        this.notice = '';
        if (action.kind === 'open') {
            if (this.draft?.dirty) { this.notice = 'Save or dismiss these changes first.'; return; }
            const field = this.catalog.records['rule'][action.key];
            this.draft = new StylePropertyDraft(this.model, action.path, action.key, field, action.target, styleFieldSeed(field, this.catalog));
            if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame);
            this.focusFrame = requestAnimationFrame(() => {
                const panel = document.getElementById(`${action.path.join('.')}-panel`);
                (panel?.querySelector<HTMLElement>('input, select, [contenteditable=true]') ?? panel?.querySelector('button'))?.focus();
            });
        } else if (action.kind === 'draft-edit') {
            this.draft?.edit(action.edit);
        } else if (action.kind === 'problem') {
            if (action.message) this.draft?.problems.set(action.path, action.message);
            else this.draft?.problems.delete(action.path);
        } else if (action.kind === 'save' || action.kind === 'delete') { this.savePanel(action.kind === 'delete'); return; }
        else if (action.kind === 'edit') { this.apply(action.edit); return; }
        else if (action.kind === 'remove-structure') {
            if (this.draft) return;
            const baseline = this.source;
            this.confirmation.confirm({key: 'style-rule-remove', target: action.target, header: `Delete ${action.label}?`,
                message: 'This removes the selected rule or section and its contents.', severity: 'error',
                accept: () => {
                    if (!this.draft && this.source === baseline) this.apply({op: 'remove', path: action.path});
                }});
            return;
        }
        this.scheduleValidation();
        this.publishPanelState();
    }

    /** Repairs a malformed composite only through an explicit draft replacement. */
    replaceDraftRecord(): void {
        if (this.draft) this.onRuleAction({kind: 'draft-edit', edit: {op: 'set', path: this.draft.path,
            value: styleFieldSeed(this.draft.field, this.catalog)}});
    }

    /** Commits a field once; full native validity remains enforced by the outer Apply action. */
    savePanel(remove = false): void {
        const draft = this.draft;
        if (!draft) return;
        try {
            const source = draft.commit(this.source, remove);
            this.dismissPanel();
            if (source !== this.source) this.publishSource(source);
        } catch (error) {
            draft.error = error instanceof Error ? error.message : String(error);
            this.publishPanelState();
        }
    }

    /** Drops only the open field's draft and returns keyboard focus to its overview. */
    dismissPanel(restoreFocus = true): void {
        const target = this.draft?.returnFocus;
        const fallback = target?.closest('article')?.querySelector<HTMLButtonElement>('.style-rule-add');
        this.draft = undefined;
        this.notice = '';
        this.scheduleValidation();
        this.publishPanelState();
        if (restoreFocus && target) {
            if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame);
            this.focusFrame = requestAnimationFrame(() => (target.isConnected ? target : fallback)?.focus());
        }
    }

    /** Reports pending input separately from the document buffer's dirty state. */
    private publishPanelState(): void {
        this.panelChange.emit({open: !!this.draft, dirty: !!this.draft?.dirty});
        this.reportValidity();
    }

    /** Publishes one complete source replacement through the shared editor session. */
    private publishSource(source: string): void {
        this.model = new StyleDocumentModel(source);
        this.source = source;
        this.editError = '';
        this.scheduleValidation();
        this.reportValidity();
        this.sourceChange.emit(source);
    }

    /** Refreshes the form from source, retaining its last parsed view during incomplete YAML edits. */
    ngOnChanges(): void {
        try {
            this.model = new StyleDocumentModel(this.source);
            this.parseError = "";
            this.editError = "";
        } catch (error) {
            this.parseError = `Correct the YAML syntax to resume form editing: ${error instanceof Error ? error.message : error}`;
        }
        this.scheduleValidation();
    }

    /** Publishes one AST patch through the ordinary editor session. */
    apply(edit: StyleDocumentEdit): void {
        if (!this.model || this.parseError || this.draft) return;
        try {
            this.publishSource(this.model.edit(edit));
        } catch (error) {
            this.editError = error instanceof Error ? error.message : String(error);
            this.invalidChange.emit(true);
        }
    }

    /** Keeps incomplete numeric input from silently applying the previous source value. */
    onProblem(problem: StyleInputProblem): void {
        if (problem.message) this.inputProblems.set(problem.path, problem.message);
        else this.inputProblems.delete(problem.path);
        this.reportValidity();
    }

    /** Releases pending work when the editor closes. */
    ngOnDestroy(): void {
        if (this.validationTimer) clearTimeout(this.validationTimer);
        if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame);
        this.confirmation.close();
    }

    /** Debounces native parsing; it remains the sole semantic validator for both editor tabs. */
    private scheduleValidation(): void {
        if (this.validationTimer) clearTimeout(this.validationTimer);
        this.nativeValid = false;
        // Input changes run during Angular's view check; defer output to the same
        // validation task rather than changing the parent's Apply state mid-check.
        this.validationTimer = setTimeout(() => {
            const lib: ErdblickCore_ = coreLib;
            try {
                const style = uint8ArrayToWasmOrThrow(buffer => new lib.FeatureLayerStyle(buffer), new TextEncoder().encode(this.draft?.model.source ?? this.source));
                try {
                    const report = reportSchema.parse(style.validationReport());
                    this.issues = report.issues;
                    this.nativeValid = report.valid;
                } finally { style.delete(); }
            } catch (error) {
                this.issues = [{severity: "error", message: error instanceof Error ? error.message : String(error)}];
            }
            this.reportValidity();
        }, 200);
    }

    /** Combines parse, native and local-buffer validity for the parent's Apply button. */
    private reportValidity(): void {
        this.invalidChange.emit(!!this.draft || !!this.parseError || !!this.editError || !this.nativeValid || this.inputProblems.size > 0);
    }
}
