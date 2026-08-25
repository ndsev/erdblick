import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    Renderer2,
    SimpleChanges,
    ViewChild
} from "@angular/core";
import {basicSetup} from "codemirror";
import {Compartment, EditorState, Extension, Prec} from "@codemirror/state";
import {EditorView, keymap, placeholder, ViewUpdate} from "@codemirror/view";
import {syntaxHighlighting} from "@codemirror/language";
import {debounceTime, distinctUntilChanged, Subject, Subscription} from "rxjs";
import {FeatureSearchMapLayerRef, FeatureSearchScope} from "../shared/feature-search-state";
import {currentInlineCodeMirrorTheme} from "../shared/codemirror-theme";
import {CompletionCandidate} from "./search.model";
import {FeatureSearchService} from "./feature.search.service";
import {SearchCompletionPopupComponent} from "./search-completion-popup.component";
import {simfilHighlightStyle, simfilLanguage} from "./simfil-language";

@Component({
    selector: "simfil-expression-input",
    template: `
        <div class="simfil-expression-input"
             [class.simfil-expression-input-disabled]="disabled">
            <div #editorHost class="simfil-expression-editor-host"></div>
            <search-completion-popup
                [visible]="completion.visible"
                [pending]="completion.pending"
                [items]="completionItems"
                [selectionIndex]="completion.selectionIndex"
                [zIndex]="completionZIndex"
                (popupMouseDown)="onCompletionPopupDown($event)"
                (candidateSelected)="applyCompletion($event)"
                (closeRequested)="dismissCompletionForCurrentInput()">
            </search-completion-popup>
        </div>
    `,
    standalone: true,
    imports: [SearchCompletionPopupComponent]
})
/** Inline SIMFIL editor that reuses the app's schema completion popup. */
export class SimfilExpressionInputComponent implements AfterViewInit, OnChanges, OnDestroy {
    @Input() value = "";
    @Input() placeholder = "";
    @Input() singleLine = true;
    @Input() disabled = false;
    @Input() submitOnEnter = false;
    @Input() completionEnabled = true;
    @Input() completionOwnerId = "";
    @Input() completionScope?: FeatureSearchScope;
    @Input() completionMapLayers: FeatureSearchMapLayerRef[] = [];
    @Input() completionDelay = 150;
    @Input() completionZIndex = 30050;

    @Output() valueChange = new EventEmitter<string>();
    @Output() cursorChange = new EventEmitter<number>();
    @Output() clicked = new EventEmitter<MouseEvent>();
    @Output() focused = new EventEmitter<void>();
    @Output() blurred = new EventEmitter<void>();
    @Output() submitted = new EventEmitter<void>();
    @Output() escaped = new EventEmitter<void>();
    @Output() completionAccepted = new EventEmitter<CompletionCandidate>();

    @ViewChild("editorHost", {static: true}) private editorHost!: ElementRef<HTMLElement>;
    @ViewChild(SearchCompletionPopupComponent, {static: true})
    private completionPopup!: SearchCompletionPopupComponent;

    private static nextId = 1;
    private readonly generatedOwnerId = `simfil-expression:${SimfilExpressionInputComponent.nextId++}`;
    private readonly completionRequests = new Subject<void>();
    private readonly subscriptions = new Subscription();
    private completionSubscriptions = new Subscription();
    private editorView?: EditorView;
    private modeObserver?: MutationObserver;
    private themeCompartment = new Compartment();
    private readOnlyCompartment = new Compartment();
    private placeholderCompartment = new Compartment();
    private viewReady = false;
    private applyingExternalValue = false;
    private completionMapLayersSignature = "";
    private dismissedCompletionSignature: string | null = null;
    private completionBindingQueued = false;

    completionItems: CompletionCandidate[] = [];
    completion = {
        selectionIndex: 0,
        visible: false,
        pending: false
    };

    /** Wires the completion service and DOM renderer used by the inline editor. */
    constructor(private readonly searchService: FeatureSearchService,
                private readonly renderer: Renderer2) {
        this.subscriptions.add(this.completionRequests.pipe(debounceTime(this.completionDelay)).subscribe(() => {
            this.completeCurrentQuery();
        }));
    }

