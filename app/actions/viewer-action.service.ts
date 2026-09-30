import {Injectable, NgZone, OnDestroy} from "@angular/core";
import {BehaviorSubject, Subscription} from "rxjs";
import type {z} from "zod";
import {AppStateService, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../shared/appstate.service";
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
    viewerActionServerMessageSchema, viewerMcpInfoSchema,
    type ViewerActionError, type ViewerActionServerMessage, type ViewerMcpInfo
} from "./viewer-action-relay.contract";
import {VIEWER_ACTION_CATALOG_ID} from "./generated/catalog-id";

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

/** Typed application failure, kept separate from tile failures and authentication errors. */
export class ViewerActionFailure extends Error {
    constructor(readonly detail: ViewerActionError) {
        super(detail.message);
    }
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
        private readonly stream: MapTileStreamService
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
                const result = this.execute(call.action, call.arguments);
                const validated = viewerActions[call.action].outputSchema.parse(result);
                if (this.encoder.encode(JSON.stringify(validated)).length > VIEWER_ACTION_RESULT_BYTES - 1024) {
                    throw new Error("Viewer result exceeds the wire budget");
                }
                if (performance.now() >= call.deadline) {
                    this.finish(call, undefined, {code: "timeout", message: "Action completed after its deadline",
                        outcome: call.mutation ? "applied" : "not_applied"});
                } else {
                    this.finish(call, validated);
                }
            } catch (error) {
                this.finish(call, undefined, error instanceof ViewerActionFailure ? error.detail
                    : {code: "internal_error", message: "Viewer action failed", outcome: call.mutation ? "unknown" : "not_applied"});
            }
        });
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

    /** Validates and invokes a synchronous initial action; transport admission/cancellation stays separate. */
    execute(name: string, argumentsValue: unknown): ViewerActionOutput<ViewerActionName> {
        switch (name) {
            case "viewer_describe_app_state":
                return this.describe(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_get_app_state":
                return this.read(this.arguments(viewerActions[name].inputSchema, argumentsValue));
            case "viewer_set_app_state":
                return this.zone.run(() => this.set(this.arguments(viewerActions[name].inputSchema, argumentsValue)));
            default:
                throw new ViewerActionFailure({code: "unsupported_action", message: "Unsupported viewer action", outcome: "not_applied"});
        }
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

    /** Validates the complete synchronous commit before focus or camera state can change. */
    private set(input: ViewerActionInput<"viewer_set_app_state">): ViewerActionOutput<"viewer_set_app_state"> {
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
        const value = input.value;
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
