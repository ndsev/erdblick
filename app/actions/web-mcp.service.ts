import {Injectable, NgZone, OnDestroy} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {z} from "zod";
import {viewerActions, viewerJsonSchema} from "./viewer-action.contract";
import {ViewerActionService} from "./viewer-action.service";
import {ViewerActionFailure} from "./viewer-action-relay.contract";

/** The WebMCP document API subset used here; kept local until TypeScript's DOM library includes it. */
interface ModelContext {
    registerTool(tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: {readOnlyHint: boolean; untrustedContentHint: boolean};
        execute: (input: Record<string, unknown>, options: {signal: AbortSignal}) => Promise<unknown>;
    }, options: {signal: AbortSignal}): Promise<void>;
}

const nativeCatalogSchema = z.object({tools: z.array(z.object({
    name: z.string().startsWith("mapget_"), description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.object({readOnlyHint: z.boolean().optional()}).optional()
})).max(256)});
const rpcResponseSchema = z.object({
    jsonrpc: z.literal("2.0"), id: z.number(),
    result: z.unknown().optional(),
    error: z.object({code: z.number(), message: z.string(), data: z.unknown().optional()}).optional()
});

/** Owns document tool registrations and the authenticated, same-origin mapget bridge. */
@Injectable({providedIn: "root"})
export class WebMcpService implements OnDestroy {
    readonly status$ = new BehaviorSubject({supported: false, viewerTools: 0, mapgetTools: 0, message: "WebMCP is not available in this browser"});
    private readonly lifetime = new AbortController();
    private nativeRegistration = new AbortController();
    private context?: ModelContext;
    private requestId = 0;
    private initialized = false;
    private refreshing = false;
    private lastRefresh = -Infinity;

    constructor(private readonly actions: ViewerActionService, private readonly zone: NgZone) {}

    /** Register only after normal app initialization; unsupported browsers do no discovery work. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.context = (document as Document & {modelContext?: ModelContext}).modelContext;
        if (!this.context) return;
        this.status$.next({...this.status$.value, supported: true, message: "Starting WebMCP"});
        void this.zone.runOutsideAngular(async () => {
            try {
                for (const [name, action] of Object.entries(viewerActions)) {
                    await this.context!.registerTool({
                        name, description: `${action.description} Acts on this browser tab; no clientId is needed.`,
                        inputSchema: viewerJsonSchema(action.inputSchema),
                        annotations: {readOnlyHint: !action.mutation, untrustedContentHint: true},
                        execute: async (input, {signal}) => {
                            try {
                                return await this.actions.invokeLocal(name, input, AbortSignal.any([signal, this.lifetime.signal]));
                            } catch (error) {
                                if (error instanceof ViewerActionFailure) return {isError: true, error: error.detail};
                                throw error;
                            }
                        }
                    }, {signal: this.lifetime.signal});
                    this.update({viewerTools: this.status$.value.viewerTools + 1});
                }
                await this.refreshNative();
                window.addEventListener("focus", () => { void this.refreshNative(); }, {signal: this.lifetime.signal});
            } catch {
                // A partially registered set must not survive failed startup.
                this.lifetime.abort();
                this.nativeRegistration.abort();
                this.update({viewerTools: 0, mapgetTools: 0, message: "WebMCP registration failed"});
            }
        });
    }

    /** Reconcile server tools on activation; permission checks still happen on every server call. */
    private async refreshNative(): Promise<void> {
        if (this.refreshing || this.lifetime.signal.aborted || performance.now() - this.lastRefresh < 10000) return;
        this.refreshing = true;
        this.lastRefresh = performance.now();
        try {
            const catalog = nativeCatalogSchema.parse(await this.rpc("tools/list", {}, this.lifetime.signal));
            if (new Set(catalog.tools.map(tool => tool.name)).size !== catalog.tools.length) throw new Error("Duplicate native tool");
            this.nativeRegistration.abort();
            this.nativeRegistration = new AbortController();
            const registrationSignal = AbortSignal.any([this.lifetime.signal, this.nativeRegistration.signal]);
            for (const tool of catalog.tools) {
                await this.context!.registerTool({
                    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
                    annotations: {readOnlyHint: tool.annotations?.readOnlyHint === true, untrustedContentHint: true},
                    execute: (input, {signal}) => this.rpc("tools/call", {name: tool.name, arguments: input}, signal)
                }, {signal: registrationSignal});
            }
            this.update({mapgetTools: catalog.tools.length, message: "WebMCP ready for this tab and mapget"});
        } catch {
            this.nativeRegistration.abort();
            this.update({mapgetTools: 0, message: "WebMCP ready for this tab; mapget tools unavailable (server disabled or login required)"});
        } finally {
            this.refreshing = false;
        }
    }

    /** Use the browser's existing login; never store tokens or follow a server-provided endpoint. */
    private async rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const id = ++this.requestId;
        const request = JSON.stringify({jsonrpc: "2.0", id, method, params});
        if (new TextEncoder().encode(request).length > 64 * 1024) throw new Error("Mapget request exceeds 64 KiB");
        const response = await fetch(new URL("mcp/browser", document.baseURI), {
            method: "POST", credentials: "same-origin", redirect: "error",
            headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
            body: request, signal: AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30000)])
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Mapget browser request failed (${response.status}); check login and server MCP configuration`);
        }
        const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim();
        if (mime !== "application/json" && mime !== "text/event-stream") {
            await response.body?.cancel();
            throw new Error("Mapget returned an unsupported response format");
        }
        if (!response.body) throw new Error("Mapget returned an empty response");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0, text = "";
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 4 * 1024 * 1024) throw new Error("Mapget response exceeds 4 MiB");
                text += decoder.decode(chunk.value, {stream: true});
            }
            text += decoder.decode();
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
        // Mapget sends finite SSE: comments/heartbeats followed by exactly one terminal response.
        const messages = mime === "text/event-stream"
            ? text.replace(/\r\n/g, "\n").split("\n\n").map(event => event.split("\n")
                .filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n")).filter(Boolean)
            : [text];
        if (messages.length !== 1) throw new Error("Mapget returned an invalid response count");
        const reply = rpcResponseSchema.parse(JSON.parse(messages[0]));
        if (reply.id !== id) throw new Error("Mapget response ID mismatch");
        if (reply.error) throw new Error(`${reply.error.message}${reply.error.data ? ` ${JSON.stringify(reply.error.data)}` : ""}`);
        if (!("result" in reply)) throw new Error("Mapget response has no result");
        return reply.result;
    }

    /** Notify Angular only when availability changes, not while network chunks arrive. */
    private update(value: Partial<typeof this.status$.value>): void {
        if (!this.lifetime.signal.aborted || value.viewerTools === 0) {
            this.zone.run(() => this.status$.next({...this.status$.value, ...value}));
        }
    }

    /** Unregister only this service's tools and abort its own pending requests. */
    ngOnDestroy(): void {
        this.lifetime.abort();
        this.nativeRegistration.abort();
        this.status$.complete();
    }
}
