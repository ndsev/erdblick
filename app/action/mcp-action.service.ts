import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { BehaviorSubject, Subscription } from "rxjs";
import { MapTileStreamService } from "../mapdata/map-tile-stream.service";
import { unicodePrefix } from "../utils/unicode-string.util";
import { AppStateService } from "../appstate/appstate.service";
import { AppConfigService } from "../config/appconfig.service";
import { AppActionRegistry } from "./action-registry.service";
import { rejectAction } from "./action.model";
import { VIEWER_ACTION_CATALOG_ID } from "./generated/catalog-id";
import { UiAutomationService } from "./ui-automation.service";
import {
    ViewerActionFailure,
    viewerActionServerMessageSchema,
    viewerMcpInfoSchema,
    type ViewerActionError,
    type ViewerActionServerMessage,
    type ViewerMcpInfo
} from "./viewer-action-relay.contract";
import { VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES } from "./action.model";

/**
 * Small activity summary for the MCP popover: action name and execution status.
 * Never includes arguments, session UUIDs, credentials or map data.
 */
export interface ViewerActionActivity {
    action: string;
    status: "running" | "applied" | "completed" | ViewerActionError["code"];
}

/** Remote viewer registration state; diagnostic text never becomes a status value. */
export interface ViewerMcpAvailability {
    enabled: boolean;
    message: "waiting" | "connecting" | "ready";
    detail?: string;
}

/** One admitted call, including its reply destination, deadline and cancellation cleanup. */
interface PendingViewerAction {
    callId: string;
    clientId: string | null;
    localComplete?: (result?: unknown, error?: ViewerActionError) => void;
    removeAbortListener?: () => void;
    action: string;
    arguments: unknown;
    mutation: boolean;
    deadline: number;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    activity: ViewerActionActivity;
}

/**
 * Connects the shared action registry to mapget's interactive relay and WebMCP.
 * It owns admission, deadlines, cancellation and connection status; domain
 * operations and argument/result validation remain with AppActionRegistry.
 */
@Injectable({ providedIn: "root" })
export class McpActionService implements OnDestroy {
    private readonly encoder = new TextEncoder();
    readonly activity$ = new BehaviorSubject<readonly ViewerActionActivity[]>([]);
    readonly availability$ = new BehaviorSubject<ViewerMcpAvailability>({ enabled: false, message: "waiting" });
    private readonly subscriptions = new Subscription();
    private readonly pending = new Map<string, PendingViewerAction>();
    // Remember recent replies so a repeated invocation frame cannot run the same
    // action again. finish() retains the last 256 IDs; a connection change clears
    // them because the new relay session has its own calls.
    private readonly completedCalls = new Set<string>();
    private readonly infoAbort = new AbortController();
    private clientId: string | null = null;
    private initialized = false;
    private info: ViewerMcpInfo = { enabled: false };
    private sessionLabel = "erdblick";

    get connectionInfo(): ViewerMcpInfo { return this.info; }
    get hasPendingAction(): boolean { return this.pending.size > 0; }
    get label(): string { return this.sessionLabel; }
    private get registered(): boolean { return this.availability$.value.message === "ready"; }

    constructor(
        private readonly state: AppStateService,
        private readonly actions: AppActionRegistry,
        private readonly zone: NgZone,
        private readonly stream: MapTileStreamService,
        private readonly ui: UiAutomationService,
        private readonly config: AppConfigService
    ) { }

    /**
     * Subscribe to relay connection changes and discover the backend's MCP catalog.
     * Application startup calls this once after deployment config and the map stream are initialized;
     * discovery runs asynchronously while the viewer continues loading.
     */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;

        // Community deployments keep the ordinary tile connection, but must
        // neither discover MCP nor listen for agent commands on that connection.
        if (!this.config.snapshot.mcpEnabled) return;

