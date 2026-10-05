import {Injectable} from "@angular/core";
import {unicodePrefix} from "../shared/unicode-string";
import {ViewerActionFailure} from "./viewer-action-relay.contract";
import {ViewerResizeCapabilities, ViewerResizeSize, ViewerUiElement, ViewerUiInput, ViewerUiOutput} from "./viewer-ui.contract";

/** Components retain layout state; this registration only connects a live DOM surface to its owner. */
interface ResizeTarget {
    describe(): ViewerResizeCapabilities;
    resize(size: ViewerResizeSize): void;
}

interface ElementReference {
    element: HTMLElement;
    fingerprint: string;
    parentUid?: string;
}

/** Owns bounded, short-lived DOM references and live resize registrations; never mirrors application state. */
@Injectable({providedIn: "root"})
export class ViewerUiService {
    private readonly references = new Map<string, ElementReference>();
    private readonly resizeTargets = new WeakMap<HTMLElement, ResizeTarget>();
    private sequence = 0;

    /** Registers a live layout owner. The returned cleanup cannot remove a newer registration. */
    registerResizeTarget(element: HTMLElement, target: ResizeTarget): () => void {
        this.resizeTargets.set(element, target);
        return () => {
            if (this.resizeTargets.get(element) === target) this.resizeTargets.delete(element);
        };
    }

    /** Retires references on connection changes, so a later session cannot reuse another session's UIDs. */
    clear(): void {
        this.references.clear();
    }

    /** Walks only on explicit demand with node, depth, element and byte budgets. */
    snapshot(input: ViewerUiInput<"viewer_take_snapshot">): ViewerUiOutput<"viewer_take_snapshot"> {
        const root = input.rootUid ? this.resolve(input.rootUid) : document.body;
        this.clear();
        this.sequence++;
        const rootUid = this.remember(root);
        const elements: ViewerUiElement[] = [];
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 200;
        let visited = 0, candidates = 0, bytes = 0;
        let reason: ViewerUiOutput<"viewer_take_snapshot">["reason"];
        const encoder = new TextEncoder();
        const visit = (element: HTMLElement, parentUid: string | undefined, depth: number): void => {
            if (reason) return;
            if (++visited > 5000 || depth > 64) { reason = "work_limit"; return; }
            // Ancestors have already passed visibility checks during this synchronous walk.
            if (depth === 0 ? !this.visible(element) : this.hidden(element)) return;
            let nextParent = parentUid;
            const directText = this.directText(element);
            if (element === root || this.resizeTargets.has(element) || directText || element.matches(
                "button,input,textarea,select,a,summary,label,canvas,[role],[aria-label],[data-testid],[tabindex]")) {
                if (candidates++ >= offset) {
                    if (elements.length >= limit) { reason = "element_limit"; return; }
                    const id = element === root ? rootUid : this.remember(element, parentUid);
                    const description = this.describe(element, id, parentUid);
                    bytes += encoder.encode(JSON.stringify(description)).length;
                    if (bytes > 180000) {
                        if (id !== rootUid) this.references.delete(id);
                        reason = "byte_limit";
                        return;
                    }
                    elements.push(description);
                    nextParent = id;
                }
            }
            for (let child = element.firstElementChild; child && !reason; child = child.nextElementSibling) {
                if (child instanceof HTMLElement) visit(child, nextParent ?? rootUid, depth + 1);
            }
        };
        visit(root, undefined, 0);
        return {observedAt: new Date().toISOString(), rootUid, elements, complete: !reason,
            ...(reason ? {reason} : {}),
            ...(reason === "element_limit" || reason === "byte_limit" ? {nextOffset: offset + elements.length} : {})};
    }

    /** Reads only bounded explicitly requested element properties, never arbitrary object paths or HTML. */
    getElement(input: ViewerUiInput<"viewer_get_element">): ViewerUiOutput<"viewer_get_element"> {
        const element = this.resolve(input.uid);
        const scroll = element === document.body ? document.scrollingElement ?? element : element;
        const computed = getComputedStyle(element);
        return {element: this.describe(element, input.uid, this.references.get(input.uid)?.parentUid),
            scroll: {left: scroll.scrollLeft, top: scroll.scrollTop, width: scroll.scrollWidth, height: scroll.scrollHeight,
                clientWidth: scroll.clientWidth, clientHeight: scroll.clientHeight},
            styles: (input.styles ?? []).map(name => ({name, value: unicodePrefix(computed.getPropertyValue(name), 512)}))};
    }

