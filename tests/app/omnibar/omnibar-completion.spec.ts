/** Completion edits a draft; a separate confirmation or menu choice executes an action. */
import "@angular/compiler";
import {ElementRef} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {OmnibarComponent} from "../../../app/omnibar/omnibar.component";
import type {CompletionCandidate} from "../../../app/search/search.model";
import {SearchService} from "../../../app/search/search.service";

const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    vi.useRealTimers();
});

/** Real omnibar event/subscription logic, with controllable completion replies and action dispatch. */
function fixture() {
    const host = document.createElement("div");
    host.innerHTML = `<textarea></textarea><div data-testid="omnibar-menu-panel">
        <div class="omnibar-option-wrapper" tabindex="0">External map</div>
        <div class="omnibar-option-wrapper" tabindex="0">Feature search</div>
    </div>`;
    document.body.append(host);
    const textarea = host.querySelector("textarea")!;
    const rows = [...host.querySelectorAll<HTMLElement>(".omnibar-option-wrapper")];
    rows.forEach(row => {row.scrollIntoView = vi.fn();});
    const candidates = new BehaviorSubject<CompletionCandidate[]>([]);
    const pending = new BehaviorSubject(false);
    const search = {
        completionCandidates: candidates,
        completionPending: pending,
        completeQuery: vi.fn(),
        clearCurrentCompletion: vi.fn(() => {candidates.next([]); pending.next(false);}),
        hasExactCompletionCandidate: (query: string) => candidates.value.some(item => item.query === query ||
            (item.isExactMatch && item.source === query))
    };
    const state = {isOpen: true, historyState: new Subject<void>()};
    const actions = {getCandidates: (query: string) => ["external", "features"].map(id => ({
        id, action: id, input: query, name: id, label: id, icon: "", color: "", enabled: !!query
    }))};
    const component = new OmnibarComponent(
        {} as never, new ElementRef(host), {registerShortcut: vi.fn(), unregisterShortcut: vi.fn()} as never,
        {} as never,
        {targetValueSubject: new Subject<string>(), targetsChanged: new Subject<void>(), mapSelectionSubject: new Subject()} as never,
        {lastInspectedTileSourceDataOption: new Subject()} as never,
        search as never, {updateSuggestions: vi.fn(), cancel: vi.fn()} as never,
        {markForCheck: vi.fn()} as never,
        {state: {locationSearchEnabled: false, locationSearchEnabledState: new Subject(),
            locationSearchResultLimitState: new Subject()}, isLocationTargetId: () => false} as never,
        actions as never, state as never
    );
    component.textarea = new ElementRef(textarea);
    component.dialog = {container: () => undefined, close: vi.fn(() => {state.isOpen = false;})} as never;
    textarea.addEventListener("blur", () => component.onBlur());
    const menu = host.querySelector<HTMLElement>('[data-testid="omnibar-menu-panel"]')!;
    menu.addEventListener("keydown", event => component.onActionMenuKeydown(event));
    const execute = vi.spyOn(component, "targetToHistory").mockImplementation(() => undefined);
    cleanups.push(() => {component.ngOnDestroy(); host.remove();});
    const input = (value: string) => {
        textarea.focus();
        textarea.value = value;
        textarea.setSelectionRange(value.length, value.length);
        component.setInputValue(value);
        component.updateCursor();
    };
    const suggest = (text: string, source = component.inputValue): CompletionCandidate => ({
        text, query: text, source, begin: 0, end: source.length, kind: "field", hint: `${text} attribute`,
        originLayers: [{mapId: "Ready", layerId: "Road"}]
    });
    const key = (value: string) => {
        const event = new KeyboardEvent("keydown", {key: value, cancelable: true});
        component.onKeydown(event);
        return event;
    };
    return {component, textarea, rows, state, search, candidates, pending, execute, input, suggest, key};
}

