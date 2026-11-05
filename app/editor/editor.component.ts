import {
    AfterViewInit,
    Component,
    ElementRef,
    Input,
    OnChanges,
    OnDestroy,
    Renderer2,
    SimpleChanges,
    ViewChild
} from '@angular/core';
import {basicSetup} from 'codemirror';
import {
    Compartment,
    EditorState,
    Extension,
    StateEffect,
    StateField
} from '@codemirror/state';
import {autocompletion, CompletionContext, CompletionSource} from '@codemirror/autocomplete';
import {json, jsonParseLinter} from '@codemirror/lang-json';
import {yaml} from '@codemirror/lang-yaml';
import {
    Decoration,
    DecorationSet,
    EditorView,
    keymap,
    ViewUpdate
} from '@codemirror/view';
import {linter, Diagnostic, lintGutter} from '@codemirror/lint';
import {defaultHighlightStyle, syntaxHighlighting} from '@codemirror/language';
import {oneDark} from '@codemirror/theme-one-dark';
import {Subscription} from 'rxjs';
import * as jsyaml from 'js-yaml';
import {EditorRevealRequest, EditorService} from './editor.service';

import {styleAuthoringCompletions} from "../mapstyle/style-authoring-schema.adapter";

const setHighlightedLine = StateEffect.define<number | null>();

const highlightedLineField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(highlights, transaction) {
        highlights = highlights.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (!effect.is(setHighlightedLine)) {
                continue;
            }
            if (effect.value === null) {
                return Decoration.none;
            }
            const line = transaction.state.doc.line(effect.value);
            return Decoration.set([
                Decoration.line({class: 'editor-line-highlight'}).range(line.from)
            ]);
        }
        return highlights;
    },
    provide: field => EditorView.decorations.from(field)
});

const highlightedLineTheme = EditorView.theme({
    '.cm-line.editor-line-highlight': {
        backgroundColor: 'color-mix(in srgb, var(--p-message-error-color, #ef4444) 18%, transparent)',
        outline: '1px solid var(--p-message-error-color, #ef4444)',
        outlineOffset: '-1px'
    }
});

@Component({
    selector: 'editor',
    template: `
        <div #editor class="editor-container"></div>
    `,
    standalone: false
})
/**
 * Wraps CodeMirror so dialogs can attach a shared editor session by id instead of each
 * dialog owning its own editor implementation details.
 */
export class EditorComponent implements AfterViewInit, OnChanges, OnDestroy {

    @Input({required: true}) sessionId!: string;
    @ViewChild('editor') private editorRef!: ElementRef;

    private editorView?: EditorView;
    private sessionSourceSubscription?: Subscription;
    private sessionChangedSubscription?: Subscription;
    private revealRequestedSubscription?: Subscription;
    private modeObserver?: MutationObserver;
    private themeComp = new Compartment();
    private viewReady = false;
    private readonly DARK_MODE_CLASS = 'erdblick-dark';

    /** Captures the shared editor-session service and DOM renderer used by the wrapper. */
    constructor(private readonly editorService: EditorService,
                private readonly renderer: Renderer2) {}

    /** Creates the initial editor view and starts listening for session replacement events. */
    ngAfterViewInit(): void {
        this.viewReady = true;
        this.sessionChangedSubscription = this.editorService.sessionChanged$.subscribe(changedSessionId => {
            if (changedSessionId === this.sessionId) {
                this.initializeEditor();
            }
        });
        this.revealRequestedSubscription = this.editorService.revealRequested$.subscribe(request => {
            if (request.sessionId === this.sessionId) {
                this.applyRevealRequest(request);
            }
        });
        this.initializeEditor();
    }

    /** Rebuilds the editor when the bound session id changes. */
    ngOnChanges(changes: SimpleChanges): void {
        if (!this.viewReady) {
            return;
        }
        if (changes['sessionId']) {
            this.initializeEditor();
        }
    }