        this.subscriptions.add(this.stream.actionClientId$.subscribe(clientId => {
            if (clientId === this.clientId) return;
            for (const call of this.pending.values()) if (call.clientId !== null) this.finish(call, undefined, {
                code: "disconnected", message: "Interactive connection ended", outcome: "not_applied"
            }, false);
            this.completedCalls.clear();
            this.ui.clear();
            this.clientId = clientId;
            this.register();
        }));
        this.subscriptions.add(this.stream.actionControlReceived.subscribe(({ payload, receivedAt }) => this.receive(payload, receivedAt)));

        void this.zone.runOutsideAngular(async () => {
            // Catalog/schema startup may occupy the main thread while this small
            // response is already in flight. Use the action transport's 30-second
            // discovery budget, not five seconds. On timeout, MCP stays
            // unavailable for this viewer session.
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
                // Keep it in MCP availability state; the map continues loading,
                // and reloading can retry the adapter.
            } finally {
                clearTimeout(timer);
            }
        });
    }

    /**
     * Request cancellation of pending agent calls and report it to their callers.
     * Completed mutations and human searches are untouched.
     */
    stopCurrentAction(): void {
        for (const call of this.pending.values()) this.finish(call, undefined, {
            code: "cancelled", message: "Stopped by the user", outcome: "not_applied"
        });
    }

    /**
     * Change display metadata on the existing connection, never its identity or
     * authorization. Trim the label to 120 Unicode characters before sending it.
     */
    renameSession(label: string): void {
        this.sessionLabel = unicodePrefix(label.trim(), 120) || "erdblick";
        if (this.registered && this.clientId) this.stream.sendActionControl(this.clientId, {
            type: "mapget.actions.update", version: 1, catalogId: VIEWER_ACTION_CATALOG_ID,
            actions: Object.keys(this.actions.publicActions), label: this.sessionLabel
        });
    }

    /**
     * Abort discovery and pending calls, detach listeners and release UI automation
     * resources without sending on a later connection.
     */
    ngOnDestroy(): void {
        this.ui.clear();
        this.infoAbort.abort();
        this.subscriptions.unsubscribe();
        for (const call of this.pending.values()) this.finish(call, undefined, {
            code: "disconnected", message: "Viewer closed", outcome: "not_applied"
        }, false);
    }

    /**
     * Announce this viewer's action names once its catalog matches the backend's.
     * The backend catalog supplies the tool contracts; this message associates
     * those actions and the display label with the current interactive connection.
     */
    private register(): void {
        if (!this.info.enabled) {
            this.availability("waiting", "MCP is not enabled");
            return;
        }
        if (!this.info.catalogId) {
            this.availability("waiting", "Browser controls are not configured on this backend");
            return;
        }
        if (this.info.catalogId !== VIEWER_ACTION_CATALOG_ID) {
            this.availability("waiting", "The backend and browser action catalogs do not match");
            return;
        }
        if (!this.clientId) {
            this.availability("waiting", "Waiting for the interactive connection");
            return;
        }
        this.availability("connecting");
        const sent = this.stream.sendActionControl(this.clientId, {
            type: "mapget.actions.register", version: 1, catalogId: VIEWER_ACTION_CATALOG_ID,
            actions: Object.keys(this.actions.publicActions), label: this.sessionLabel
        });
        if (!sent) this.availability("waiting", "Could not send MCP registration; waiting for the interactive connection");
    }

    /**
     * Validate a relay message and route registration, cancellation or invocation
     * independently of tile request IDs and worker admission.
     */
    private receive(payload: unknown, receivedAt: number): void {
        const parsed = viewerActionServerMessageSchema.safeParse(payload);
        if (!parsed.success) {
            this.stopCurrentAction();
            this.availability("waiting", "Invalid MCP control message");
            return;
        }
        const message = parsed.data;
        if (message.type === "mapget.actions.registered" || message.type === "mapget.actions.updated") {
            const registered = this.info.enabled && this.info.catalogId === VIEWER_ACTION_CATALOG_ID
                && message.catalogId === VIEWER_ACTION_CATALOG_ID && message.clientId === this.clientId;
            this.availability(registered ? "ready" : "waiting", registered ? undefined : "MCP registration does not match this connection");
        } else if (message.type === "mapget.actions.error") {
            // Catalog replacement affects future admission, not already accepted work.
            const catalogChanged = message.error.reason === "catalog_changed";
            if (!catalogChanged) this.stopCurrentAction();
            this.availability("waiting", catalogChanged ? "MCP action catalog changed; reload the viewer" : `MCP controls unavailable: ${message.error.code}`);
        } else if (message.type === "mapget.actions.cancel") {
            const call = this.pending.get(message.callId);
            if (call) this.finish(call, undefined, { code: "cancelled", message: "Action cancelled", outcome: "not_applied" });
        } else {
            this.invoke(message, receivedAt);
        }
    }

    /**
     * Run a WebMCP tool in this document with the same admission, output validation
     * and Stop control as relayed calls. `action` names a registered tool and
     * `input` contains its arguments. The promise resolves with its validated
     * result or rejects with ViewerActionFailure. The caller's signal, Stop
     * control and a 30-second deadline can request cancellation.
     */
    invokeLocal(action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        if (!this.config.snapshot.mcpEnabled) {
            rejectAction("MCP is disabled for this deployment", "not_available");
        }
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

    /**
     * Admit a local or relayed call and schedule its execution in a microtask.
     * Allow up to four pending calls, with at most one mutation. Excess calls
     * receive `busy` immediately. The deadline includes time since receivedAt;
     * each admitted call gets a timer and AbortController released by finish().
     */
    private invoke(message: Extract<ViewerActionServerMessage, { type: "mapget.actions.invoke" }>, receivedAt: number,
        localComplete?: PendingViewerAction["localComplete"], signal?: AbortSignal): void {
        if ((!localComplete && !this.clientId) || this.pending.has(message.callId) || this.completedCalls.has(message.callId)) return;

        let error: ViewerActionError | undefined;
        const known = Object.hasOwn(this.actions.publicActions, message.action);
        const name = message.action as string;
        if (!localComplete && !this.registered) error = { code: "not_available", message: "Viewer action registration is unavailable", outcome: "not_applied" };
        else if (!known) error = { code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied" };
        else if (this.pending.size >= 4 || (this.actions.publicActions[name].mutation && [...this.pending.values()].some(call => call.mutation))) {
            error = { code: "busy", message: "Viewer action capacity is busy", outcome: "not_applied" };
        }
        if (error) {
            if (localComplete) localComplete(undefined, error);
            else this.stream.sendActionControl(this.clientId!, { type: "mapget.actions.result", version: 1, callId: message.callId, error });
            return;
        }

        const deadline = receivedAt + message.timeoutMs;
        const call: PendingViewerAction = {
            callId: message.callId, clientId: localComplete ? null : this.clientId, localComplete, action: name, arguments: message.arguments,
            mutation: this.actions.publicActions[name].mutation, deadline, controller: new AbortController(),
            timer: setTimeout(() => this.finish(call, undefined, {
                code: "timeout", message: "Action deadline expired", outcome: "not_applied"
            }), Math.max(0, deadline - performance.now())),
            activity: { action: name, status: "running" }
        };
        this.pending.set(call.callId, call);
        if (signal) {
            const cancel = () => this.finish(call, undefined, { code: "cancelled", message: "Action cancelled", outcome: "not_applied" });
            signal.addEventListener("abort", cancel, { once: true });
            call.removeAbortListener = () => signal.removeEventListener("abort", cancel);
            if (signal.aborted) { cancel(); return; }
        }

        this.zone.run(() => this.activity$.next([...this.activity$.value.slice(-19), call.activity]));
        queueMicrotask(() => {
            if (!this.pending.has(call.callId)) return;
            if (call.controller.signal.aborted || performance.now() >= call.deadline) {
                this.finish(call, undefined, { code: "timeout", message: "Action expired before execution", outcome: "not_applied" });
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

    /**
     * Check the action's output schema and encoded result size before replying.
     * Synchronous returns and resolved promises use this same path. An active
     * mutation completing past its deadline reports `applied` with the timeout.
     * Once cancellation or a timer has settled the call, late results are ignored.
     */
    private completeResult(call: PendingViewerAction, result: unknown): void {
        if (this.pending.get(call.callId) !== call) return;
        try {
            const validated = this.actions.publicActions[call.action].outputSchema.parse(result);
            if (this.encoder.encode(JSON.stringify(validated)).length > VIEWER_ACTION_RESULT_BYTES - 1024) {
                throw new Error("Viewer result exceeds the wire budget");
            }
            if (performance.now() >= call.deadline) {
                this.finish(call, undefined, { code: "timeout", message: "Action completed after its deadline", outcome: call.mutation ? "applied" : "not_applied" });
            } else this.finish(call, validated);
        } catch (error) { this.failCall(call, error); }
    }

    /**
     * Preserve an action's structured failure, or translate an unexpected exception.
     * An unexpected mutation failure reports `unknown`: the operation may have
     * changed application state before throwing.
     */
    private failCall(call: PendingViewerAction, error: unknown): void {
        this.finish(call, undefined, error instanceof ViewerActionFailure ? error.detail
            : { code: "internal_error", message: "Viewer action failed", outcome: call.mutation ? "unknown" : "not_applied" });
    }

    /**
     * Settle an active call once, release its timer/listener and update activity.
     * Local calls settle their promise. Relayed replies go to the connection that
     * admitted the call; a changed connection means the original caller has gone.
     * send=false is used while disconnecting or destroying this service.
     * Aborting requests cooperative cancellation; it cannot undo owner side effects.
     */
    private finish(call: PendingViewerAction, result?: unknown, error?: ViewerActionError, send = true): void {
        if (this.pending.get(call.callId) !== call) return;

        this.pending.delete(call.callId);
        clearTimeout(call.timer);
        call.controller.abort();
        call.removeAbortListener?.();
        this.completedCalls.add(call.callId);
        if (this.completedCalls.size > 256) this.completedCalls.delete(this.completedCalls.values().next().value!);

        if (call.localComplete) call.localComplete(result, error);
        else if (send && call.clientId && this.clientId === call.clientId) this.stream.sendActionControl(call.clientId, {
            type: "mapget.actions.result", version: 1, callId: call.callId, ...(error ? { error } : { result })
        });

        call.activity.status = error?.code ?? (call.mutation ? "applied" : "completed");
        this.zone.run(() => this.activity$.next([...this.activity$.value]));
    }

    /** Publishes readiness inside Angular for admission and UI, clearing obsolete diagnostics. */
    private availability(message: ViewerMcpAvailability["message"], detail?: string): void {
        this.zone.run(() => this.availability$.next({ enabled: this.info.enabled, message, detail }));
    }

    /**
     * Domain methods are registered by owners; the relay selects their Angular
     * execution boundary. Dispatch through AppActionRegistry's argument/result
     * checks, running mutations inside Angular so state changes refresh the UI
     * and read-only actions outside it to avoid unnecessary change detection.
     */
    execute(name: string, argumentsValue: unknown, signal?: AbortSignal): unknown | Promise<unknown> {
        const declaration = this.actions.publicActions[name as string];
        if (!declaration) throw new ViewerActionFailure({ code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied" });
        const invoke = () => this.actions.execute(name, argumentsValue, signal) as unknown | Promise<unknown>;
        return declaration.mutation ? this.zone.run(invoke) : this.zone.runOutsideAngular(invoke);
    }
}
