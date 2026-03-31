import {AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, Renderer2, SimpleChanges, ViewChild} from '@angular/core';
import {basicSetup} from 'codemirror';
import {Compartment, EditorState, Extension} from '@codemirror/state';
import {autocompletion, CompletionContext, CompletionSource} from '@codemirror/autocomplete';
import {json} from '@codemirror/lang-json';
import {yaml} from '@codemirror/lang-yaml';
import {EditorView, keymap, ViewUpdate} from '@codemirror/view';
import {linter, Diagnostic, lintGutter} from '@codemirror/lint';
import {defaultHighlightStyle, syntaxHighlighting} from '@codemirror/language';
import {oneDark} from '@codemirror/theme-one-dark';
import {Subscription} from 'rxjs';
import * as jsyaml from 'js-yaml';
import {EditorService} from './editor.service';

const completionsList = [
    {label: 'version', type: 'property'},
    {label: 'name', type: 'property'},
    {label: 'rules', type: 'property'},
    {label: 'geometry', type: 'property'},
    {label: 'stage', type: 'property'},
    {label: 'lod', type: 'property'},
    {label: 'aspect', type: 'property'},
    {label: 'mode', type: 'property'},
    {label: 'fidelity', type: 'property'},
    {label: 'type', type: 'property'},
    {label: 'filter', type: 'property'},
    {label: 'selectable', type: 'property'},
    {label: 'color', type: 'property'},
    {label: 'color-expression', type: 'property'},
    {label: 'opacity', type: 'property'},
    {label: 'width', type: 'property'},
    {label: 'depth-test', type: 'property'},
    {label: 'flat', type: 'property'},
    {label: 'outline-color', type: 'property'},
    {label: 'outline-width', type: 'property'},
    {label: 'offset', type: 'property'},
    {label: 'vertical-offset', type: 'property'},
    {label: 'offset-increment', type: 'property'},
    {label: 'arrow', type: 'property'},
    {label: 'dashed', type: 'property'},
    {label: 'gap-color', type: 'property'},
    {label: 'dash-length', type: 'property'},
    {label: 'dash-pattern', type: 'property'},
    {label: 'relation-type', type: 'property'},
    {label: 'relation-line-height-offset', type: 'property'},
    {label: 'relation-line-end-markers', type: 'property'},
    {label: 'relation-source-style', type: 'property'},
    {label: 'relation-target-style', type: 'property'},
    {label: 'relation-recursive', type: 'property'},
    {label: 'relation-merge-twoway', type: 'property'},
    {label: 'relation-merge-twoway', type: 'property'},
    {label: 'label-color', type: 'property'},
    {label: 'label-outline-color', type: 'property'},
    {label: 'label-font', type: 'property'},
    {label: 'label-background-color', type: 'property'},
    {label: 'label-background-padding', type: 'property'},
    {label: 'label-horizontal-origin', type: 'property'},
    {label: 'label-vertical-origin', type: 'property'},
    {label: 'label-text-expression', type: 'property'},
    {label: 'label-text', type: 'property'},
    {label: 'label-style', type: 'property'},
    {label: 'label-scale', type: 'property'},
    {label: 'label-pixel-offset', type: 'property'},
    {label: 'label-eye-offset', type: 'property'},
    {label: 'first-of', type: 'property'},
    {label: 'attribute-type', type: 'property'},
    {label: 'attribute-filter', type: 'property'},
    {label: 'attribute-layer-type', type: 'property'},
    {label: 'point-merge-grid-cell', type: 'property'},
    {label: 'FILL', type: 'keyword'},
    {label: 'OUTLINE', type: 'keyword'},
    {label: 'FILL_AND_OUTLINE', type: 'keyword'},
    {label: 'point', type: 'keyword'},
    {label: 'mesh', type: 'keyword'},
    {label: 'line', type: 'keyword'},
    {label: 'polygon', type: 'keyword'},
    {label: 'double', type: 'keyword'},
    {label: 'forward', type: 'keyword'},
    {label: 'backward', type: 'keyword'},
    {label: 'LEFT', type: 'keyword'},
    {label: 'CENTER', type: 'keyword'},
    {label: 'RIGHT', type: 'keyword'},
    {label: 'ABOVE', type: 'keyword'},
    {label: 'BELOW', type: 'keyword'},
    {label: 'BASELINE', type: 'keyword'},
    {label: 'feature', type: 'keyword'},
    {label: 'relation', type: 'keyword'},
    {label: 'attribute', type: 'keyword'},
    {label: 'none', type: 'keyword'},
    {label: 'low', type: 'keyword'},
    {label: 'high', type: 'keyword'},
    {label: 'any', type: 'keyword'},
    {label: 'selection', type: 'keyword'},
    {label: 'hover', type: 'keyword'},
    {label: 'Lane', type: 'keyword'},
    {label: 'Boundary', type: 'keyword'}
];