    /** Activates a real rendered HTML element without attempting to emulate a trusted pointer sequence. */
    click(input: ViewerUiInput<"viewer_click">): ViewerUiOutput<"viewer_click"> {
        const element = this.control(input.uid);
        if (element.matches('input[type="file"],input[type="password"]')) this.reject("This control is not supported", "invalid_arguments");
        element.click();
        return {status: "applied"};
    }

    /** Updates native form controls using their ordinary event path; component editors stay semantic actions. */
    fill(input: ViewerUiInput<"viewer_fill">): ViewerUiOutput<"viewer_fill"> {
        const element = this.resolve(input.uid);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
            this.reject("Only native inputs, textareas and selects support fill", "invalid_arguments");
        }
        if (element instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "number", "range", "date", "time", "datetime-local", "month", "week", "color", "checkbox", "radio"].includes(element.type)) {
            this.reject("This input type is not supported", "invalid_arguments");
        }
        if (("readOnly" in element && element.readOnly) || element.closest(".cm-editor,[contenteditable=true]")) {
            this.reject("Read-only inputs and rich-text editors do not support fill", "invalid_arguments");
        }
        if (element instanceof HTMLSelectElement && (element.multiple || !Array.from(element.options).some(option => option.value === input.value && !option.disabled))) {
            this.reject("Choose an enabled value in a single-select control", "invalid_arguments");
        }
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
            if (!["true", "false"].includes(input.value) || (element.type === "radio" && input.value !== "true")) {
                this.reject("Use true/false for checkboxes and true for radio buttons", "invalid_arguments");
            }
            this.control(input.uid);
            if (element.checked !== (input.value === "true")) element.click();
        } else {
            this.control(input.uid);
            element.focus({preventScroll: true});
            element.value = input.value;
            element.dispatchEvent(new Event("input", {bubbles: true}));
            element.dispatchEvent(new Event("change", {bubbles: true}));
        }
        return {status: "applied"};
    }

    /** Scrolls DOM content, never sends pointer/wheel input to the map renderer. */
    scroll(input: ViewerUiInput<"viewer_scroll">): ViewerUiOutput<"viewer_scroll"> {
        const element = this.resolve(input.uid);
        if ("intoView" in input.position) element.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
        else (element === document.body ? document.scrollingElement ?? element : element).scrollTo({...input.position, behavior: "instant"});
        return {status: "applied"};
    }

    /** Dispatches a constrained resize to its existing owner and reports the synchronous applied layout. */
    resize(input: ViewerUiInput<"viewer_resize">): ViewerUiOutput<"viewer_resize"> {
        const element = this.resolve(input.uid);
        const target = this.resizeTargets.get(element);
        if (!target) this.reject("This element has no resize owner", "invalid_arguments");
        const capabilities = target.describe();
        if (capabilities.busy) this.reject("The surface is being resized or dragged", "busy");
        if (Object.keys(input.size).some(key => !capabilities.dimensions.includes(key as ViewerResizeCapabilities["dimensions"][number]))) {
            this.reject("Only the advertised resize dimensions are supported", "invalid_arguments");
        }
        if ("panelSizes" in input.size && (!capabilities.panelSizes || input.size.panelSizes.length !== capabilities.panelSizes.length
            || Math.abs(input.size.panelSizes.reduce((sum, value) => sum + value, 0) - 100) > 0.001)) {
            this.reject("Split percentages must match the current views and sum to 100", "invalid_arguments");
        }
        target.resize(input.size);
        return {status: "applied", element: this.describe(element, input.uid, this.references.get(input.uid)?.parentUid)};
    }

    /** Creates references only for returned elements (plus the snapshot root). */
    private remember(element: HTMLElement, parentUid?: string): string {
        const uid = `${this.sequence}.${this.references.size}`;
        this.references.set(uid, {element, parentUid, fingerprint: this.fingerprint(element)});
        return uid;
    }

    /** Rejects detached, hidden or repurposed virtual rows rather than silently choosing another target. */
    private resolve(uid: string): HTMLElement {
        const reference = this.references.get(uid);
        if (!reference || !reference.element.isConnected || !this.visible(reference.element)
            || reference.fingerprint !== this.fingerprint(reference.element)) {
            this.reject("Element changed or is no longer available; take a fresh snapshot", "not_available", "stale_element");
        }
        return reference.element;
    }

    /** Tests ancestor visibility too, since a captured UID may outlive an opened menu or dialog. */
    private visible(element: HTMLElement): boolean {
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
            if (this.hidden(parent)) return false;
        }
        return true;
    }

    /** Prunes non-UI and hidden nodes, including hidden descendants used in an ancestor's label. */
    private hidden(element: Element): boolean {
        if (element.matches('script,style,link,meta,template,iframe,object,embed,[hidden],[inert],[aria-hidden="true"]')) return true;
        const style = getComputedStyle(element);
        return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
    }

    /** Limits text traversal instead of repeatedly materializing entire inspection subtrees with textContent. */
    private boundedText(element: Element): string {
        let text = "", count = 0;
        const visit = (node: Node): void => {
            if (++count > 64 || text.length >= 1024) return;
            if (node instanceof Element && this.hidden(node)) return;
            if (node.nodeType === Node.TEXT_NODE) text += " " + (node.nodeValue ?? "").slice(0, 1024 - text.length);
            for (let child = node.firstChild; child && count < 64 && text.length < 1024; child = child.nextSibling) visit(child);
        };
        visit(element);
        return unicodePrefix(text.replace(/\s+/g, " ").trim(), 512);
    }

    /** Reads a node's own text, avoiding duplicate subtree text for generic containers. */
    private directText(element: HTMLElement): string {
        let text = "", count = 0;
        for (let node = element.firstChild; node && count++ < 64 && text.length < 1024; node = node.nextSibling) {
            if (node.nodeType === Node.TEXT_NODE) text += " " + (node.nodeValue ?? "").slice(0, 1024 - text.length);
        }
        return unicodePrefix(text.replace(/\s+/g, " ").trim(), 512);
    }

    /** Projects useful native/ARIA labels without claiming browser accessibility-tree parity. */
    private name(element: HTMLElement): string {
        const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).slice(0, 4)
            .map(id => document.getElementById(id)).filter((label): label is HTMLElement => !!label);
        const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.labels : null;
        return unicodePrefix(element.getAttribute("aria-label") || labelledBy.map(label => this.boundedText(label)).join(" ")
            || (labels?.length ? Array.from(labels).slice(0, 4).map(label => this.boundedText(label)).join(" ") : "")
            || element.getAttribute("title") || element.getAttribute("placeholder")
            || (element.matches("button,a,summary,label,[role=button],[role=menuitem],[role=tab],[role=treeitem]") ? this.boundedText(element) : ""), 512);
    }

    /** Includes a nearby row identity to catch virtualized controls recycled for another result. */
    private fingerprint(element: HTMLElement): string {
        const row = element.closest('tr,[role="row"],[data-surface-id]');
        return JSON.stringify([element.tagName, element.getAttribute("role"), element.getAttribute("type"),
            element.getAttribute("data-testid"), this.name(element), this.directText(element), row ? this.boundedText(row) : ""]);
    }

    /** Projects a small inspectable element record with actual CSS-pixel bounds. */
    private describe(element: HTMLElement, uid: string, parentUid?: string): ViewerUiElement {
        const rect = element.getBoundingClientRect();
        const resize = this.resizeTargets.get(element)?.describe();
        const form = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
        const safeValue = form && !element.matches('input[type="password"],input[type="file"]');
        const value = safeValue ? unicodePrefix(element.value, 512) : undefined;
        const role = element.getAttribute("role") || ({BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: "combobox", CANVAS: "img"}[element.tagName] ?? "");
        return {uid, ...(parentUid ? {parentUid} : {}), tag: element.tagName.toLowerCase(), role, name: this.name(element), text: this.directText(element),
            ...(element.dataset['testid'] ? {testId: unicodePrefix(element.dataset['testid'], 512)} : {}),
            ...(safeValue ? {value, valueTruncated: value!.length < element.value.length} : {}),
            ...(element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? {checked: element.checked} : {}),
            ...(element.hasAttribute("aria-expanded") ? {expanded: element.getAttribute("aria-expanded") === "true"} : {}),
            disabled: element.matches(":disabled") || !!element.closest('[aria-disabled="true"]'),
            bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
            inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
            ...(resize ? {resize} : {})};
    }

    /** Performs basic actionability checks after scrolling; a covering modal must not be bypassed. */
    private control(uid: string): HTMLElement {
        const element = this.resolve(uid);
        if (element.matches(":disabled") || element.closest('[aria-disabled="true"]')) this.reject("The control is disabled", "not_available");
        element.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
        const rect = element.getBoundingClientRect();
        const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
        const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
        const hit = document.elementFromPoint(x, y);
        if (!rect.width || !rect.height || !hit || !(hit === element || element.contains(hit))) this.reject("The control is outside the viewport or covered", "not_available");
        return element;
    }

    /** Reports predictable UI failures through the existing action error contract. */
    private reject(message: string, code: "invalid_arguments" | "not_available" | "busy", reason?: string): never {
        throw new ViewerActionFailure({code, message, outcome: "not_applied", ...(reason ? {reason} : {})});
    }
}