    /** Creates the CodeMirror editor and binds the completion stream once the host exists. */
    ngAfterViewInit(): void {
        this.viewReady = true;
        this.editorView = new EditorView({
            state: this.createEditorState(),
            parent: this.editorHost.nativeElement
        });
        this.applySingleLineClass();
        this.observeTheme();
        // BehaviorSubjects emit synchronously when bound. Defer those
        // template-visible mutations until Angular's current view check has
        // completed, then coalesce any same-turn input changes into this bind.
        this.scheduleCompletionBinding();
    }

    /** Applies input changes without rebuilding the CodeMirror view. */
    ngOnChanges(changes: SimpleChanges): void {
        if (!this.viewReady) {
            return;
        }
        if (changes["value"]) {
            this.setEditorValue(this.value ?? "");
        }
        if (changes["singleLine"]) {
            this.applySingleLineClass();
        }
        if (changes["disabled"]) {
            this.editorView?.dispatch({
                effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled))
            });
        }
        if (changes["placeholder"]) {
            this.editorView?.dispatch({
                effects: this.placeholderCompartment.reconfigure(this.placeholder ? placeholder(this.placeholder) : [])
            });
        }
        if (changes["completionOwnerId"]) {
            this.scheduleCompletionBinding();
        }
        if (changes["completionScope"] || this.completionMapLayersChanged()) {
            this.resetCompletion();
        }
    }

    /** Releases CodeMirror, completion subscriptions, and pending backend completion requests. */
    ngOnDestroy(): void {
        this.viewReady = false;
        this.modeObserver?.disconnect();
        this.completionSubscriptions.unsubscribe();
        this.subscriptions.unsubscribe();
        this.searchService.clearCurrentCompletion(this.ownerId());
        this.editorView?.destroy();
        this.editorView = undefined;
    }

    /** Defers one completion-stream bind beyond the active Angular check. */
    private scheduleCompletionBinding(): void {
        if (!this.viewReady || this.completionBindingQueued) {
            return;
        }
        this.completionBindingQueued = true;
        queueMicrotask(() => {
            this.completionBindingQueued = false;
            if (!this.viewReady || !this.editorView) {
                return;
            }
            this.bindCompletionOwner();
            this.updateCursorPosition();
        });
    }

    /** Focuses the inline editor. */
    focus(): void {
        this.editorView?.focus();
    }

    /** Blurs the inline editor. */
    blur(): void {
        this.editorView?.contentDOM.blur();
    }

    /** Returns the current cursor position in document offsets. */
    cursorPosition(): number {
        return this.editorView?.state.selection.main.head ?? 0;
    }

    /** Creates the initial CodeMirror state for the inline SIMFIL editor. */
    private createEditorState(): EditorState {
        return EditorState.create({
            doc: this.value ?? "",
            extensions: [
                this.inputKeymap(),
                basicSetup,
                simfilLanguage,
                EditorState.tabSize.of(2),
                this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
                this.placeholderCompartment.of(this.placeholder ? placeholder(this.placeholder) : []),
                this.themeCompartment.of(this.currentTheme()),
                EditorView.lineWrapping,
                EditorView.domEventHandlers({
                    keydown: event => this.onEditorKeydown(event),
                    focus: () => {
                        this.focused.emit();
                        this.updateCursorPosition();
                    },
                    blur: () => {
                        this.blurred.emit();
                        setTimeout(() => {
                            this.completion.visible = false;
                            this.completion.pending = false;
                        }, 0);
                    },
                    click: event => {
                        this.clicked.emit(event);
                        this.updateCursorPosition();
                    },
                    scroll: () => this.updateCursorPosition()
                }),
                EditorView.updateListener.of((update: ViewUpdate) => this.onEditorUpdate(update))
            ]
        });
    }

    /** Installs high-priority key handling before CodeMirror's default multiline bindings. */
    private inputKeymap(): Extension {
        return Prec.high(keymap.of([
            {
                key: "Enter",
                run: () => this.handleEnterKey()
            },
            {
                key: "Tab",
                run: () => this.handleTabKey()
            },
            {
                key: "ArrowDown",
                run: () => this.handleArrowKey(true)
            },
            {
                key: "ArrowUp",
                run: () => this.handleArrowKey(false)
            },
            {
                key: "Escape",
                run: () => this.handleEscapeKey()
            }
        ]));
    }

    /** Handles Enter without letting the editor insert a newline in submit-capable inputs. */
    private handleEnterKey(): boolean {
        if (this.shouldApplyCompletionOnEnter()) {
            this.applyCompletion();
            return true;
        }
        if (this.submitOnEnter || this.singleLine) {
            if (this.submitOnEnter) {
                this.submitted.emit();
            }
            return true;
        }
        return false;
    }

    /** Accepts a visible completion with Tab while leaving normal tab behavior alone. */
    private handleTabKey(): boolean {
        if (!this.shouldApplyCompletionOnEnter()) {
            return false;
        }
        this.applyCompletion();
        return true;
    }

    /** Moves through the existing completion popup only while it is visible. */
    private handleArrowKey(next: boolean): boolean {
        if (!this.completion.visible) {
            return false;
        }
        this.selectNextCompletion(next);
        return true;
    }

    /** Dismisses completion first, then delegates Escape to the owning panel. */
    private handleEscapeKey(): boolean {
        if (this.completion.visible || this.completion.pending || this.completionItems.length > 0) {
            this.dismissCompletionForCurrentInput();
            return true;
        }
        this.escaped.emit();
        return true;
    }

    /** Handles document and cursor changes from CodeMirror. */
    private onEditorUpdate(update: ViewUpdate): void {
        if (update.docChanged && !this.applyingExternalValue) {
            this.value = update.state.doc.toString();
            this.valueChange.emit(this.value);
            this.dismissedCompletionSignature = null;
            this.scheduleCompletion();
        }
        if (update.docChanged || update.selectionSet || update.geometryChanged) {
            this.updateCursorPosition();
        }
    }

    /** Handles completion navigation and submit/escape behavior before CodeMirror consumes keys. */
    private onEditorKeydown(event: KeyboardEvent): boolean {
        const dismissCompletionKeys = ["Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "Delete"];
        if (dismissCompletionKeys.includes(event.key)) {
            this.hideCompletionPopup();
        }

        if (this.completion.visible) {
            if (event.key === "Enter" && this.shouldApplyCompletionOnEnter()) {
                event.preventDefault();
                event.stopPropagation();
                this.applyCompletion();
                return true;
            }
            if (event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                if (this.shouldApplyCompletionOnEnter()) {
                    this.applyCompletion();
                }
                return true;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                this.selectNextCompletion(event.key === "ArrowDown");
                return true;
            }
        }

        if (event.key === "Enter" && (this.submitOnEnter || this.singleLine)) {
            event.preventDefault();
            event.stopPropagation();
            if (this.submitOnEnter) {
                this.submitted.emit();
            }
            return true;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (this.completion.visible || this.completion.pending || this.completionItems.length > 0) {
                this.dismissCompletionForCurrentInput();
            } else {
                this.escaped.emit();
            }
            return true;
        }

        return false;
    }

    /** Returns whether Enter should accept completion instead of submitting or keeping exact text. */
    private shouldApplyCompletionOnEnter(): boolean {
        const currentValue = this.editorView?.state.doc.toString() ?? this.value ?? "";
        return this.completion.visible
            && this.completionItems.length > 0
            && !this.isCompletionDismissedFor(currentValue, this.cursorPosition())
            && !this.searchService.hasExactCompletionCandidate(currentValue, this.ownerId());
    }

    /** Prevents popup clicks from blurring the CodeMirror surface before selection applies. */
    protected onCompletionPopupDown(event: MouseEvent): void {
        event.preventDefault();
    }

    /** Applies either the selected completion item or an explicitly clicked candidate. */
    protected applyCompletion(candidate?: CompletionCandidate): void {
        const item = candidate ?? this.completionItems[this.completion.selectionIndex];
        if (!item || (!candidate && !this.shouldApplyCompletionOnEnter())) {
            return;
        }
        this.setEditorValue(item.query, item.begin + item.text.length);
        this.value = item.query;
        this.valueChange.emit(this.value);
        this.completionAccepted.emit(item);
        this.completionItems = [];
        this.completion.visible = false;
        this.completion.pending = false;
        this.dismissedCompletionSignature = null;
        this.focus();
    }

    /** Rotates completion selection while preserving popup visibility. */
    private selectNextCompletion(next: boolean): void {
        const count = this.completionItems.length;
        const currentValue = this.editorView?.state.doc.toString() ?? this.value ?? "";
        if (count === 0 || this.isCompletionDismissedFor(currentValue, this.cursorPosition())) {
            this.completion.selectionIndex = 0;
            this.completion.visible = false;
            return;
        }
        const direction = next ? 1 : -1;
        this.completion.selectionIndex = (this.completion.selectionIndex + direction + count) % count;
        this.completion.visible = true;
    }

    /** Starts a debounced schema completion request for the current document. */
    private scheduleCompletion(): void {
        if (!this.completionEnabled) {
            this.resetCompletion();
            return;
        }
        this.completionRequests.next();
    }

    /** Runs schema completion for the current document and cursor position. */
    private completeCurrentQuery(): void {
        const query = this.editorView?.state.doc.toString() ?? this.value ?? "";
        if (!query.trim()) {
            this.resetCompletion();
            return;
        }
        if (this.isCompletionDismissedFor(query, this.cursorPosition())) {
            this.searchService.clearCurrentCompletion(this.ownerId());
            this.hideCompletionPopup();
            return;
        }
        this.searchService.completeQueryForOwner(
            this.ownerId(),
            query,
            this.cursorPosition(),
            {scope: this.completionScope, selectedMapLayers: this.completionMapLayers}
        );
        this.completion.selectionIndex = 0;
    }

    /** Clears local and backend completion state for this input. */
    private resetCompletion(): void {
        this.searchService.clearCurrentCompletion(this.ownerId());
        this.completionItems = [];
        this.completion.selectionIndex = 0;
        this.completion.visible = false;
        this.completion.pending = false;
        this.dismissedCompletionSignature = null;
    }

    /** Rebinds the completion stream when the owner id changes. */
    private bindCompletionOwner(): void {
        if (!this.viewReady) {
            return;
        }
        this.completionSubscriptions.unsubscribe();
        this.completionSubscriptions = new Subscription();
        const state = this.searchService.completionStateForOwner(this.ownerId());
        this.completionSubscriptions.add(state.candidates.pipe(distinctUntilChanged()).subscribe(value => {
            const currentValue = this.editorView?.state.doc.toString() ?? this.value ?? "";
            if (this.isCompletionDismissedFor(currentValue, this.cursorPosition())) {
                this.completionItems = [];
                this.completion.visible = false;
                return;
            }
            this.completionItems = value.filter(item => item.query !== currentValue && item.source === currentValue);
            if (this.completion.selectionIndex >= this.completionItems.length) {
                this.completion.selectionIndex = Math.max(0, this.completionItems.length - 1);
            }
            const focusValid = this.completion.visible || !!this.editorView?.hasFocus;
            this.completion.visible = this.completionItems.length > 0 && focusValid;
            if (this.completion.visible) {
                this.updateCursorPosition();
            }
        }));
        this.completionSubscriptions.add(state.pending.pipe(distinctUntilChanged()).subscribe(pending => {
            const currentValue = this.editorView?.state.doc.toString() ?? this.value ?? "";
            if (pending && this.isCompletionDismissedFor(currentValue, this.cursorPosition())) {
                this.completion.pending = false;
                this.completion.visible = false;
                return;
            }
            const focusValid = this.completion.visible || pending || !!this.editorView?.hasFocus;
            this.completion.pending = pending && focusValid;
            if (this.completion.pending) {
                this.updateCursorPosition();
            } else if (this.completionItems.length === 0) {
                this.completion.visible = false;
            }
        }));
    }

    /** Returns the completion owner id used to isolate pending backend requests. */
    private ownerId(): string {
        return this.completionOwnerId || this.generatedOwnerId;
    }

    /** Hides the popup locally without changing the editor text. */
    private hideCompletionPopup(): void {
        this.completion.visible = false;
        this.completion.pending = false;
    }

    /** Dismisses the current completion generation until text or caret changes. */
    protected dismissCompletionForCurrentInput(): void {
        const query = this.editorView?.state.doc.toString() ?? this.value ?? "";
        this.dismissedCompletionSignature = this.completionSignature(query, this.cursorPosition());
        this.searchService.clearCurrentCompletion(this.ownerId());
        this.completionItems = [];
        this.completion.selectionIndex = 0;
        this.hideCompletionPopup();
        this.focus();
    }

    /** Returns whether completion has been explicitly dismissed for this exact query/caret pair. */
    private isCompletionDismissedFor(query: string, point: number): boolean {
        return this.dismissedCompletionSignature === this.completionSignature(query, point);
    }

    /** Builds the completion identity suppressed by Escape/close until text or caret changes. */
    private completionSignature(query: string, point: number): string {
        return `${query}\u0000${point}`;
    }

    /** Replaces the editor document while preserving or applying a cursor position. */
    private setEditorValue(value: string, cursor?: number): void {
        const view = this.editorView;
        if (!view || view.state.doc.toString() === value) {
            if (cursor !== undefined) {
                this.setCursor(cursor);
            }
            return;
        }
        this.applyingExternalValue = true;
        view.dispatch({
            changes: {from: 0, to: view.state.doc.length, insert: value},
            selection: {anchor: this.clampCursor(cursor ?? value.length, value)}
        });
        this.applyingExternalValue = false;
        this.updateCursorPosition();
    }

    /** Moves the CodeMirror cursor to a valid document offset. */
    private setCursor(cursor: number): void {
        const view = this.editorView;
        if (!view) {
            return;
        }
        const position = this.clampCursor(cursor, view.state.doc.toString());
        view.dispatch({selection: {anchor: position}});
        this.updateCursorPosition();
    }

    /** Clamps cursor offsets to the current document length. */
    private clampCursor(cursor: number, value: string): number {
        return Math.max(0, Math.min(value.length, cursor));
    }

    /** Updates popup coordinates from CodeMirror's cursor geometry. */
    private updateCursorPosition(): void {
        const view = this.editorView;
        if (!view) {
            return;
        }
        const cursor = view.state.selection.main.head;
        this.cursorChange.emit(cursor);
        const coords = view.coordsAtPos(cursor);
        const fallbackRect = view.dom.getBoundingClientRect();
        this.completionPopup.setPosition(
            coords?.bottom ?? fallbackRect.bottom,
            coords?.left ?? fallbackRect.left
        );
    }

    /** Mirrors the single-line input state onto CodeMirror's root element. */
    private applySingleLineClass(): void {
        const view = this.editorView;
        if (!view) {
            return;
        }
        if (this.singleLine) {
            this.renderer.addClass(view.dom, "simfil-expression-single-line");
        } else {
            this.renderer.removeClass(view.dom, "simfil-expression-single-line");
        }
    }

    /** Keeps CodeMirror syntax colors synchronized with the app dark-mode class. */
    private observeTheme(): void {
        const root = document.documentElement;
        this.modeObserver?.disconnect();
        this.modeObserver = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type !== "attributes" || record.attributeName !== "class") {
                    continue;
                }
                this.editorView?.dispatch({
                    effects: this.themeCompartment.reconfigure(this.currentTheme())
                });
            }
        });
        this.modeObserver.observe(root, {attributes: true, attributeFilter: ["class"]});
    }

    /** Builds the active input theme plus the SIMFIL-specific token color override. */
    private currentTheme(): Extension[] {
        return [
            ...currentInlineCodeMirrorTheme(),
            syntaxHighlighting(simfilHighlightStyle)
        ];
    }

    /** Returns true only when the selected layer set changed semantically, not just by array identity. */
    private completionMapLayersChanged(): boolean {
        const signature = this.completionMapLayers
            .map(ref => JSON.stringify([ref.mapId, ref.layerId]))
            .sort()
            .join("|");
        if (signature === this.completionMapLayersSignature) {
            return false;
        }
        this.completionMapLayersSignature = signature;
        return true;
    }
}