    /** Disposes editor-owned subscriptions, observers, and CodeMirror state. */
    ngOnDestroy(): void {
        this.modeObserver?.disconnect();
        this.sessionSourceSubscription?.unsubscribe();
        this.sessionChangedSubscription?.unsubscribe();
        this.revealRequestedSubscription?.unsubscribe();
        this.editorView?.destroy();
    }

    /** Recreates the CodeMirror instance for the currently selected editor session. */
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
        this.applyPendingRevealRequest();

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

    /** Removes any previously mounted CodeMirror DOM before a new view is created. */
    private clearEditorHost(): void {
        const childElements = this.editorRef.nativeElement.childNodes;
        for (const child of childElements) {
            this.renderer.removeChild(this.editorRef.nativeElement, child);
        }
    }

    /** Builds the CodeMirror state for the active editor session, including theme wiring. */
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
                highlightedLineField,
                highlightedLineTheme,
                EditorView.updateListener.of((update: ViewUpdate) => {
                    this.editorService.updateSessionSource(this.sessionId, update.state.doc.toString());
                }),
                this.themeComp.of(isDark ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)])
            ]
        });
    }

    /** Selects language-specific CodeMirror extensions for YAML or JSON editing. */
    private languageExtensions(language: 'yaml' | 'json'): Extension[] {
        if (language === 'json') {
            return [
                json(),
                lintGutter(),
                this.jsonLinter
            ];
        }
        return [
            yaml(),
            autocompletion({override: [this.styleCompletions]}),
            lintGutter(),
            this.yamlLinter
        ];
    }

    /** Validates JSON source and surfaces parser errors inside the editor gutter. */
    private jsonLinter: Extension = linter(jsonParseLinter());

    /** Validates YAML source and maps parser errors back into editor positions. */
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

    /** Prevents middle-click paste behavior from interfering with the editor. */
    private stopMouseWheelClipboard: Extension = EditorView.domEventHandlers({
        mousedown: (event) => {
            if (event.button === 1) {
                event.preventDefault();
                return true;
            }
            return false;
        }
    });

    /** Provides lightweight style-YAML completions for the shared editor. */
    private styleCompletions: CompletionSource = (context: CompletionContext) => {
        const word = context.matchBefore(/\w*/);
        if (!word || (word.from === word.to && !context.explicit)) {
            return null;
        }
        return {
            from: word.from,
            options: styleAuthoringCompletions()
        };
    };

    /** Returns the standard save keybinding used by editor-hosting dialogs. */
    private saveCmd() {
        return {
            key: 'Mod-s',
            run: () => {
                this.editorService.requestSave(this.sessionId);
                return true;
            }
        };
    }

    /** Applies any reveal request that arrived before this CodeMirror view existed. */
    private applyPendingRevealRequest(): void {
        const request = this.editorService.consumePendingRevealRequest(this.sessionId);
        if (request) {
            this.applyRevealRequest(request);
        }
    }

    /** Focuses the editor, selects the requested source range, and highlights its line. */
    private applyRevealRequest(request: EditorRevealRequest): void {
        const view = this.editorView;
        if (!view) {
            return;
        }
        const lineNumber = Math.min(Math.max(1, request.line), view.state.doc.lines);
        const line = view.state.doc.line(lineNumber);
        const selectionFrom = this.selectionStart(line, request.column);
        view.dispatch({
            selection: {anchor: selectionFrom},
            effects: [
                setHighlightedLine.of(lineNumber),
                EditorView.scrollIntoView(selectionFrom, {y: 'center'})
            ]
        });
        view.focus();
        this.editorService.clearPendingRevealRequest(request.sessionId, request.requestId);
    }

    /** Converts the one-based validation column into a CodeMirror document offset. */
    private selectionStart(line: {from: number; to: number}, column: number | undefined): number {
        if (column === undefined) {
            return line.from;
        }
        return Math.min(line.to, line.from + Math.max(0, column - 1));
    }
}