describe("omnibar completion and actions", () => {
    it("keeps the body-mounted completion above the omnibar when PrimeNG reports a local z-index", () => {
        const f = fixture();
        const dialog = f.rows[0].parentElement!;
        dialog.style.zIndex = "1110";
        f.component.dialog = {container: () => dialog} as never;
        f.component.showActionOverlay();
        expect(f.component.completion.zIndex).toBeGreaterThan(130000);
    });

    it("takes Shift-Tab from the first action back to the input, across the dialog focus boundary", () => {
        const f = fixture();
        f.input("WARNING_SIGN");
        f.key("Tab");
        expect(document.activeElement).toBe(f.rows[0]);
        const backward = new KeyboardEvent("keydown", {key: "Tab", shiftKey: true, bubbles: true, cancelable: true});
        f.rows[0].dispatchEvent(backward);
        expect(backward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(f.textarea);
        f.component.onKeydown(new KeyboardEvent("keydown", {key: "Tab", shiftKey: true}));
        expect(document.activeElement).toBe(f.rows[1]);
        f.rows[1].dispatchEvent(new KeyboardEvent("keydown", {key: "Tab", bubbles: true}));
        expect(document.activeElement).toBe(f.textarea);
        expect(f.component.completion.visible).toBe(false);
    });

    it("prioritizes input-based commands before viewport fallbacks without waiting for completion", () => {
        const f = fixture();
        f.input("WARNING_SIGN");
        f.component.actionCandidates[0].acceptsEmptyInput = true;
        f.component["refreshActionMenu"]();
        expect(f.component.activeCandidates[0].id).toBe("features");
        f.key("Enter");
        expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id: "features"}));
    });

    it("accepts a plain attribute with Tab, then executes feature search on the next Enter", async () => {
        const f = fixture();
        f.input("WARN");
        f.pending.next(true);
        f.candidates.next([f.suggest("WARNING_SIGN")]);
        f.pending.next(false);
        expect(f.component.completion.visible).toBe(true);
        expect(f.key("Tab").defaultPrevented).toBe(true);
        expect(f.component.inputValue).toBe("WARNING_SIGN");
        expect(f.component.completion.visible).toBe(false);
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.component.activeCandidates[0].id).toBe("features");
        expect(f.component["featureSearchPayloadForInput"]("WARNING_SIGN")).toEqual({
            suggestedMapLayers: [{mapId: "Ready", layerId: "Road"}]
        });
        // Angular normally writes ngModel before the deferred caret update.
        f.textarea.value = f.component.inputValue;
        await vi.advanceTimersByTimeAsync(200);
        expect(f.search.completeQuery).not.toHaveBeenCalled();
        f.key("Enter");
        expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id: "features"}));
    });

    it("keeps the action menu available after Escape and ignores late completion replies there", async () => {
        const f = fixture();
        f.input("WARN");
        const suggestions = [f.suggest("WARNING_SIGN")];
        f.candidates.next(suggestions);
        f.key("Escape");
        expect(f.component.inputValue).toBe("WARN");
        expect(f.state.isOpen).toBe(true);
        expect(f.component.completion.visible).toBe(false);
        f.key("ArrowDown");
        expect(document.activeElement).toBe(f.rows[0]);
        f.pending.next(true);
        f.candidates.next(suggestions);
        await vi.advanceTimersByTimeAsync(200);
        expect(f.component.completion.visible).toBe(false);
        expect(f.component.completion.pending).toBe(false);
        expect(f.search.completeQuery).not.toHaveBeenCalled();
        f.rows[0].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
        expect(document.activeElement).toBe(f.rows[1]);
        f.rows[1].dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
        expect(document.activeElement).toBe(f.textarea);
        expect(f.component.inputValue).toBe("WARN");
    });

    it("honors an explicit arrow selection even when the original input is already a complete symbol", () => {
        const f = fixture();
        f.input("WARNING_SIGN");
        f.candidates.next([f.suggest("WARNING_SIGN"), f.suggest("WARNING_SIGN_A"), f.suggest("WARNING_SIGN_B")]);
        expect(f.component.activeCandidates[0].id).toBe("features");
        f.key("ArrowDown");
        f.key("Enter");
        expect(f.component.inputValue).toBe("WARNING_SIGN_B");
        expect(f.execute).not.toHaveBeenCalled();
    });

    it("allows native caret movement and cancels the popup without consuming ArrowLeft", () => {
        const f = fixture();
        f.input("WARN");
        f.candidates.next([f.suggest("WARNING_SIGN")]);
        expect(f.key("ArrowLeft").defaultPrevented).toBe(false);
        expect(f.component.completion.visible).toBe(false);
        expect(f.component.inputValue).toBe("WARN");
    });

    it("navigates history and enabled actions with arrows, skips disabled rows, and reveals the destination", () => {
        const f = fixture();
        const menu = f.rows[0].parentElement!;
        const disabled = document.createElement("div");
        disabled.className = "omnibar-option-wrapper item-disabled";
        const history = document.createElement("div");
        history.className = "omnibar-option-wrapper";
        history.tabIndex = 0;
        history.scrollIntoView = vi.fn();
        menu.append(disabled, history);
        f.input("WARN");
        f.key("ArrowUp");
        expect(document.activeElement).toBe(history);
        expect(history.scrollIntoView).toHaveBeenCalledWith({block: "nearest", inline: "nearest"});
        history.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true}));
        expect(document.activeElement).toBe(f.rows[1]);
        f.rows[1].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true}));
        expect(document.activeElement).toBe(f.rows[0]);
        f.rows[0].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true}));
        expect(document.activeElement).toBe(f.textarea);
    });

    it("dismisses a pasted draft at its actual caret before the debounce has observed it", async () => {
        const f = fixture();
        f.input("WARNING_SIGN");
        f.component.cursorPosition = 0;
        f.component.dismissCompletionForCurrentInput();
        await vi.advanceTimersByTimeAsync(200);
        expect(f.search.completeQuery).not.toHaveBeenCalled();
        expect(f.component.completion.visible).toBe(false);
    });
});

describe("omnibar schema scope", () => {
    it("includes hidden ready layers and excludes unrelated unavailable sources", () => {
        const service = Object.create(SearchService.prototype) as SearchService;
        const layers = [
            {mapId: "Visible", id: "Road"}, {mapId: "Hidden", id: "Lane"}, {mapId: "Failed", id: "Road"}
        ];
        const complete = vi.fn();
        Object.defineProperties(service, {
            mapInfo: {value: {maps: {allFeatureLayers: () => layers}, isMapLayerReady: (id: string) => id !== "Failed"}},
            completeQueryForOwner: {value: complete}
        });
        service.completeQuery("WARN", 4);
        expect(complete).toHaveBeenCalledWith(expect.any(String), "WARN", 4, {selectedMapLayers: [
            {mapId: "Visible", layerId: "Road"}, {mapId: "Hidden", layerId: "Lane"}
        ]});
    });
});
