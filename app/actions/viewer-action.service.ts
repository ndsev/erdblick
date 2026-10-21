import {rejectAction} from "./app-action";
import { Injectable,NgZone,OnDestroy } from "@angular/core";
import { BehaviorSubject,Subscription } from "rxjs";
import { MapTileStreamService } from "../mapdata/map-tile-stream.service";
import { AppStateService } from "../shared/appstate.service";
import { unicodePrefix } from "../shared/unicode-string";
import { AppActionService } from "./app-action.service";
import { VIEWER_ACTION_CATALOG_ID } from "./generated/catalog-id";
import {
ViewerActionFailure,
viewerActionServerMessageSchema,viewerMcpInfoSchema,
type ViewerActionError,type ViewerActionServerMessage,type ViewerMcpInfo
} from "./viewer-action-relay.contract";
import {
VIEWER_ACTION_INVOCATION_BYTES,VIEWER_ACTION_RESULT_BYTES,viewerActions,
type ViewerActionName,type ViewerActionOutput
} from "./viewer-action.contract";
import { ViewerUiService } from "./viewer-ui.service";

/** Small activity summary: never includes arguments, session UUIDs, credentials or map data. */
export interface ViewerActionActivity {
    action: string;
    status: "running" | "applied" | "completed" | ViewerActionError["code"];
}

interface PendingViewerAction {
    callId: string;
    clientId: string | null;
    localComplete?: (result?: ViewerActionOutput<ViewerActionName>, error?: ViewerActionError) => void;
    removeAbortListener?: () => void;
    action: ViewerActionName;
    arguments: unknown;
    mutation: boolean;
    deadline: number;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    activity: ViewerActionActivity;
}

/** Binds the explicit action allowlist to existing owners; it stores no replica of application state. */
@Injectable({providedIn: "root"})
export class ViewerActionService implements OnDestroy {
    private readonly encoder = new TextEncoder();
    readonly activity$ = new BehaviorSubject<readonly ViewerActionActivity[]>([]);
    readonly availability$ = new BehaviorSubject({enabled: false, ready: false, message: "MCP is not enabled"});
    private readonly subscriptions = new Subscription();
    private readonly pending = new Map<string, PendingViewerAction>();
    private readonly completedCalls = new Set<string>();
    private readonly infoAbort = new AbortController();
    private clientId: string | null = null;
    private registered = false;
    private initialized = false;
    private info: ViewerMcpInfo = {enabled: false};
    private sessionLabel = "erdblick";

    get connectionInfo(): ViewerMcpInfo { return this.info; }
    get hasPendingAction(): boolean { return this.pending.size > 0; }
    get label(): string { return this.sessionLabel; }

    constructor(
        private readonly state: AppStateService,
        private readonly actions: AppActionService,
        private readonly zone: NgZone,
        private readonly stream: MapTileStreamService,
        private readonly ui: ViewerUiService
    ) {}

    /** Starts the optional control adapter after ordinary app/stream initialization, without delaying the map. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.subscriptions.add(this.stream.actionClientId$.subscribe(clientId => {
            if (clientId === this.clientId) return;
            for (const call of this.pending.values()) if (call.clientId !== null) this.finish(call, undefined, {
                code: "disconnected", message: "Interactive connection ended", outcome: "not_applied"
            }, false);
            this.completedCalls.clear();
            this.ui.clear();
            this.registered = false;
            this.clientId = clientId;
            this.register();
        }));
        this.subscriptions.add(this.stream.actionControlReceived.subscribe(({payload, receivedAt}) => this.receive(payload, receivedAt)));
        void this.zone.runOutsideAngular(async () => {
            // Catalog/schema startup may occupy the main thread while this small response
            // is already in flight. Use the action transport's discovery budget, not 5 seconds.
            const timer = setTimeout(() => this.infoAbort.abort(), 30000);
            try {
                const response = await fetch(new URL("mcp/info", document.baseURI), {
                    credentials: "same-origin", signal: this.infoAbort.signal
                });
                if (!response.ok) return; // Older/disabled backends remain ordinary viewers.
                const text = await response.text();
                if (text.length > 16 * 1024 || this.infoAbort.signal.aborted) return;
                const parsed = viewerMcpInfoSchema.safeParse(JSON.parse(text));
                if (!parsed.success) return;
                this.info = parsed.data;
                this.register();
            } catch {
                // Optional discovery failure must not break startup or create toast spam.
            } finally {
                clearTimeout(timer);
            }
        });
    }

    /** Cancels pending agent work only; completed mutations and human searches are untouched. */
    stopCurrentAction(): void {
        for (const call of this.pending.values()) this.finish(call, undefined, {
            code: "cancelled", message: "Stopped by the user", outcome: "not_applied"
        });
    }

