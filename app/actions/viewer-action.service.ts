import {Injectable, NgZone, OnDestroy} from "@angular/core";
import {BehaviorSubject, Subscription} from "rxjs";
import type {z} from "zod";
import {AppStateService, tileGridMaxLevel, type TileFeatureId, VIEW_SYNC_LAYERS, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../shared/appstate.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {Cartographic} from "../integrations/geo";
import {deepEquals} from "../shared/app-state";
import {unicodePrefix} from "../shared/unicode-string";
import {
    APP_STATE_COLLECTION_LIMIT, APP_STATE_TEXT_LIMIT, appStateChannels,
    appStateOmissionSchema, appStateValueSchema, type AppStateTarget
} from "../shared/app-state-channel.contract";
import {
    describeAppStateChannels, VIEWER_ACTION_RESULT_BYTES, viewerActions,
    type ViewerActionInput, type ViewerActionName, type ViewerActionOutput
} from "./viewer-action.contract";
import {
    viewerActionServerMessageSchema, viewerMcpInfoSchema, ViewerActionFailure,
    type ViewerActionError, type ViewerActionServerMessage, type ViewerMcpInfo
} from "./viewer-action-relay.contract";
import {VIEWER_ACTION_CATALOG_ID} from "./generated/catalog-id";
import {AppConfigService} from "../shared/app-config.service";
import {StyleService} from "../styledata/style.service";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {layerStyleOptions, layerPresetNode, type LayerTreeNode} from "../mapdata/map.tree.model";
import {TileSubsetLayerRenderService} from "../mapview/deck/tile-subset-layer-render.service";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {searchSettingsSchema, featureIdentitySchema, VIEWER_SCREENSHOT_MAX_BASE64} from "./viewer-operation.contract";
import {coreLib} from "../integrations/wasm";
import {parseFeatureInspectionTarget, formatFeatureInspectionTarget} from "../shared/tile-feature-id";
import {featureSearchDefinitionExport} from "../search/feature-search-export.util";
import type {FeatureSearchSession} from "../search/feature.search.service";
import {parsePartition, partitionKeySuffix} from "../mapdata/partition.model";
import {ViewerUiService} from "./viewer-ui.service";

/** Small activity summary: never includes arguments, session UUIDs, credentials or map data. */
export interface ViewerActionActivity {
    action: string;
    status: "running" | "applied" | "completed" | ViewerActionError["code"];
}

interface PendingViewerAction {
    callId: string;
    clientId: string;
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
    private readonly descriptors = describeAppStateChannels();
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
    private capturingScreenshot = false;

    get connectionInfo(): ViewerMcpInfo { return this.info; }
    get hasPendingAction(): boolean { return this.pending.size > 0; }
    get label(): string { return this.sessionLabel; }

    constructor(
        private readonly state: AppStateService,
        private readonly views: MapViewStateService,
        private readonly maps: MapInfoService,
        private readonly searches: FeatureSearchService,
        private readonly inspections: InspectionSelectionService,
        private readonly zone: NgZone,
        private readonly stream: MapTileStreamService,
        private readonly styles: StyleService,
        private readonly config: AppConfigService,
        private readonly render: TileSubsetLayerRenderService,
        private readonly diagnostics: DiagnosticsFacadeService,
        private readonly viewDiagnostics: ViewLayerDiagnosticsService,
        private readonly styleReports: StyleValidationReportService,
        private readonly ui: ViewerUiService
    ) {}

    /** Starts the optional control adapter after ordinary app/stream initialization, without delaying the map. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.subscriptions.add(this.stream.actionClientId$.subscribe(clientId => {
            if (clientId === this.clientId) return;
            for (const call of this.pending.values()) this.finish(call, undefined, {
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
            const timer = setTimeout(() => this.infoAbort.abort(), 5000);
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
            this.stopCurrentAction();
            this.registered = false;
            this.availability(`MCP controls unavailable: ${message.error.code}`);
        } else if (message.type === "mapget.actions.cancel") {
            const call = this.pending.get(message.callId);
            if (call) this.finish(call, undefined, {code: "cancelled", message: "Action cancelled", outcome: "not_applied"});
        } else {
            this.invoke(message, receivedAt);
        }
    }

    /** Admits bounded calls without a mutation queue; every admitted call owns its cancellation/deadline. */
    private invoke(message: Extract<ViewerActionServerMessage, {type: "mapget.actions.invoke"}>, receivedAt: number): void {
        if (!this.clientId || this.pending.has(message.callId) || this.completedCalls.has(message.callId)) return;
        let error: ViewerActionError | undefined;
        const known = Object.hasOwn(viewerActions, message.action);
        const name = message.action as ViewerActionName;
        if (!this.registered) error = {code: "not_available", message: "Viewer action registration is unavailable", outcome: "not_applied"};
        else if (!known) error = {code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied"};
        else if (this.pending.size >= 4 || (viewerActions[name].mutation && [...this.pending.values()].some(call => call.mutation))) {
            error = {code: "busy", message: "Viewer action capacity is busy", outcome: "not_applied"};
        }
        if (error) {
            this.stream.sendActionControl(this.clientId, {type: "mapget.actions.result", version: 1, callId: message.callId, error});
            return;
        }
        const deadline = receivedAt + message.timeoutMs;
        const call: PendingViewerAction = {
            callId: message.callId, clientId: this.clientId, action: name, arguments: message.arguments,
            mutation: viewerActions[name].mutation, deadline, controller: new AbortController(),
            timer: setTimeout(() => this.finish(call, undefined, {
                code: "timeout", message: "Action deadline expired", outcome: "not_applied"
            }), Math.max(0, deadline - performance.now())),
            activity: {action: name, status: "running"}
        };
        this.pending.set(call.callId, call);
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
        this.completedCalls.add(call.callId);
        if (this.completedCalls.size > 256) this.completedCalls.delete(this.completedCalls.values().next().value!);
        if (send && this.clientId === call.clientId) this.stream.sendActionControl(call.clientId, {
            type: "mapget.actions.result", version: 1, callId: call.callId, ...(error ? {error} : {result})
        });
        call.activity.status = error?.code ?? (call.mutation ? "applied" : "completed");
        this.zone.run(() => this.activity$.next([...this.activity$.value]));
    }

    /** Notifies Angular only for control availability changes, not streamed tile/camera frames. */
    private availability(message: string): void {
        this.zone.run(() => this.availability$.next({enabled: this.info.enabled, ready: this.registered, message}));
    }

    /** Validates and invokes actions; transport admission and cancellation stay separate. */
    execute(name: string, argumentsValue: unknown, signal?: AbortSignal): ViewerActionOutput<ViewerActionName> | Promise<ViewerActionOutput<ViewerActionName>> {
        if (signal?.aborted) this.reject("Action cancelled", "cancelled");
        switch (name) {
            case "viewer_describe_app_state":
                return this.describe(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_get_app_state":
                return this.read(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_set_app_state":
                return this.zone.run(() => this.set(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_get_catalog": return this.catalog(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_manage_view": return this.zone.run(() => this.manageView(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_navigate": return this.navigate(this.arguments(viewerActions[name].inputSchema, argumentsValue), signal);
            case "viewer_inspect": return this.inspect(this.arguments(viewerActions[name].inputSchema, argumentsValue), signal);
            case "viewer_close_inspection": return this.zone.run(() => {
                const {panelId} = this.arguments(viewerActions[name].inputSchema, argumentsValue);
                if (!this.state.selection.some(panel => panel.id === panelId)) this.reject("The inspection no longer exists");
                this.state.unsetPanel(panelId);
                return this.applied();
            });
            case "viewer_open_source_data": return this.zone.run(() => this.openSourceData(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_start_search": return this.zone.run(() => this.startSearch(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_control_search": return this.zone.run(() => this.controlSearch(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_get_search": return this.getSearch(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_set_search": return this.zone.run(() => this.setSearch(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_get_search_results": return this.searchResults(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_export_search": return this.exportSearch(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_get_style": return this.getStyle(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_validate_style": return this.validateStyle(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_edit_style": return this.zone.run(() => this.editStyle(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_get_diagnostics": return this.getDiagnostics(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_screenshot": return this.zone.runOutsideAngular(() => this.screenshot(this.arguments(viewerActions[name].inputSchema, argumentsValue), signal));
            case "viewer_take_snapshot": return this.zone.runOutsideAngular(() => this.ui.snapshot(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_get_element": return this.zone.runOutsideAngular(() => this.ui.getElement(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_click": return this.zone.run(() => this.ui.click(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_fill": return this.zone.run(() => this.ui.fill(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_scroll": return this.zone.run(() => this.ui.scroll(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            case "viewer_resize": return this.zone.run(() => this.ui.resize(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            default:
                throw new ViewerActionFailure({code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied"});
        }
    }

    /** Captures only on demand; owns admission until DOM rasterization settles, even if the relay call was cancelled. */
    private async screenshot(input: ViewerActionInput<"viewer_screenshot">, signal?: AbortSignal): Promise<ViewerActionOutput<"viewer_screenshot">> {
        if (this.capturingScreenshot) this.reject("A screenshot is already being captured", "busy");
        this.capturingScreenshot = true;
        const revision = input.viewLayoutRevision ?? this.views.viewLayoutRevision;
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const deadline = performance.now() + 15000;
        const check = () => {
            if (signal?.aborted) this.reject("Screenshot cancelled", "cancelled");
            if (performance.now() >= deadline) this.reject("Screenshot capture exceeded its time budget", "timeout");
            this.checkView(0, revision);
            if (document.documentElement.clientWidth !== viewportWidth || document.documentElement.clientHeight !== viewportHeight) {
                this.reject("The viewport resized during capture; retry", "not_available", "stale_view_layout");
            }
        };
        try {
            check();
            if (!viewportWidth || !viewportHeight || viewportWidth > 32768 || viewportHeight > 32768
                || viewportWidth * viewportHeight > 32 * 1024 * 1024) this.reject("Viewport is unavailable or too large for capture");
            // Lazy loaded: ordinary browsing pays no DOM-capture startup/runtime cost.
            const {default: domToImage} = await import("dom-to-image-more");
            check();
            const scale = Math.min(1, (input.maxWidth ?? 1280) / viewportWidth, (input.maxHeight ?? 960) / viewportHeight);
            const canvases = new Map<HTMLCanvasElement, string>();
            for (let index = 0; index < this.state.numViews; ++index) {
                const view = this.views.renderViewFor(index);
                if (!view?.isAvailable()) this.reject("A map renderer is not ready for capture");
                const snapshot = view.captureCanvas(scale);
                canvases.set(snapshot.canvas, snapshot.dataUrl);
            }
            const capturedAt = new Date().toISOString();
            const warnings = new Set(["DOM-based capture: browser chrome, pointer and some CSS effects are not captured. This is not a render-ready fence."]);
            let nodeCount = 0;
            let canvas = await domToImage.toCanvas(document.body, {
                width: viewportWidth, height: viewportHeight, scale, pixelRatio: 1, preserveScroll: true,
                // Computed styles already resolve theme variables. Copying thousands of inherited PrimeNG
                // tokens onto every node bloats the SVG and can take seconds; default-style probing also forces layout.
                copyDefaultStyles: false, filterStyles: (_node, property) => !property.startsWith("--"),
                bgcolor: getComputedStyle(document.body).backgroundColor, httpTimeout: 3000,
                filter: node => {
                    check();
                    if (++nodeCount > 20000) this.reject("Visible UI exceeds the screenshot node budget");
                    if (node instanceof Element && getComputedStyle(node).display === "none") return false;
                    // Cross-origin/interactive embedded documents cannot be reproduced safely by a DOM snapshot.
                    if (node instanceof HTMLIFrameElement || node instanceof HTMLVideoElement) {
                        warnings.add("Embedded frames/video are omitted from DOM capture.");
                        return false;
                    }
                    return true;
                },
                adjustClonedNode: (original, clone, after) => {
                    check();
                    // Let the library fill resolved computed values, not retain inline var()/relative
                    // styles whose theme definitions or containing block are absent in the standalone SVG.
                    if (!after && clone instanceof Element) clone.removeAttribute("style");
                    if (original instanceof HTMLCanvasElement && clone instanceof HTMLImageElement && canvases.has(original)) {
                        clone.src = canvases.get(original)!;
                    }
                },
                onclone: clone => {
                    check();
                    // Never serialize actual password values into the intermediate SVG.
                    if (clone instanceof Element) for (const password of clone.querySelectorAll('input[type="password"]')) {
                        const value = password.getAttribute("value") ?? "";
                        password.setAttribute("value", "•".repeat(Math.min(value.length, 256)));
                    }
                },
                onImageError: () => warnings.add("Some UI images or fonts could not be embedded; capture may be incomplete."),
                logger: {warn: () => warnings.add("The DOM renderer reported a capture limitation."),
                    error: () => warnings.add("The DOM renderer could not reproduce some UI content.")}
            });
            check();
            // Keep existing relay bounds, not an unbounded screenshot escape hatch. Prefer readable text over very low JPEG quality.
            for (let attempt = 0; attempt < 6; ++attempt) {
                for (const quality of [0.9, 0.75]) {
                    const url = canvas.toDataURL("image/jpeg", quality);
                    if (!url.startsWith("data:image/jpeg;base64,")) this.reject("Browser cannot encode the screenshot as JPEG");
                    const data = url.slice("data:image/jpeg;base64,".length);
                    if (data.length <= VIEWER_SCREENSHOT_MAX_BASE64) {
                        if (canvas.width < viewportWidth || canvas.height < viewportHeight) warnings.add("Image downscaled to fit the requested dimensions and transport budget.");
                        return {image: {mimeType: "image/jpeg", data}, metadata: {scope: "application-viewport", width: canvas.width,
                            height: canvas.height, viewportWidth, viewportHeight, viewLayoutRevision: revision, capturedAt,
                            readiness: {status: "unknown"}, warnings: [...warnings]}};
                    }
                }
                const smaller = document.createElement("canvas");
                smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
                smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
                const context = smaller.getContext("2d");
                if (!context) this.reject("Screenshot canvas is unavailable");
                context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
                canvas = smaller;
                check();
            }
            this.reject("Screenshot exceeds the response budget; request smaller dimensions");
        } catch (error) {
            if (error instanceof ViewerActionFailure) throw error;
            this.reject("Application screenshot failed; a canvas or UI resource may be inaccessible");
        } finally {
            this.capturingScreenshot = false;
        }
    }

    /** Acknowledges owner-side mutation only, never asynchronous data/render completion. */
    private applied(changed = true) {
        return {status: "applied" as const, changed, viewLayoutRevision: this.views.viewLayoutRevision};
    }

    /** Bounds iteration and serialization before returning a collection, not after making a full copy. */
    private collection<T>(source: Iterable<T>, limit = 100, byteLimit = 180000): {items: T[]; complete: boolean; reason?: "item_limit" | "byte_limit"} {
        const items: T[] = [];
        let bytes = 2;
        for (const item of source) {
            if (items.length >= limit) return {items, complete: false, reason: "item_limit"};
            const size = this.encoder.encode(JSON.stringify(item)).length + 1;
            if (bytes + size > byteLimit) return {items, complete: false, reason: "byte_limit"};
            items.push(item);
            bytes += size;
        }
        return {items, complete: true};
    }

    /** Discovers small UI metadata without exposing source configuration, URLs or secret headers. */
    private catalog(input: ViewerActionInput<"viewer_get_catalog">): ViewerActionOutput<"viewer_get_catalog"> {
        if (input.viewIndex !== undefined) this.checkView(input.viewIndex, this.views.viewLayoutRevision);
        if (input.layerId && !input.mapId) this.reject("layerId requires mapId", "invalid_arguments");
        const vi = input.viewIndex ?? this.state.focusedView;
        const map = input.mapId ? this.maps.maps.maps.get(input.mapId) : undefined;
        if (input.mapId && !map) this.reject("The requested map is unavailable");
        const layer = input.layerId ? this.layer(input.mapId!, input.layerId) : undefined;
        type Item = ViewerActionOutput<"viewer_get_catalog">["items"][number];
        const candidates = function* (this: ViewerActionService): Generator<Item> {
            if (input.kind === "backgrounds") {
                for (const background of this.config.getBackgroundLayers()) yield {id: background.id, name: background.name, kind: background.type};
            } else if (input.kind === "layers") {
                for (const candidate of map ? [map] : this.maps.maps.maps.values()) {
                    for (const child of layer ? [layer] : candidate.layers.values()) yield {
                        id: child.id, name: child.id, mapId: candidate.id, layerId: child.id, kind: child.type,
                        visible: child.viewConfig[vi]?.visible ?? false, available: this.maps.isMapReady(candidate.id)
                    };
                }
            } else if (input.kind === "styles") {
                const applicable = layer ? new Set(layerStyleOptions(layer).map(option => option.styleId)) : null;
                for (const style of this.styles.styles.values()) {
                    if ((input.styleId && style.id !== input.styleId) || (applicable && !applicable.has(style.id))) continue;
                    yield {id: style.id, name: style.id, kind: style.category, visible: style.visible, imported: style.imported, modified: style.modified};
                }
            } else if (input.kind === "options") {
                if (!layer) this.reject("Option discovery requires mapId and layerId", "invalid_arguments");
                for (const option of layerStyleOptions(layer)) {
                    if (option.info.internal || (input.styleId && option.styleId !== input.styleId)) continue;
                    yield {id: option.id, name: option.info.label, kind: option.type, styleId: option.styleId, mapId: layer.mapId, layerId: layer.id,
                        value: option.value[vi], defaultValue: option.info.defaultValue, description: unicodePrefix(option.info.description, 4096)};
                }
            } else {
                if (!map) this.reject("Preset discovery requires mapId", "invalid_arguments");
                if (layer) {
                    for (const preset of layerPresetNode(layer)?.presets ?? []) {
                        if (!input.styleId || preset.styleId === input.styleId) yield {id: preset.id, name: preset.name, kind: "layer", styleId: preset.styleId, mapId: map.id, layerId: layer.id};
                    }
                } else for (const preset of map.mapPresets) yield {id: preset.id, name: preset.name, kind: "map", mapId: map.id,
                    available: !this.maps.isSyncOptionsForViewEnabled(vi) || !this.maps.maps.mapPresetHasSyncConflict(map, preset)};
            }
        }.bind(this);
        return {observedAt: new Date().toISOString(), ...this.collection(candidates(), input.limit)};
    }

    /** Creates/removes comparison views using the same retained-camera/layout path as the UI. */
    private manageView(input: ViewerActionInput<"viewer_manage_view">): ViewerActionOutput<"viewer_manage_view"> {
        this.checkView(input.viewIndex, input.viewLayoutRevision);
        if (input.operation === "remove") {
            if (this.state.numViews === 1) this.reject("Cannot remove the last view", "invalid_arguments");
            this.views.removeView(input.viewIndex);
        } else {
            if (this.state.numViews >= 2) this.reject("The comparison layout already has two views");
            this.state.focusedView = input.viewIndex;
            this.state.numViews += 1;
        }
        return this.applied();
    }

    /** Uses the native key factory for backend-returned source references; the panel owns address resolution. */
    private openSourceData(input: ViewerActionInput<"viewer_open_source_data">): ViewerActionOutput<"viewer_open_source_data"> {
        const source = input.source;
        if (!("mapTileKey" in source) && source.partition.kind === "object" && BigInt(source.partition.id) > 18446744073709551615n) {
            this.reject("Object partition exceeds uint64", "invalid_arguments");
        }
        const mapTileKey = "mapTileKey" in source ? source.mapTileKey : coreLib.createMapTileKey(
            "SourceData", source.mapId, source.reference.layerId, partitionKeySuffix(parsePartition(source.partition)));
        const parsed = this.stream.parseMapPartitionKeySafe(mapTileKey);
        if (!parsed || !mapTileKey.startsWith("SourceData:")) this.reject("Expected a native SourceData key", "invalid_arguments");
        const address = "mapTileKey" in source ? source.address : source.reference.address;
        if (address !== undefined && BigInt(address) > 18446744073709551615n) this.reject("Address exceeds uint64", "invalid_arguments");
        const panelId = this.state.setSelection({mapTileKey, ...(address === undefined ? {} : {address: BigInt(address)})}, undefined, input.newPanel ?? false);
        if (panelId === undefined) this.reject("An inspection could not be opened");
        return {status: "applied", panelId, mapTileKey};
    }

    /** Resolves an existing session without implicitly restoring, starting or analyzing a search. */
    private search(searchId: string): FeatureSearchSession {
        const session = this.searches.getSession(searchId);
        if (!session) this.reject("The search has no active session");
        return session;
    }

    /** Validates all view/layer choices before publishing a search definition. */
    private checkSearchTargets(mapLayers: Array<{mapId: string; layerId: string}>, viewIndices: number[], revision: number): void {
        for (const vi of viewIndices) this.checkView(vi, revision);
        for (const target of mapLayers) {
            const layer = this.layer(target.mapId, target.layerId);
            if (layer.type === "SourceData" || !this.maps.isMapLayerReady(target.mapId, target.layerId)) this.reject("Search layers must be ready feature layers");
        }
    }

    /** Starts one visible ordinary search; configuration is complete before the first dispatch. */
    private startSearch(input: ViewerActionInput<"viewer_start_search">): ViewerActionOutput<"viewer_start_search"> {
        this.checkSearchTargets(input.mapLayers, input.viewIndices, input.viewLayoutRevision);
        const session = this.searches.run(input.query, {scope: input.scope, selectedMapLayers: input.mapLayers,
            selectedMapLayersManual: true, selectedViewIndices: input.viewIndices, autoUpdate: input.autoUpdate ?? false,
            selectedTileLevels: input.tileLevels ?? []});
        return {status: "applied", searchId: session.id};
    }

    /** Delegates lifecycle transitions to the search owner; Stop and Close intentionally differ. */
    private controlSearch(input: ViewerActionInput<"viewer_control_search">): ViewerActionOutput<"viewer_control_search"> {
        const session = this.search(input.searchId);
        if ((input.operation === "rerun") !== (input.query !== undefined)) this.reject("Only rerun accepts and requires query", "invalid_arguments");
        if (input.operation !== "close" && !session.definition.enabled) this.reject("Enable the search before controlling its runtime");
        if ((input.operation === "pause" && session.paused) || (input.operation === "resume" && !session.paused)) return this.applied(false);
        switch (input.operation) {
            case "pause": this.searches.pauseSearch(input.searchId); break;
            case "resume": this.searches.resumeSearch(input.searchId); break;
            case "stop": this.searches.stopSearch(input.searchId); break;
            case "close": this.searches.closeSearch(input.searchId); break;
            case "rerun": this.searches.rerunSearch(input.searchId, input.query!); break;
            case "refresh": this.searches.updateSearchInArea(input.searchId); break;
        }
        return this.applied();
    }

    /** Reads persisted settings and bounded errors, not result values or schema candidates. */
    private getSearch(input: ViewerActionInput<"viewer_get_search">): ViewerActionOutput<"viewer_get_search"> {
        const session = this.search(input.searchId);
        const {id: _id, query: _query, paused: _paused, selectedMapLayersManual: _manual, ...settings} = featureSearchDefinitionExport(session.definition);
        let textOmitted = false;
        const candidates = function* () {
            for (const error of session.errors) {
                const message = unicodePrefix(error, 4096);
                textOmitted ||= message !== error;
                yield message;
            }
        };
        const errors = this.collection(candidates(), 100, 32000);
        const query = unicodePrefix(session.definition.query, 4096);
        textOmitted ||= query !== session.definition.query;
        const parsedSettings = searchSettingsSchema.safeParse(settings);
        if (!parsedSettings.success) this.reject("Search settings exceed the public contract; narrow them in the UI first");
        return {observedAt: new Date().toISOString(), settings: parsedSettings.data,
            complete: errors.complete && !textOmitted, reason: errors.reason ?? (textOmitted ? "text_limit" : undefined), status: {
                searchId: session.id, query, runId: session.runId, refresh: session.refresh,
                complete: session.complete, paused: session.paused, resultCount: session.searchResults.length,
                progressDone: session.progressDone, progressTotal: session.progressTotal, errors: errors.items
            }};
    }

    /** Publishes one fully validated search settings object without rewriting sibling searches. */
    private setSearch(input: ViewerActionInput<"viewer_set_search">): ViewerActionOutput<"viewer_set_search"> {
        const session = this.search(input.searchId);
        this.checkSearchTargets(input.settings.selectedMapLayers, input.settings.selectedViewIndices, input.viewLayoutRevision);
        const changed = !deepEquals(this.getSearch({searchId: input.searchId}).settings, input.settings);
        if (changed) this.state.patchFeatureSearch(session.id, {...input.settings, selectedMapLayersManual: true});
        return this.applied(changed);
    }

    /** Reads a bounded result slice; generation guards make repeated exports fail visibly after a rerun. */
    private searchResults(input: ViewerActionInput<"viewer_get_search_results">): ViewerActionOutput<"viewer_get_search_results"> {
        const session = this.search(input.searchId);
        if ((input.runId !== undefined && input.runId !== session.runId) || (input.refresh !== undefined && input.refresh !== session.refresh)) {
            this.reject("The search results changed; read its status again", "not_available", "stale_search");
        }
        const offset = input.offset ?? 0;
        let textOmitted = false;
        const source = function* () {
            for (let index = offset; index < session.searchResults.length; index++) {
                const entry = session.searchResults[index];
                const label = unicodePrefix(entry.label, 4096);
                textOmitted ||= label !== entry.label;
                yield {...entry, label};
            }
        };
        const result = this.collection(source(), input.limit);
        return {observedAt: new Date().toISOString(), searchId: session.id, runId: session.runId, refresh: session.refresh,
            offset, total: session.searchResults.length, searchComplete: session.complete, results: result.items,
            complete: result.complete && session.complete && !textOmitted, reason: result.reason ?? (textOmitted ? "text_limit" : session.complete ? undefined : "loading")};
    }

    /** Exports only the selected bounded slice, avoiding full result-tree construction and clipboard side effects. */
    private exportSearch(input: ViewerActionInput<"viewer_export_search">): ViewerActionOutput<"viewer_export_search"> {
        const results = this.searchResults(input);
        const configuration = input.include === "results" ? undefined : {
            ...this.getSearch({searchId: input.searchId}).settings, id: input.searchId,
            query: this.search(input.searchId).definition.query, paused: this.search(input.searchId).paused
        };
        const payload = {exportedAt: new Date().toISOString(), searchId: input.searchId, configuration,
            results: input.include === "configuration" ? undefined : results};
        const content = JSON.stringify(payload);
        if (this.encoder.encode(content).length > 180000) this.reject("Export exceeds the byte limit; request fewer results", "invalid_arguments");
        return {observedAt: payload.exportedAt, mimeType: "application/json", content,
            complete: input.include === "configuration" || results.complete, reason: input.include === "configuration" ? undefined : results.reason};
    }

    /** Returns bounded source text from the style owner, not server filesystem metadata. */
    private getStyle(input: ViewerActionInput<"viewer_get_style">): ViewerActionOutput<"viewer_get_style"> {
        const style = this.styles.styles.get(input.styleId);
        if (!style) this.reject("The style is unavailable");
        if (this.encoder.encode(style.source).length > 180000) this.reject("Style source exceeds the response budget");
        return {styleId: style.id, source: style.source, imported: style.imported, modified: style.modified, visible: style.visible};
    }

    /** Copies only bounded structured parser issues; installing the style remains a separate operation. */
    private validateStyle(input: ViewerActionInput<"viewer_validate_style">): ViewerActionOutput<"viewer_validate_style"> {
        const report = this.styles.validateStyleSource(input.source, this.styles.createEditorSourceRef("mcp-draft", input.source));
        const candidates = function* () {
            for (const issue of report.issues) yield {severity: issue.severity, message: unicodePrefix(issue.message, 4096), phase: issue.phase,
                rulePath: issue.rulePath, property: issue.property, line: issue.location?.line, column: issue.location?.column};
        };
        const issues = this.collection(candidates(), 100, 64000);
        return {valid: report.valid, loadable: report.loadable, issues: issues.items, complete: issues.complete, reason: issues.reason};
    }

    /** Edits normal browser-local styles only; no server write capability is implied by viewer-control. */
    private editStyle(input: ViewerActionInput<"viewer_edit_style">): ViewerActionOutput<"viewer_edit_style"> {
        const writesSource = input.operation === "create" || input.operation === "update";
        if (writesSource !== (input.source !== undefined)) this.reject("Create/update require source; other operations do not accept source", "invalid_arguments");
        if (input.visible !== undefined && input.operation !== "create" && input.operation !== "visibility") this.reject("Only create/visibility accepts visible", "invalid_arguments");
        if (input.operation === "create" && input.styleId !== undefined) this.reject("New style identity comes from its YAML", "invalid_arguments");
        const style = input.styleId ? this.styles.styles.get(input.styleId) : undefined;
        if (input.operation !== "create" && !style) this.reject("The style is unavailable");
        if (writesSource && !this.validateStyle({source: input.source!}).valid) this.reject("Style validation failed; use viewer_validate_style for issues", "invalid_arguments");
        let styleId = style?.id;
        switch (input.operation) {
            case "create": styleId = this.styles.importStyleYamlSource(input.source!, input.visible); break;
            case "update": styleId = this.styles.setStyleSource(style!.id, input.source!); break;
            case "reset":
                if (style!.imported) this.reject("Only builtin overrides can be reset", "invalid_arguments");
                styleId = this.styles.resetModifiedBuiltinStyle(style!.id);
                break;
            case "delete":
                if (!style!.imported) this.reject("Builtin styles cannot be deleted", "invalid_arguments");
                this.styles.deleteStyle(style!.id, true);
                break;
            case "visibility":
                if (input.visible === undefined) this.reject("Visibility requires a boolean", "invalid_arguments");
                this.styles.toggleStyle(style!.id, input.visible);
                break;
        }
        if (!styleId) this.reject("The style operation failed");
        return {status: "applied", styleId};
    }

    /** Resolves only explicitly requested identities; never guesses between ambiguous backend matches. */
    private async resolveFeatures(features: Array<z.infer<typeof featureIdentitySchema>>, signal?: AbortSignal): Promise<TileFeatureId[]> {
        const result: TileFeatureId[] = [];
        for (const feature of features) {
            signal?.throwIfAborted();
            if ("mapTileKey" in feature) {
                if (!this.stream.parseMapPartitionKeySafe(feature.mapTileKey) || !feature.mapTileKey.startsWith("Features:")) this.reject("Invalid feature partition key", "invalid_arguments");
                result.push(feature);
            } else {
                const matches = await this.stream.locateFeature(feature.mapId, feature.featureId, feature.layerId, signal);
                signal?.throwIfAborted();
                if (matches.length !== 1) this.reject(matches.length ? "Feature identity is ambiguous; supply its partition" : "Feature was not found");
                const target = parseFeatureInspectionTarget(feature.featureId);
                result.push({...matches[0], featureId: formatFeatureInspectionTarget({...target, baseFeatureId: matches[0].featureId})});
            }
        }
        return result.filter((feature, index) => result.findIndex(other => other.mapTileKey === feature.mapTileKey && other.featureId === feature.featureId) === index);
    }

    /** Publishes inspection shells after locate only; the existing selection owner performs asynchronous feature loading. */
    private async inspect(input: ViewerActionInput<"viewer_inspect">, signal?: AbortSignal): Promise<ViewerActionOutput<"viewer_inspect">> {
        if (input.panelId !== undefined && input.newPanel) this.reject("panelId and newPanel are mutually exclusive", "invalid_arguments");
        if (input.panelId !== undefined) {
            const panel = this.state.selection.find(panel => panel.id === input.panelId);
            if (!panel || panel.locked || panel.sourceData) this.reject("An explicit target must be an existing unlocked feature panel");
        }
        // Selection setters can mutate the same array in place; reference equality is not a change guard.
        let changed: boolean;
        const guard = this.state.selectionState.subscribe(() => { changed = true; });
        changed = false;
        let features: TileFeatureId[];
        try {
            features = await this.resolveFeatures(input.features, signal);
            signal?.throwIfAborted();
            if (changed) this.reject("Inspections changed while locating the feature", "cancelled");
        } finally { guard.unsubscribe(); }
        return this.zone.run(() => {
            if (input.panelId !== undefined || input.newPanel) {
                this.state.setSelection(features, input.panelId, input.newPanel ?? false);
            } else this.inspections.inspectFeatureIds(features, input.lock ?? false);
            const panels = this.state.selection.filter(panel => !panel.sourceData && panel.features.some(candidate =>
                features.some(feature => candidate.mapTileKey === feature.mapTileKey && candidate.featureId === feature.featureId)));
            if (input.lock) panels.forEach(panel => this.state.setInspectionPanelLockedState(panel.id, true));
            const represented = features.filter(feature => panels.some(panel => panel.features.some(candidate =>
                candidate.mapTileKey === feature.mapTileKey && candidate.featureId === feature.featureId)));
            return {status: "applied", panelIds: panels.map(panel => panel.id), features: represented,
                complete: represented.length === features.length, ...(represented.length < features.length ? {reason: "item_limit" as const} : {})};
        });
    }

    /** Owns cancellation only until the camera commit; human edits, layout changes and retired renderers win. */
    private async navigate(input: ViewerActionInput<"viewer_navigate">, signal?: AbortSignal): Promise<ViewerActionOutput<"viewer_navigate">> {
        this.checkView(input.viewIndex, input.viewLayoutRevision);
        const sync = this.state.viewSync.includes(VIEW_SYNC_POSITION) || this.state.viewSync.includes(VIEW_SYNC_MOVEMENT);
        const affected = sync ? Array.from({length: this.state.numViews}, (_, index) => index) : [input.viewIndex];
        const renderers = affected.map(index => this.views.renderViewFor(index));
        if (renderers.some(view => !view || view.isFirstPersonViewActive())) this.reject("Map navigation requires an available map camera");
        if (renderers.some(view => view!.isCameraInteractionActive())) this.reject("A human camera gesture is active", "busy");
        const controller = new AbortController();
        const abort = () => controller.abort(new ViewerActionFailure({code: "cancelled", message: "Navigation was interrupted", outcome: "not_applied"}));
        signal?.addEventListener("abort", abort, {once: true});
        if (signal?.aborted) abort();
        const guards = new Subscription();
        const poses = affected.map(index => this.views.renderViewFor(index)!.getLiveCameraState());
        const syncBefore = this.state.viewSync;
        guards.add(this.viewDiagnostics.cameraInteracting$.subscribe(active => { if (active && renderers.some(view => view!.isCameraInteractionActive())) abort(); }));
        guards.add(this.state.cameraViewDataState.appState.subscribe(() => {
            if (affected.some((index, offset) => !deepEquals(this.views.renderViewFor(index)?.getLiveCameraState(), poses[offset]))) abort();
        }));
        guards.add(this.state.viewSyncState.subscribe(value => { if (!deepEquals(value, syncBefore)) abort(); }));
        for (const view of renderers) guards.add(view!.rendererInvalidated.subscribe(abort));
        try {
            const target = input.target;
            const features = "features" in target ? await this.resolveFeatures(target.features, controller.signal) : undefined;
            const loaded = features ? await this.stream.loadFeatures(features, controller.signal) : undefined;
            controller.signal.throwIfAborted();
            this.checkView(input.viewIndex, input.viewLayoutRevision);
            if (features && loaded?.length !== features.length) this.reject("Some requested features could not be loaded");
            const position = loaded ? this.inspections.featureSetZoomTarget(loaded) : undefined;
            if (loaded && !position) this.reject("Some requested features have no usable geometry extent");
            let bounds: {west: number; south: number; east: number; north: number} | undefined;
            if ("bounds" in target) bounds = target.bounds;
            if ("mapTileKey" in target) {
                const parsed = this.stream.parseMapPartitionKeySafe(target.mapTileKey);
                if (!parsed || parsed[2].kind !== "tile") this.reject("Tile fitting requires a tile partition", "invalid_arguments");
                const box = coreLib.getTileBox(parsed[2].id);
                bounds = {west: box[0], south: box[1], east: box[2], north: box[3]};
            }
            if (bounds && (bounds.west >= bounds.east || bounds.south >= bounds.north)) this.reject("Bounds must have positive extent and not cross the antimeridian", "invalid_arguments");
            // No asynchronous work follows this point. Unsubscribe before our own camera notification.
            guards.unsubscribe();
            return this.zone.run(() => {
                controller.signal.throwIfAborted();
                this.state.focusedView = input.viewIndex;
                if (position) this.views.moveToWgs84PositionTopic.next({targetView: input.viewIndex, ...position});
                else this.views.moveToRectangleTopic.next({targetView: input.viewIndex, rectangle: bounds!});
                return this.applied();
            });
        } finally {
            guards.unsubscribe();
            signal?.removeEventListener("abort", abort);
        }
    }

    /** Samples fixed-size counters and existing caches only, never the per-tile diagnostics/export path. */
    private getDiagnostics(input: ViewerActionInput<"viewer_get_diagnostics">): ViewerActionOutput<"viewer_get_diagnostics"> {
        if (input.viewIndex !== undefined) this.checkView(input.viewIndex, this.views.viewLayoutRevision);
        if (input.layerId && !input.mapId) this.reject("layerId requires mapId", "invalid_arguments");
        if (input.mapId && !this.maps.maps.maps.has(input.mapId)) this.reject("The requested map is unavailable");
        if (input.mapId && input.layerId) this.layer(input.mapId, input.layerId);
        const sections = input.sections ?? ["transport", "workers", "loading", "gpu", "errors"];
        const metrics: ViewerActionOutput<"viewer_get_diagnostics">["metrics"] = [];
        const unavailable: string[] = [];
        const add = (section: string, values: Record<string, number | boolean | null>, cached = false) => {
            for (const [name, value] of Object.entries(values)) metrics.push({section, name, value: typeof value === "number" && !Number.isFinite(value) ? null : value, scope: "tab", cached});
        };
        if (sections.includes("transport")) add("transport", {
            connected: this.stream.isTileStreamConnected(), paused: this.stream.tilePipelinePaused,
            parseQueue: this.stream.getPendingFrameQueueSize(), downstreamBytesPerSecond: this.stream.getDownstreamBytesPerSecond(),
            ...this.stream.getTileStreamTransportCompressionStats()
        });
        if (sections.includes("workers")) add("workers", this.render.queueSummary());
        if (sections.includes("loading")) {
            if (input.viewIndex !== undefined || input.mapId) unavailable.push("Scoped loading counters are unavailable without a tile scan; tab-wide cached counters are returned.");
            const snapshot = this.diagnostics.snapshot$.value;
            add("loading", {expected: snapshot.tiles.expected, loaded: snapshot.tiles.loaded, errors: snapshot.tiles.errors,
                rendered: snapshot.progress.rendered.done, renderTotal: snapshot.progress.rendered.total,
                sampleAgeMs: Math.max(0, Date.now() - snapshot.at)}, true);
        }
        if (sections.includes("gpu")) {
            metrics.push({section: "gpu", name: "frameTimeP90Ms", value: this.render.currentFrameTimeMs(input.viewIndex) || null,
                scope: input.viewIndex === undefined ? "tab" : "view", ...(input.viewIndex === undefined ? {} : {viewIndex: input.viewIndex})});
            if (input.viewIndex !== undefined || input.mapId) unavailable.push("Scoped GPU allocation is unavailable; no scene readback or scan was performed.");
            else {
                let found = false;
                for (const stat of this.diagnostics.perfStats$.value) {
                    if (stat.scope === "view" && stat.path[1] === "GPU Scene" && metrics.length < 100) {
                        add("gpu", {[stat.key]: stat.average ?? stat.peak}, true);
                        found = true;
                    }
                }
                if (!found) unavailable.push("GPU allocation metrics have not been sampled by the performance diagnostics UI.");
            }
        }
        const errorItems = function* (this: ViewerActionService) {
            for (const issue of this.styleReports.reports$.value) {
                if (input.mapId && issue.runtimeContext?.mapName !== input.mapId) continue;
                if (input.layerId && issue.runtimeContext?.layerName !== input.layerId) continue;
                if (issue.severity !== "info") yield {source: issue.source.styleName ?? "style", message: unicodePrefix(issue.message, 4096)};
            }
            for (const session of this.searches.getSessions()) {
                if (input.viewIndex !== undefined && !session.definition.selectedViewIndices.includes(input.viewIndex)) continue;
                if (input.mapId && !session.definition.selectedMapLayers.some(layer => layer.mapId === input.mapId && (!input.layerId || layer.layerId === input.layerId))) continue;
                for (const error of session.errors) yield {source: session.id, message: unicodePrefix(error, 4096)};
            }
        }.bind(this);
        const errors = this.collection(sections.includes("errors") ? errorItems() : [], input.limit, 64000);
        if (sections.includes("errors") && input.viewIndex !== undefined) unavailable.push("Style errors have no per-view attribution; map/layer-filtered style issues and view-filtered search errors are returned.");
        return {observedAt: new Date().toISOString(), metrics, errors: errors.items, unavailable, complete: errors.complete, reason: errors.reason};
    }

    /** Rejects malformed/unexposed input without leaking arguments into error messages. */
    private arguments<T>(schema: z.ZodType<T>, value: unknown): T {
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            throw new ViewerActionFailure({code: "invalid_arguments", message: "Arguments do not match the viewer action schema", outcome: "not_applied"});
        }
        return parsed.data;
    }

    /** Describes trusted static channels and bounded current view availability. */
    private describe(input: ViewerActionInput<"viewer_describe_app_state">): ViewerActionOutput<"viewer_describe_app_state"> {
        const omissions: z.infer<typeof appStateOmissionSchema>[] = [];
        return {
            observedAt: new Date().toISOString(), viewLayoutRevision: this.views.viewLayoutRevision,
            channels: this.descriptors.filter(channel => (!input.channels || input.channels.includes(channel.name))
                && (input.prefix === undefined || channel.name.startsWith(input.prefix))),
            views: this.viewSummary(omissions),
            complete: omissions.length === 0, omissions
        };
    }

    /** Reads bounded summaries only; each channel is capped before adding it to the response. */
    private read(input: ViewerActionInput<"viewer_get_app_state">): ViewerActionOutput<"viewer_get_app_state"> {
        const result: ViewerActionOutput<"viewer_get_app_state"> = {
            observedAt: new Date().toISOString(), viewLayoutRevision: this.views.viewLayoutRevision,
            values: [], complete: true, omissions: []
        };
        const targets: AppStateTarget[] = input.targets ?? [
            {channel: "app.views"}, {channel: "app.selections"}, {channel: "app.searches"},
            ...Array.from({length: Math.min(this.state.numViews, 14)}, (_, viewIndex) => [
                {channel: "view.camera" as const, viewIndex}, {channel: "view.layers" as const, viewIndex}
            ]).flat()
        ];
        // Reserve space for all targets and omission metadata without serializing unbounded values.
        let budget = VIEWER_ACTION_RESULT_BYTES - 48 * 1024;
        if (!input.targets && this.state.numViews > 14) {
            result.omissions.push({target: {channel: "app.views"}, reason: "item_limit"});
        }
        for (const target of targets) {
            if (budget < 1024) {
                this.omit(result.omissions, target, "byte_limit");
                continue;
            }
            const value = this.readTarget(target, result.omissions, budget);
            const parsed = appStateValueSchema.safeParse(value);
            const entry: z.infer<typeof appStateValueSchema> = parsed.success ? parsed.data
                : {target, unavailable: "value_out_of_contract"};
            const size = this.encoder.encode(JSON.stringify(entry)).length;
            if (size > budget) {
                this.omit(result.omissions, target, "byte_limit");
                continue;
            }
            budget -= size;
            result.values.push(entry);
            if ("unavailable" in entry) result.complete = false;
        }
        result.complete &&= result.omissions.length === 0;
        return result;
    }

    /** Reads one declared target, with no whole-feature traversal or implicit data loading. */
    private readTarget(target: AppStateTarget, omissions: z.infer<typeof appStateOmissionSchema>[], budget: number): unknown {
        if ("viewIndex" in target && target.viewIndex >= this.state.numViews) {
            return {target, unavailable: "view_unavailable"};
        }
        switch (target.channel) {
            case "app.views": return {target, value: this.viewSummary(omissions)};
            case "view.camera": {
                const view = this.views.renderViewFor(target.viewIndex);
                if (!view) return {target, unavailable: "view_unavailable"};
                const value = view.getLiveCameraState();
                return value ? {target, value} : {target, unavailable: "first_person"};
            }
            case "view.layers": {
                if (target.layerId && !target.mapId) {
                    throw new ViewerActionFailure({code: "invalid_arguments", message: "layerId requires mapId", outcome: "not_applied"});
                }
                const map = target.mapId ? this.maps.maps.maps.get(target.mapId) : undefined;
                if (target.mapId && (!map || (target.layerId && !map.layers.has(target.layerId)))) {
                    return {target, unavailable: "target_unavailable"};
                }
                const layerValues = function* (this: ViewerActionService) {
                    for (const candidate of map ? [map] : this.maps.maps.maps.values()) {
                        for (const layer of target.layerId ? [candidate.layers.get(target.layerId)!] : candidate.layers.values()) {
                            const config = layer.viewConfig[target.viewIndex];
                            if (!config || (!target.mapId && !config.visible)) continue;
                            yield {mapId: candidate.id, layerId: layer.id, ...config};
                        }
                    }
                }.bind(this);
                return {target, value: this.boundedItems(layerValues(), target, omissions, budget)};
            }
            case "app.selections": {
                const panels = this.state.selectionState.getValue();
                if (target.panelId !== undefined && !panels.some(panel => panel.id === target.panelId)) {
                    return {target, unavailable: "target_unavailable"};
                }
                const runtime = new Map(this.inspections.selectionTopic.getValue().map(panel => [panel.id, panel]));
                const selections = function* (this: ViewerActionService) {
                    for (const panel of panels) {
                        if (target.panelId !== undefined && panel.id !== target.panelId) continue;
                        yield {
                            panelId: panel.id, locked: panel.locked, undocked: panel.undocked,
                            loading: panel.sourceData ? null : (runtime.has(panel.id) ? !!runtime.get(panel.id)!.loading : true),
                            features: this.boundedItems(panel.features, target, omissions, Math.min(budget, 32 * 1024)),
                            ...(panel.sourceData ? {sourceData: {
                                mapTileKey: panel.sourceData.mapTileKey,
                                ...(panel.sourceData.address !== undefined ? {address: panel.sourceData.address.toString()} : {})
                            }} : {})
                        };
                    }
                }.bind(this);
                return {target, value: this.boundedItems(selections(), target, omissions, budget)};
            }
            case "app.searches": {
                const definitions = this.state.featureSearchState.getValue();
                if (target.searchId && !definitions.some(definition => definition.id === target.searchId)) {
                    return {target, unavailable: "target_unavailable"};
                }
                const searches = function* (this: ViewerActionService) {
                    for (const definition of definitions) {
                        if (target.searchId && definition.id !== target.searchId) continue;
                        const runtime = this.searches.getSession(definition.id);
                        const query = unicodePrefix(definition.query, APP_STATE_TEXT_LIMIT);
                        if (query !== definition.query) this.omit(omissions, target, "text_limit");
                        yield {
                            searchId: definition.id, query,
                            enabled: definition.enabled, paused: runtime?.paused ?? definition.paused,
                            autoUpdate: definition.autoUpdate, showResultsOnMap: definition.showResultsOnMap,
                            ...(runtime ? {runtime: {
                                complete: runtime.complete, progressDone: runtime.progressDone, progressTotal: runtime.progressTotal,
                                resultCount: runtime.searchResults.length, errorCount: runtime.errors.size
                            }} : {})
                        };
                    }
                }.bind(this);
                return {target, value: this.boundedItems(searches(), target, omissions, budget)};
            }
            default:
                try { return {target, value: this.settingValue(target)}; }
                catch (error) {
                    if (error instanceof ViewerActionFailure && error.detail.code === "not_available") return {target, unavailable: "target_unavailable"};
                    throw error;
                }
        }
    }

    /** Samples only the small view registry; never inspects scene objects or GPU state. */
    private viewSummary(omissions: z.infer<typeof appStateOmissionSchema>[]): z.infer<typeof appStateChannels["app.views"]["valueSchema"]> {
        if (this.state.numViews > APP_STATE_COLLECTION_LIMIT) this.omit(omissions, {channel: "app.views"}, "item_limit");
        return {
            focusedView: this.state.focusedView, sync: [...this.state.viewSync],
            views: Array.from({length: Math.min(this.state.numViews, APP_STATE_COLLECTION_LIMIT)}, (_, viewIndex) => {
                const view = this.views.renderViewFor(viewIndex);
                return {
                    viewIndex, projection: this.state.mode2dState.getValue(viewIndex) ? "2d" : "3d",
                    navigationMode: !view ? "unavailable" : view.isFirstPersonViewActive() ? "first_person" : "map"
                };
            })
        };
    }

    /** Bounds collection copying and UTF-8 serialization work, not merely the final response size. */
    private boundedItems<T>(source: Iterable<T>, target: AppStateTarget, omissions: z.infer<typeof appStateOmissionSchema>[], budget: number): T[] {
        const result: T[] = [];
        let bytes = 2;
        for (const item of source) {
            if (result.length === APP_STATE_COLLECTION_LIMIT) {
                this.omit(omissions, target, "item_limit");
                break;
            }
            const size = this.encoder.encode(JSON.stringify(item)).length + 1;
            if (bytes + size > Math.max(0, budget - 512)) {
                this.omit(omissions, target, "byte_limit");
                break;
            }
            result.push(item);
            bytes += size;
        }
        return result;
    }

    /** Records at most one bounded omission per requested target. */
    private omit(omissions: z.infer<typeof appStateOmissionSchema>[], target: AppStateTarget, reason: z.infer<typeof appStateOmissionSchema>["reason"]): void {
        if (!omissions.some(omission => deepEquals(omission.target, target))) omissions.push({target, reason});
    }

    /** Looks up an identity-scoped layer without enumerating features or reparsing schemas. */
    private layer(mapId: string, layerId: string): LayerTreeNode {
        const layer = this.maps.maps.maps.get(mapId)?.layers.get(layerId);
        if (!layer) this.reject("The requested map/layer is unavailable");
        return layer;
    }

    /** Uses stable typed failures at the action boundary rather than UI toasts. */
    private reject(message: string, code: ViewerActionError["code"] = "not_available", reason?: string): never {
        throw new ViewerActionFailure({code, message, reason, outcome: "not_applied"});
    }

    /** Checks a view's identity before any mutation; view indices are not durable identities. */
    private checkView(viewIndex: number, revision: number | undefined): void {
        if (revision !== this.views.viewLayoutRevision) this.reject("The view layout changed; read it again", "not_available", "stale_view_layout");
        if (viewIndex < 0 || viewIndex >= this.state.numViews) this.reject("The requested view is unavailable");
    }

    /** Reads normalized values from their existing owners; storage representations never cross this API. */
    private settingValue(target: AppStateTarget): unknown {
        const vi = "viewIndex" in target ? target.viewIndex : 0;
        switch (target.channel) {
            case "view.projection": return this.state.mode2dState.getValue(vi) ? "2d" : "3d";
            case "view.background": return this.state.getBackgroundState(vi);
            case "view.grid": return {
                visible: this.maps.maps.getViewTileBorderState(vi), mode: this.maps.maps.getViewTileGridMode(vi),
                level: this.maps.maps.getViewTileGridLevel(vi), autoLevel: this.maps.maps.getViewTileGridAutoLevel(vi),
                color: this.maps.maps.getViewTileGridColor(vi), opacity: this.maps.maps.getViewTileGridOpacity(vi)
            };
            case "view.layer": return {...this.layer(target.mapId, target.layerId).viewConfig[vi]};
            case "view.styleOption": {
                const option = layerStyleOptions(this.layer(target.mapId, target.layerId)).find(option =>
                    option.styleId === target.styleId && option.id === target.optionId && !option.info.internal);
                if (!option) this.reject("The requested style option is unavailable");
                return option.value[vi];
            }
            case "view.layerPreset":
                this.layer(target.mapId, target.layerId);
                return this.state.getLayerPresetSelection(vi, target.mapId, target.layerId);
            case "view.mapPreset":
                if (!this.maps.maps.maps.has(target.mapId)) this.reject("The requested map is unavailable");
                return this.state.getMapPresetSelection(vi, target.mapId);
            case "app.focusedView": return this.state.focusedView;
            case "app.viewSync": return [...this.state.viewSync];
            case "app.marker": return {enabled: this.state.marker, position: this.state.markedPosition.length >= 2
                ? {lon: this.state.markedPosition[0], lat: this.state.markedPosition[1], alt: this.state.markedPosition[2] ?? 0} : null};
            case "app.preferences.rendering": return {
                antialiasing: this.state.deckAntialiasingEnabled, semanticCompositing: this.state.semanticCompositingEnabled,
                contactShading: this.state.contactShadingEnabled, tilePullCompression: this.state.tilePullCompressionEnabled,
                tileLimit: this.state.tilesLoadLimit, renderWorkers: this.state.tileSubsetRenderWorkerCount
            };
            case "app.preferences.navigation": return {zoomStep: this.state.mapZoomStep, featureZoomClearance: this.state.featureZoomClearanceMeters};
            case "app.preferences.inspection": return {
                limit: this.state.inspectionsLimit, drillPickRadius: this.state.drillPickRadius, expandByDefault: this.state.inspectionTreeExpandByDefault,
                varyColors: this.state.inspectionValueVaryColors, varyOutlines: this.state.inspectionValueVaryOutlines, varyStriping: this.state.inspectionValueVaryStriping
            };
            case "app.preferences.hover": return {enabled: this.state.hoverLabelsEnabled, fields: this.state.hoverLabelFields};
            case "inspection.panel": {
                const panel = this.state.selection.find(panel => panel.id === target.panelId);
                if (!panel) this.reject("The inspection no longer exists");
                return {locked: panel.locked, undocked: panel.undocked, focused: this.state.focusedInspectionPanelId === panel.id, color: panel.color};
            }
            default: this.reject("This channel is read-only", "invalid_arguments");
        }
    }

    /** Applies one coherent setting, validating dynamic choices before its first effect. */
    private setSetting(input: ViewerActionInput<"viewer_set_app_state">): ViewerActionOutput<"viewer_set_app_state"> {
        const target = input.target;
        if (!appStateChannels[target.channel].writable) this.reject("This channel is read-only", "invalid_arguments");
        if ("viewIndex" in target) this.checkView(target.viewIndex, input.viewLayoutRevision);
        const previous = this.settingValue(target);
        const previousFocus = this.state.focusedView;
        const vi = "viewIndex" in target ? target.viewIndex : 0;
        const raw = input.value;
        switch (target.channel) {
            case "view.projection": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                const affectedViews = this.state.viewSync.includes("proj")
                    ? Array.from({length: this.state.numViews}, (_, index) => index) : [vi];
                for (const index of affectedViews) {
                    const view = this.views.renderViewFor(index);
                    if (!view || view.isCameraInteractionActive() || view.isFirstPersonViewActive()) this.reject("Projection is unavailable during navigation", "busy");
                }
                this.state.focusedView = vi;
                this.state.setProjectionMode(vi, value === "2d");
                break;
            }
            case "view.background": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (value.layerId && !this.config.getBackgroundLayers().some(layer => layer.id === value.layerId)) this.reject("Unknown background", "invalid_arguments");
                this.state.setBackgroundState(vi, value.layerId, value.opacity);
                this.views.syncBackgroundSettings(vi);
                break;
            }
            case "view.grid": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (value.level > tileGridMaxLevel(value.mode)) this.reject("Grid level exceeds its coordinate system's range", "invalid_arguments");
                this.views.setViewTileGridMode(vi, value.mode);
                this.views.setViewTileGridLevel(vi, value.level);
                this.views.setViewTileGridAutoLevel(vi, value.autoLevel);
                this.views.setViewTileGridColor(vi, value.color);
                this.views.setViewTileGridOpacity(vi, value.opacity);
                this.views.setViewTileBorderVisibility(vi, value.visible);
                break;
            }
            case "view.layer": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.views.setMapLayerLevel(vi, target.mapId, target.layerId, value.level);
                this.views.setMapLayerAutoLevel(vi, target.mapId, target.layerId, value.autoLevel);
                this.views.setMapLayerVisibility(vi, target.mapId, target.layerId, value.visible);
                break;
            }
            case "view.styleOption": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                const option = layerStyleOptions(this.layer(target.mapId, target.layerId)).find(option =>
                    option.styleId === target.styleId && option.id === target.optionId && !option.info.internal)!;
                if (typeof value !== typeof option.info.defaultValue) this.reject("Value does not match the style option type", "invalid_arguments");
                option.value[vi] = value;
                this.maps.applyStyleOptionChange(option, vi);
                break;
            }
            case "view.layerPreset": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (!this.maps.applyLayerPreset(vi, target.mapId, target.layerId, value)) this.reject("The layer preset is unavailable");
                break;
            }
            case "view.mapPreset": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (!this.maps.applyMapPreset(vi, target.mapId, value)) this.reject("The map preset is unavailable or conflicts with synchronized options");
                break;
            }
            case "app.focusedView": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.checkView(value, input.viewLayoutRevision);
                this.state.focusedView = value;
                break;
            }
            case "app.viewSync": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (value.includes("pos") && value.includes("mov")) this.reject("Position and movement sync are mutually exclusive", "invalid_arguments");
                this.state.updateSelectedSyncOptions(value);
                break;
            }
            case "app.marker": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.state.setMarkerPosition(value.position ? Cartographic.fromDegrees(value.position.lon, value.position.lat, value.position.alt) : null);
                this.state.setMarkerState(value.enabled);
                break;
            }
            case "app.preferences.rendering": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.state.deckAntialiasingEnabled = value.antialiasing;
                this.state.semanticCompositingEnabled = value.semanticCompositing;
                this.state.contactShadingEnabled = value.contactShading;
                this.state.tilePullCompressionEnabled = value.tilePullCompression;
                this.state.tilesLoadLimit = value.tileLimit;
                this.state.tileSubsetRenderWorkerCount = value.renderWorkers;
                break;
            }
            case "app.preferences.navigation": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.state.mapZoomStep = value.zoomStep;
                this.state.featureZoomClearanceMeters = value.featureZoomClearance;
                break;
            }
            case "app.preferences.inspection": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.state.inspectionsLimit = value.limit;
                this.state.drillPickRadius = value.drillPickRadius;
                this.state.inspectionTreeExpandByDefault = value.expandByDefault;
                this.state.inspectionValueVaryColors = value.varyColors;
                this.state.inspectionValueVaryOutlines = value.varyOutlines;
                this.state.inspectionValueVaryStriping = value.varyStriping;
                break;
            }
            case "app.preferences.hover": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                this.state.hoverLabelsEnabled = value.enabled;
                this.state.hoverLabelFields = value.fields;
                break;
            }
            case "inspection.panel": {
                const value = this.arguments(appStateChannels[target.channel].valueSchema, raw);
                if (!value.undocked && !value.locked) this.reject("Docked inspections are locked", "invalid_arguments");
                this.state.setInspectionPanelUndockedState(target.panelId, value.undocked);
                this.state.setInspectionPanelLockedState(target.panelId, value.locked);
                this.state.setInspectionPanelColor(target.panelId, value.color);
                if (value.focused || this.state.focusedInspectionPanelId === target.panelId) this.state.setFocusedInspectionPanel(value.focused ? target.panelId : undefined);
                break;
            }
            default: this.reject("Unsupported writable channel", "invalid_arguments");
        }
        const value = this.settingValue(target);
        const synced = target.channel === "view.projection" ? this.state.viewSync.includes("proj") : this.state.viewSync.includes(VIEW_SYNC_LAYERS);
        return viewerActions.viewer_set_app_state.outputSchema.parse({
            status: "applied", target, value, changed: previousFocus !== this.state.focusedView || !deepEquals(previous, value),
            focusedView: this.state.focusedView, affectedViews: "viewIndex" in target
                ? synced ? Array.from({length: this.state.numViews}, (_, index) => index) : [vi] : [],
            viewLayoutRevision: this.views.viewLayoutRevision, readiness: {status: "unknown"}
        });
    }

    /** Validates the complete synchronous commit before focus or camera state can change. */
    private set(input: ViewerActionInput<"viewer_set_app_state">): ViewerActionOutput<"viewer_set_app_state"> {
        if (input.target.channel !== "view.camera") return this.setSetting(input);
        if (this.state.numViews > APP_STATE_COLLECTION_LIMIT) {
            throw new ViewerActionFailure({code: "not_available", message: "Too many views for one bounded camera operation", outcome: "not_applied"});
        }
        if (input.viewLayoutRevision !== this.views.viewLayoutRevision) {
            throw new ViewerActionFailure({code: "not_available", message: "The view layout changed; read it again", reason: "stale_view_layout", outcome: "not_applied"});
        }
        const viewIndex = input.target.viewIndex;
        const synchronized = this.state.viewSync.includes(VIEW_SYNC_POSITION) || this.state.viewSync.includes(VIEW_SYNC_MOVEMENT);
        const affectedViews = synchronized ? Array.from({length: this.state.numViews}, (_, index) => index) : [viewIndex];
        const view = this.views.renderViewFor(viewIndex);
        if (!view || affectedViews.some(index => !this.views.renderViewFor(index))) {
            throw new ViewerActionFailure({code: "not_available", message: "A target view is unavailable", reason: "view_unavailable", outcome: "not_applied"});
        }
        for (const index of affectedViews) {
            const targetView = this.views.renderViewFor(index)!;
            if (targetView.isFirstPersonViewActive()) {
                throw new ViewerActionFailure({code: "not_available", message: "Map-camera assignment is unavailable in first-person mode", reason: "first_person", outcome: "not_applied"});
            }
            if (targetView.isCameraInteractionActive()) {
                throw new ViewerActionFailure({code: "busy", message: "A human camera gesture is active", outcome: "not_applied"});
            }
        }
        const value = this.arguments(appStateChannels["view.camera"].valueSchema, input.value);
        if (this.state.mode2dState.getValue(viewIndex) && (value.orientation.heading !== 0
            || value.orientation.pitch !== -Math.PI / 2 || value.position?.some(component => component !== 0))) {
            throw new ViewerActionFailure({code: "invalid_arguments", message: "2D camera requires heading 0, top-down pitch and zero offset", outcome: "not_applied"});
        }
        const previousFocus = this.state.focusedView;
        const previous = affectedViews.map(index => this.views.renderViewFor(index)!.getLiveCameraState());
        try {
            this.state.focusedView = viewIndex;
            this.state.setView(viewIndex, Cartographic.fromDegrees(value.destination.lon, value.destination.lat, value.destination.alt),
                value.orientation, value.position ?? [0, 0, 0]);
            const result = viewerActions.viewer_set_app_state.outputSchema.parse({
                status: "applied", target: input.target, value: view.getLiveCameraState(), focusedView: this.state.focusedView,
                changed: previousFocus !== this.state.focusedView || affectedViews.some((index, offset) =>
                    !deepEquals(previous[offset], this.views.renderViewFor(index)!.getLiveCameraState())),
                affectedViews, viewLayoutRevision: this.views.viewLayoutRevision,
                // Existing full diagnostics rebuild tile rows on demand; do not scan them for an action acknowledgement.
                readiness: {status: "unknown"}
            });
            return result;
        } catch {
            throw new ViewerActionFailure({code: "internal_error", message: "Camera application failed; read the state before retrying", outcome: "unknown"});
        }
    }
}