@Component({
    selector: 'editor',
    template: `
        <div #editor class="editor-container"></div>
    `,
    styles: [],
    standalone: false
})
export class EditorComponent implements AfterViewInit, OnChanges, OnDestroy {

    @Input({required: true}) sessionId!: string;
    @ViewChild('editor') private editorRef!: ElementRef;

    private editorView?: EditorView;
    private sessionSourceSubscription?: Subscription;
    private sessionChangedSubscription?: Subscription;
    private modeObserver?: MutationObserver;
    private themeComp = new Compartment();
    private viewReady = false;
    private readonly DARK_MODE_CLASS = 'erdblick-dark';

    constructor(private readonly editorService: EditorService,
                private readonly renderer: Renderer2) {}

    ngAfterViewInit(): void {
        this.viewReady = true;
        this.sessionChangedSubscription = this.editorService.sessionChanged$.subscribe(changedSessionId => {
            if (changedSessionId === this.sessionId) {
                this.initializeEditor();
            }
        });
        this.initializeEditor();
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!this.viewReady) {
            return;
        }
        if (changes['sessionId']) {
            this.initializeEditor();
        }
    }

    ngOnDestroy(): void {
        this.modeObserver?.disconnect();
        this.sessionSourceSubscription?.unsubscribe();
        this.sessionChangedSubscription?.unsubscribe();
        this.editorView?.destroy();
    }

    private initializeEditor(): void {
        const session = this.editorService.getSession(this.sessionId);
        this.sessionSourceSubscription?.unsubscribe();
        this.editorView?.destroy();
        this.clearEditorHost();
        if (!session) {
            return;
        }

        this.editorView = new EditorView({
            state: this.createEditorState(),
            parent: this.editorRef.nativeElement
        });

        this.sessionSourceSubscription = session.source$.subscribe(source => {
            const view = this.editorView;
            if (!view || view.state.doc.toString() === source) {
                return;
            }
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: source
                }
            });
        });

        const root = document.documentElement;
        this.modeObserver?.disconnect();
        this.modeObserver = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type !== 'attributes' || record.attributeName !== 'class') {
                    continue;
                }
                const isDark = root.classList.contains(this.DARK_MODE_CLASS);
                const lightTheme = EditorView.theme({}, {dark: false});
                this.editorView?.dispatch({
                    effects: this.themeComp.reconfigure(
                        isDark ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]
                    )
                });
            }
        });
        this.modeObserver.observe(root, {attributes: true, attributeFilter: ['class']});
    }

    private clearEditorHost(): void {
        const childElements = this.editorRef.nativeElement.childNodes;
        for (const child of childElements) {
            this.renderer.removeChild(this.editorRef.nativeElement, child);
        }
    }

    private createEditorState(): EditorState {
        const session = this.editorService.getSession(this.sessionId);
        if (!session) {
            return EditorState.create();
        }
        const root = document.documentElement;
        const isDark = root.classList.contains(this.DARK_MODE_CLASS);
        const lightTheme = EditorView.theme({}, {dark: false});
        const languageExtensions = this.languageExtensions(session.language);

        return EditorState.create({
            doc: session.source$.getValue(),
            extensions: [
                basicSetup,
                ...languageExtensions,
                keymap.of([this.saveCmd()]),
                this.stopMouseWheelClipboard,
                EditorState.tabSize.of(2),
                EditorState.readOnly.of(session.readOnly),
                EditorView.updateListener.of((update: ViewUpdate) => {
                    this.editorService.updateSessionSource(this.sessionId, update.state.doc.toString());
                }),
                this.themeComp.of(isDark ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)])
            ]
        });
    }

    private languageExtensions(language: 'yaml' | 'json'): Extension[] {
        if (language === 'json') {
            return [json()];
        }
        return [
            yaml(),
            autocompletion({override: [this.styleCompletions]}),
            lintGutter(),
            this.yamlLinter
        ];
    }

    private yamlLinter: Extension = linter((view) => {
        return new Promise((resolve) => {
            const results: Diagnostic[] = [];
            const doc = view.state.doc.toString();
            try {
                jsyaml.load(doc);
            } catch (error: any) {
                if (error.mark && error.mark.line) {
                    const pos = view.state.doc.line(error.mark.line + 1).from + error.mark.column;
                    results.push({
                        from: pos,
                        to: pos + 1,
                        severity: 'error',
                        message: error.message
                    });
                }
            }
            resolve(results);
        });
    });

    private stopMouseWheelClipboard: Extension = EditorView.domEventHandlers({
        mousedown: (event) => {
            if (event.button === 1) {
                event.preventDefault();
                return true;
            }
            return false;
        }
    });

    private styleCompletions: CompletionSource = (context: CompletionContext) => {
        const word = context.matchBefore(/\w*/);
        if (!word || (word.from === word.to && !context.explicit)) {
            return null;
        }
        return {
            from: word.from,
            options: completionsList
        };
    };

    private saveCmd() {
        return {
            key: 'Mod-s',
            run: () => {
                this.editorService.requestSave(this.sessionId);
                return true;
            }
        };
    }
}