    /** Changes display metadata on the existing connection, never its identity or authorization. */
    renameSession(label: string): void {
        this.sessionLabel = unicodePrefix(label.trim(), 120) || "erdblick";
        if (this.registered && this.clientId) this.stream.sendActionControl(this.clientId, {
            type: "mapget.actions.update", version: 1, catalogId: VIEWER_ACTION_CATALOG_ID,
            actions: Object.keys(viewerActions), label: this.sessionLabel
        });
    }

    /** Retires timers, listeners and discovery without sending on a later connection. */
    ngOnDestroy(): void {
        this.ui.clear();
        this.infoAbort.abort();
        this.subscriptions.unsubscribe();
        for (const call of this.pending.values()) this.finish(call, undefined, {
            code: "disconnected", message: "Viewer closed", outcome: "not_applied"
        }, false);
    }

    /** Registers capabilities only against the configured, exactly matching trusted catalog. */
    private register(): void {
        this.registered = false;
        if (!this.info.enabled) return;
        if (!this.info.catalogId) {
            this.availability("Browser controls are not configured on this backend");
            return;
        }
        if (this.info.catalogId !== VIEWER_ACTION_CATALOG_ID) {
            this.availability("The backend and browser action catalogs do not match");
            return;
        }
        if (!this.clientId) {
            this.availability("Waiting for the interactive connection");
            return;
        }
        this.availability("Connecting MCP controls");
        this.stream.sendActionControl(this.clientId, {
            type: "mapget.actions.register", version: 1, catalogId: VIEWER_ACTION_CATALOG_ID,
            actions: Object.keys(viewerActions), label: this.sessionLabel
        });
    }

    /** Dispatches validated controls independently of tile request IDs and worker admission. */
    private receive(payload: unknown, receivedAt: number): void {
        const parsed = viewerActionServerMessageSchema.safeParse(payload);
        if (!parsed.success) {
            this.stopCurrentAction();
            this.registered = false;
            this.availability("Invalid MCP control message");
            return;
        }
        const message = parsed.data;
        if (message.type === "mapget.actions.registered" || message.type === "mapget.actions.updated") {
            this.registered = this.info.enabled && this.info.catalogId === VIEWER_ACTION_CATALOG_ID
                && message.catalogId === VIEWER_ACTION_CATALOG_ID && message.clientId === this.clientId;
            this.availability(this.registered ? "MCP controls ready" : "MCP registration does not match this connection");
        } else if (message.type === "mapget.actions.error") {
            // Catalog replacement affects future admission, not already accepted work.
            const catalogChanged = message.error.reason === "catalog_changed";
            if (!catalogChanged) this.stopCurrentAction();
            this.registered = false;
            this.availability(catalogChanged ? "MCP action catalog changed; reload the viewer" : `MCP controls unavailable: ${message.error.code}`);
        } else if (message.type === "mapget.actions.cancel") {
            const call = this.pending.get(message.callId);
            if (call) this.finish(call, undefined, {code: "cancelled", message: "Action cancelled", outcome: "not_applied"});
        } else {
            this.invoke(message, receivedAt);
        }
    }

