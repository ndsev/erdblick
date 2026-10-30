import {Component, EventEmitter, Input, OnChanges, OnDestroy, Output} from "@angular/core";
import {z} from "zod";
import {coreLib, ErdblickCore_, uint8ArrayToWasmOrThrow} from "../integrations/wasm.adapter";
import {styleAuthoringSchema} from "./style-authoring-schema.adapter";
import {StyleDocumentEdit, StyleDocumentModel} from "./style-document.model";
import {StyleRecordEditorComponent} from "./style-record-editor.component";
import {StyleInputProblem} from "./style-field-input.component";

const reportSchema = z.object({valid: z.boolean(), issues: z.array(z.object({
    message: z.string(), severity: z.string(), rulePath: z.string().optional(), property: z.string().optional()
}))});

@Component({
    selector: "style-document-editor",
    standalone: true,
    imports: [StyleRecordEditorComponent],
    styleUrl: "./style-form.scss",
    template: `
        <div class="style-form" data-testid="style-document-editor">
            @if (parseError) { <p class="style-form-error" role="alert">{{ parseError }}</p> }
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
                <fieldset [disabled]="!!parseError" class="style-form-body">
                    <style-record-editor [model]="model" [catalog]="catalog" [skipMetadata]="skipMetadata"
                        (edit)="apply($event)" (problem)="onProblem($event)"/>
                </fieldset>
            }
        </div>
    `
})
/** GUI for the complete native style model, sharing the editor's authoritative YAML source. */
export class StyleDocumentEditorComponent implements OnChanges, OnDestroy {
    @Input() source = "";
    @Input() skipMetadata = false;
    @Output() sourceChange = new EventEmitter<string>();
    @Output() invalidChange = new EventEmitter<boolean>();
    readonly catalog = styleAuthoringSchema();
    model?: StyleDocumentModel;
    parseError = "";
    editError = "";
    issues: z.infer<typeof reportSchema>["issues"] = [];
    private inputProblems = new Map<string, string>();
    private validationTimer?: ReturnType<typeof setTimeout>;
    private nativeValid = false;

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
        if (!this.model || this.parseError) return;
        try {
            const source = this.model.edit(edit);
            this.model = new StyleDocumentModel(source);
            this.source = source;
            this.editError = "";
            this.sourceChange.emit(source);
            this.scheduleValidation();
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
    ngOnDestroy(): void { if (this.validationTimer) clearTimeout(this.validationTimer); }
    /** Debounces native parsing; it remains the sole semantic validator for both editor tabs. */
    private scheduleValidation(): void {
        if (this.validationTimer) clearTimeout(this.validationTimer);
        this.nativeValid = false;
        // Input changes run during Angular's view check; defer output to the same
        // validation task rather than changing the parent's Apply state mid-check.
        this.validationTimer = setTimeout(() => {
            const lib: ErdblickCore_ = coreLib;
            try {
                const style = uint8ArrayToWasmOrThrow(buffer => new lib.FeatureLayerStyle(buffer), new TextEncoder().encode(this.source));
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
        this.invalidChange.emit(!!this.parseError || !!this.editError || !this.nativeValid || this.inputProblems.size > 0);
    }
}
