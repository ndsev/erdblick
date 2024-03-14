import {Component, ViewChild, ElementRef, AfterViewInit, OnDestroy, Input, Renderer2} from '@angular/core';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { yaml } from '@codemirror/lang-yaml';
import { autocompletion, CompletionContext, CompletionSource } from '@codemirror/autocomplete';
import { EditorView, ViewUpdate } from '@codemirror/view';
import { linter, Diagnostic, lintGutter } from '@codemirror/lint';
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language"
import { StyleService } from "./style.service";
import * as jsyaml from 'js-yaml';

const completionsList = [
    {label: "version", type: "property"},
    {label: "name", type: "property"},
    {label: "rules", type: "property"},
    {label: "opacity", type: "property"},
    {label: "label-color", type: "property"},
    {label: "label-outline-color", type: "property"},
    {label: "label-font", type: "property"},
    {label: "label-background-color", type: "property"},
    {label: "label-background-padding", type: "property"},
    {label: "label-horizontal-origin", type: "property"},
    {label: "label-vertical-origin", type: "property"},
    {label: "label-text-expression", type: "property"},
    {label: "label-text", type: "property"},
    {label: "label-style", type: "property"},
    {label: "label-scale", type: "property"},
    {label: "label-pixel-offset", type: "property"},
    {label: "label-eye-offset", type: "property"},
    {label: "translucency-by-distance", type: "property"},
    {label: "geometry", type: "property"},
    {label: "type", type: "property"},
    {label: "filter", type: "property"},
    {label: "color", type: "property"},
    {label: "opacity", type: "property"},
    {label: "width", type: "property"},
    {label: "flat", type: "property"},
    {label: "false", type: "property"},
    {label: "outline-color", type: "property"},
    {label: "outline-width", type: "property"},
    {label: "near-far-scale", type: "property"},
    {label: "arrow", type: "property"},
    {label: "dashed", type: "property"},
    {label: "gap-color", type: "property"},
    {label: "dash-length", type: "property"},
    {label: "dash-pattern", type: "property"},
    {label: "first-of", type: "property"},
    {label: "FILL", type: "keyword"},
    {label: "OUTLINE", type: "keyword"},
    {label: "FILL_AND_OUTLINE", type: "keyword"},
    {label: "point", type: "keyword"},
    {label: "mesh", type: "keyword"},
    {label: "line", type: "keyword"},
    {label: "polygon", type: "keyword"},
    {label: "double", type: "keyword"},
    {label: "forward", type: "keyword"},
    {label: "backward", type: "keyword"},
    {label: "LEFT", type: "keyword"},
    {label: "CENTER", type: "keyword"},
    {label: "RIGHT", type: "keyword"},
    {label: "ABOVE", type: "keyword"},
    {label: "BELOW", type: "keyword"},
    {label: "BASELINE", type: "keyword"}
]

@Component({
    selector: 'editor',
    template: `
        <div #editor class="editor-container"></div>
    `,
    styles: []
})
export class EditorComponent implements AfterViewInit, OnDestroy {

    @ViewChild('editor') private editorRef!: ElementRef;

    private editorView?: EditorView;
    private styleData: string = "";

    constructor(public styleService: StyleService,
                public renderer: Renderer2) {}

    ngAfterViewInit(): void {
        this.styleService.selectedStyleIdForEditing.subscribe(styleId => {
            if (styleId) {
                const childElements = this.editorRef.nativeElement.childNodes;
                for (let child of childElements) {
                    this.renderer.removeChild(this.editorRef.nativeElement, child);
                }
                this.editorView = new EditorView({
                    state: this.createEditorState(),
                    parent: this.editorRef.nativeElement
                });
            }
        });
    }

    createEditorState() {
        const styleId = this.styleService.selectedStyleIdForEditing.getValue();
        if (this.styleService.styleData.has(styleId)) {
            this.styleData = `${this.styleService.styleData.get(styleId)!.data}\n\n\n\n\n`;
        } else {
            this.styleData = "";
        }
        return EditorState.create({
            doc: this.styleData,
            extensions: [
                basicSetup,
                yaml(),
                syntaxHighlighting(defaultHighlightStyle),
                autocompletion({override: [this.styleCompletions]}),
                lintGutter(),
                this.yamlLinter,
                EditorState.tabSize.of(2),
                EditorView.updateListener.of((e: ViewUpdate) => {
                    this.styleService.styleEditedStateData.next(e.state.doc.toString());
                })
            ]
        });
    }

    ngOnDestroy(): void {
        this.editorView?.destroy();
    }

    yamlLinter = linter((view) => {
        return new Promise((resolve) => {
            const results: Diagnostic[] = [];
            const doc = view.state.doc.toString();
            try {
                jsyaml.load(doc);
            } catch (e: any) {
                if (e.mark && e.mark.line) {
                    const pos = view.state.doc.line(e.mark.line + 1).from + e.mark.column;
                    results.push({
                        from: pos,
                        to: pos + 1,
                        severity: 'error',
                        message: e.message,
                    });
                }
            }
            resolve(results);
        });
    });

    styleCompletions: CompletionSource = (context: CompletionContext) => {
        let word = context.matchBefore(/\w*/);
        if (!word) {
            return null;
        }
        if (word.from == word.to && !context.explicit) {
            return null;
        }
        return {
            from: word.from,
            options: completionsList
        }
    };
}