    /** Runs a tool in this document with the same admission, output validation and stop control as relayed calls. */
    invokeLocal(action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ViewerActionOutput<ViewerActionName>> {
        signal.throwIfAborted();
        if (this.encoder.encode(JSON.stringify(input)).length > VIEWER_ACTION_INVOCATION_BYTES) {
            rejectAction("Viewer arguments exceed the request budget", "invalid_arguments");
        }
        return new Promise((resolve, reject) => this.invoke({
            type: "mapget.actions.invoke", version: 1, callId: `webmcp-${crypto.randomUUID()}`,
            action, arguments: input, timeoutMs: 30000
        }, performance.now(), (result, error) => {
            if (error) reject(new ViewerActionFailure(error));
            else resolve(result!);
        }, signal));
    }

    /** Admits bounded calls without a mutation queue; every admitted call owns its cancellation/deadline. */
    private invoke(message: Extract<ViewerActionServerMessage, {type: "mapget.actions.invoke"}>, receivedAt: number,
        localComplete?: PendingViewerAction["localComplete"], signal?: AbortSignal): void {
        if ((!localComplete && !this.clientId) || this.pending.has(message.callId) || this.completedCalls.has(message.callId)) return;
        let error: ViewerActionError | undefined;
        const known = Object.hasOwn(viewerActions, message.action);
        const name = message.action as ViewerActionName;
        if (!localComplete && !this.registered) error = {code: "not_available", message: "Viewer action registration is unavailable", outcome: "not_applied"};
        else if (!known) error = {code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied"};
        else if (this.pending.size >= 4 || (viewerActions[name].mutation && [...this.pending.values()].some(call => call.mutation))) {
            error = {code: "busy", message: "Viewer action capacity is busy", outcome: "not_applied"};
        }
        if (error) {
            if (localComplete) localComplete(undefined, error);
            else this.stream.sendActionControl(this.clientId!, {type: "mapget.actions.result", version: 1, callId: message.callId, error});
            return;
        }
        const deadline = receivedAt + message.timeoutMs;
        const call: PendingViewerAction = {
            callId: message.callId, clientId: localComplete ? null : this.clientId, localComplete, action: name, arguments: message.arguments,
            mutation: viewerActions[name].mutation, deadline, controller: new AbortController(),
            timer: setTimeout(() => this.finish(call, undefined, {
                code: "timeout", message: "Action deadline expired", outcome: "not_applied"
            }), Math.max(0, deadline - performance.now())),
            activity: {action: name, status: "running"}
        };
        this.pending.set(call.callId, call);
        if (signal) {
            const cancel = () => this.finish(call, undefined, {code: "cancelled", message: "Action cancelled", outcome: "not_applied"});
            signal.addEventListener("abort", cancel, {once: true});
            call.removeAbortListener = () => signal.removeEventListener("abort", cancel);
            if (signal.aborted) { cancel(); return; }
        }
        this.zone.run(() => this.activity$.next([...this.activity$.value.slice(-19), call.activity]));
        queueMicrotask(() => {
            if (!this.pending.has(call.callId)) return;
            if (call.controller.signal.aborted || performance.now() >= call.deadline) {
                this.finish(call, undefined, {code: "timeout", message: "Action expired before execution", outcome: "not_applied"});
                return;
            }
            try {
                const result = this.execute(call.action, call.arguments, call.controller.signal);
                if (result instanceof Promise) {
                    void result.then(value => this.completeResult(call, value), error => this.failCall(call, error));
                } else this.completeResult(call, result);
            } catch (error) {
                this.failCall(call, error);
            }
        });
    }

    /** Validates every synchronous/asynchronous result at the same trusted wire boundary. */
    private completeResult(call: PendingViewerAction, result: ViewerActionOutput<ViewerActionName>): void {
        if (this.pending.get(call.callId) !== call) return;
        try {
            const validated = viewerActions[call.action].outputSchema.parse(result);
            if (this.encoder.encode(JSON.stringify(validated)).length > VIEWER_ACTION_RESULT_BYTES - 1024) {
                throw new Error("Viewer result exceeds the wire budget");
            }
            if (performance.now() >= call.deadline) {
                this.finish(call, undefined, {code: "timeout", message: "Action completed after its deadline", outcome: call.mutation ? "applied" : "not_applied"});
            } else this.finish(call, validated);
        } catch (error) { this.failCall(call, error); }
    }

    /** Retains unknown-outcome semantics for failures after a domain owner may have applied effects. */
    private failCall(call: PendingViewerAction, error: unknown): void {
        this.finish(call, undefined, error instanceof ViewerActionFailure ? error.detail
            : {code: "internal_error", message: "Viewer action failed", outcome: call.mutation ? "unknown" : "not_applied"});
    }

    /** Completes once, releases the admission slot on every path, and never replies through a replacement socket. */
    private finish(call: PendingViewerAction, result?: ViewerActionOutput<ViewerActionName>, error?: ViewerActionError, send = true): void {
        if (this.pending.get(call.callId) !== call) return;
        this.pending.delete(call.callId);
        clearTimeout(call.timer);
        call.controller.abort();
        call.removeAbortListener?.();
        this.completedCalls.add(call.callId);
        if (this.completedCalls.size > 256) this.completedCalls.delete(this.completedCalls.values().next().value!);
        if (call.localComplete) call.localComplete(result, error);
        else if (send && call.clientId && this.clientId === call.clientId) this.stream.sendActionControl(call.clientId, {
            type: "mapget.actions.result", version: 1, callId: call.callId, ...(error ? {error} : {result})
        });
        call.activity.status = error?.code ?? (call.mutation ? "applied" : "completed");
        this.zone.run(() => this.activity$.next([...this.activity$.value]));
    }

    /** Notifies Angular only for control availability changes, not streamed tile/camera frames. */
    private availability(message: string): void {
        this.zone.run(() => this.availability$.next({enabled: this.info.enabled, ready: this.registered, message}));
    }

    /** Domain methods are registered by owners; the relay only selects the Angular execution boundary. */
    execute(name: string, argumentsValue: unknown, signal?: AbortSignal): ViewerActionOutput<ViewerActionName> | Promise<ViewerActionOutput<ViewerActionName>> {
        const declaration = viewerActions[name as ViewerActionName];
        if (!declaration) throw new ViewerActionFailure({code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied"});
        const invoke = () => this.actions.execute(name, argumentsValue, signal) as ViewerActionOutput<ViewerActionName> | Promise<ViewerActionOutput<ViewerActionName>>;
        return declaration.mutation ? this.zone.run(invoke) : this.zone.runOutsideAngular(invoke);
    }
}
