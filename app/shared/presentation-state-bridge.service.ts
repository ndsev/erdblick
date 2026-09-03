import {Injectable, OnDestroy} from "@angular/core";
import type {Params} from "@angular/router";
import {AppStateService} from "./appstate.service";

export const PRESENTATION_BRIDGE_PROTOCOL_VERSION = 1;
export const PRESENTATION_BRIDGE_READY = "erdblick:presentation:ready";
export const PRESENTATION_BRIDGE_APPLY = "erdblick:presentation:apply-url-state";
export const PRESENTATION_BRIDGE_RESULT = "erdblick:presentation:result";

interface PresentationApplyRequest {
    requestId: number;
    params: Params;
    origin: string;
}

type PresentationBridgeError = "invalid-message" | "invalid-search" | "navigation-failed";

/** Applies URL-backed state requested by an explicitly embedded presentation parent. */
@Injectable({providedIn: "root"})
export class PresentationStateBridgeService implements OnDestroy {
    private browserWindow?: Window;
    private parentOrigin?: string;
    private applying = false;
    private queuedRequest?: PresentationApplyRequest;

    constructor(private readonly stateService: AppStateService) {}

    /** Enables the bridge for a framed document carrying the presentation opt-in. */
    initialize(browserWindow: Window = window): boolean {
        if (this.browserWindow) {
            return true;
        }
        if (browserWindow.parent === browserWindow
            || new URLSearchParams(browserWindow.location.search).get("embed") !== "presentation") {
            return false;
        }

        this.browserWindow = browserWindow;
        browserWindow.addEventListener("message", this.handleMessage);
        browserWindow.parent.postMessage({
            type: PRESENTATION_BRIDGE_READY,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION
        }, "*");
        return true;
    }

    /** Removes the global listener and drops work that has not started yet. */
    ngOnDestroy(): void {
        this.browserWindow?.removeEventListener("message", this.handleMessage);
        this.browserWindow = undefined;
        this.parentOrigin = undefined;
        this.queuedRequest = undefined;
    }

    private readonly handleMessage = (event: MessageEvent<unknown>): void => {
        const browserWindow = this.browserWindow;
        if (!browserWindow || event.source !== browserWindow.parent || !isApplyMessage(event.data)) {
            return;
        }

        const requestId = event.data["requestId"];
        if (!isRequestId(requestId) || !isConcreteOrigin(event.origin)) {
            return;
        }
        if (this.parentOrigin && event.origin !== this.parentOrigin) {
            return;
        }
        if (event.data["version"] !== PRESENTATION_BRIDGE_PROTOCOL_VERSION
            || typeof event.data["search"] !== "string") {
            this.postResult(requestId, event.origin, false, "invalid-message");
            return;
        }

        const params = presentationParams(event.data["search"]);
        if (!params) {
            this.postResult(requestId, event.origin, false, "invalid-search");
            return;
        }

        this.parentOrigin ??= event.origin;
        const request: PresentationApplyRequest = {
            requestId,
            params,
            origin: event.origin
        };
        if (this.applying) {
            this.queuedRequest = request;
            return;
        }
        void this.applyRequests(request);
    };

    /** Serializes Router changes and retains only the newest waiting request. */
    private async applyRequests(firstRequest: PresentationApplyRequest): Promise<void> {
        this.applying = true;
        let request: PresentationApplyRequest | undefined = firstRequest;
        while (request && this.browserWindow) {
            try {
                await this.stateService.replaceUrlState(request.params);
                this.postResult(request.requestId, request.origin, true);
            } catch {
                this.postResult(request.requestId, request.origin, false, "navigation-failed");
            }
            request = this.queuedRequest;
            this.queuedRequest = undefined;
        }
        this.applying = false;
    }

    /** Replies only to the pinned parent and never includes application state. */
    private postResult(
        requestId: number,
        origin: string,
        ok: boolean,
        error?: PresentationBridgeError
    ): void {
        const browserWindow = this.browserWindow;
        if (!browserWindow || (this.parentOrigin && origin !== this.parentOrigin)) {
            return;
        }
        browserWindow.parent.postMessage({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId,
            ok,
            ...(error ? {error} : {})
        }, origin);
    }
}

/** Narrows unrelated window messages without responding to them. */
function isApplyMessage(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && (value as Record<string, unknown>)["type"] === PRESENTATION_BRIDGE_APPLY;
}

/** Accepts monotonic presentation request identifiers without coercion. */
function isRequestId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Rejects opaque origins because they cannot be pinned as a postMessage target. */
function isConcreteOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && parsed.origin === origin;
    } catch {
        return false;
    }
}

/** Validates the query-only contract and preserves repeated and empty parameters. */
function presentationParams(search: string): Params | null {
    if (!search.startsWith("?") || search.includes("#")) {
        return null;
    }
    const source = new URLSearchParams(search.slice(1));
    if (!hasSingleValue(source, "embed", "presentation") || !hasSingleValue(source, "v2", "1")) {
        return null;
    }

    const params = Object.create(null) as Params;
    for (const key of new Set(source.keys())) {
        const values = source.getAll(key);
        params[key] = values.length === 1 ? values[0] : values;
    }
    return params;
}

/** Requires protocol markers to be present exactly once. */
function hasSingleValue(params: URLSearchParams, key: string, value: string): boolean {
    const values = params.getAll(key);
    return values.length === 1 && values[0] === value;
}
