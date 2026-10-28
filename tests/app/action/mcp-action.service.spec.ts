import "@angular/compiler";
import domToImage from "dom-to-image-more";
import { BehaviorSubject, Subject } from "rxjs";
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from "vitest";
import { stateOwners } from '../../support/state-owners';
import { InspectionSelectionService } from '../../../app/inspection/inspection-selection.service';
import { MapDataService } from '../../../app/mapdata/mapdata.service';
import { MapTileStreamService } from '../../../app/mapdata/map-tile-stream.service';
import { StyleOptionNode } from "../../../app/mapdata/map-tree.controller";
import { MapViewService } from "../../../app/mapview/mapview.service";
import { ExternalViewerService } from "../../../app/navigation/external-viewer.service";
import { type FeatureSearchSession } from "../../../app/search/search.service";
import { JumpTargetService } from "../../../app/navigation/jump.service";
import { LocationNavigationService } from '../../../app/navigation/location-navigation.service';
import { AppStateService } from "../../../app/appstate/appstate.service";
import {
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    type CameraViewState
} from "../../../app/mapview/mapview.model";
import { createFeatureSearchStateEntry } from "../../../app/search/search-definition.model";
import type { StyleValidationReport } from "../../../app/mapstyle/style-validation.model";
import { type ErdblickStyle } from "../../../app/mapstyle/mapstyle.model";
import { AppActionRegistry } from '../../../app/action/action-registry.service';
import { VIEWER_ACTION_CATALOG_ID } from "../../../app/action/generated/catalog-id";
import { ViewerActionFailure } from "../../../app/action/viewer-action-relay.contract";
import { applicationControls, viewerActions, type ViewerActionOutput } from "../../support/action-contract";
import { McpActionService } from "../../../app/action/mcp-action.service";
import { UiAutomationService } from "../../../app/action/ui-automation.service";

vi.mock("dom-to-image-more", () => ({ default: { toCanvas: vi.fn() } }));

/** Supplies a complete schema-analysis record for otherwise partial search-service doubles. */
function readySearchAnalysis(query: string): FeatureSearchSession["schemaAnalysis"] {
    return {
        signature: "test", status: "ready", concreteScope: "feature", normalizedQuery: query,
        attributeScopes: [], attributeScopeCandidateCount: 0, rewriteSuppressed: false,
        rewriteSuppressionReason: "", matchedFieldNames: [], matchedEnumValues: [], matchedFeatureTypes: []
    };
}

/** Only the affinity method is used from the native style in these browser boundary tests. */
function styleFixture(fields: Partial<ErdblickStyle>): ErdblickStyle {
    return {
        id: 'style', source: '', imported: false, modified: false, visible: true,
        additional: false, category: 'base', options: [], presets: [], shortId: '', url: '',
        sourceRef: { sourceKind: 'editor' }, featureLayerStyle: { hasLayerAffinity: () => true } as never, ...fields
    };
}

/** Builds real state/sync owners, with inert renderers and no tile/schema/scene access. */
function setup() {
    const state = new AppStateService({
        events: new Subject(), routerState: { snapshot: { root: { queryParams: {} } } }, navigate: vi.fn()
    } as never, { showError: vi.fn() } as never);
    const owners = stateOwners(state);
    owners.viewSettings.importViews(['view-0', 'view-1']);
    owners.viewSettings.viewSyncState.next([]);
    owners.viewSettings.cameraViewDataState.next(0, camera(10, 40, 500));
    owners.viewSettings.cameraViewDataState.next(1, camera(20, 50, 1000));
    const mapRuntime = {
        layerStateChanged: new Subject<string>(), reapplySyncOptionsForAllViews: vi.fn(),
        maps: { maps: new Map() }, isMapReady: vi.fn(() => true), isMapLayerReady: vi.fn(() => true),
        stateService: state, viewSettings: owners.viewSettings, state: owners.layerState
    };
    const maps = Object.create(MapDataService.prototype) as MapDataService;
    Object.defineProperties(maps, Object.fromEntries(Object.entries(mapRuntime).map(([key, value]) => [key, { value, configurable: true, writable: true }])));
    const config = owners.configService;
    const views = new MapViewService(state, maps, owners.viewSettings, config);
    const renderers = [0, 1].map(viewIndex => {
        const viewId = owners.viewSettings.viewIdAt(viewIndex);
        return {
            viewIndex, viewId, isAvailable: vi.fn(() => true),
            getLiveCameraState: vi.fn((): CameraViewState | undefined => structuredClone(owners.viewSettings.cameraViewDataState.getValue(viewId))),
            isFirstPersonViewActive: vi.fn(() => false), isCameraInteractionActive: vi.fn(() => false), rendererInvalidated: new Subject<void>(),
            captureCanvas: vi.fn(() => ({ canvas: document.createElement('canvas'), dataUrl: 'data:image/png;base64,AAAA' }))
        };
    });
    renderers.forEach(renderer => views.registerRenderView(renderer as never));
    const searches = Object.assign(owners.searchService, {
        getSession: vi.fn<() => FeatureSearchSession | undefined>(() => undefined), getSessions: vi.fn(() => []),
        run: vi.fn(() => ({ id: 'search' })), pauseSearch: vi.fn(), resumeSearch: vi.fn(), stopSearch: vi.fn(), closeSearch: vi.fn(),
        rerunSearch: vi.fn(), updateSearchInArea: vi.fn()
    });
    Object.assign(searches, { mapInfo: maps, viewState: views });
    const zone = { run: vi.fn((callback: () => unknown) => callback()), runOutsideAngular: (callback: () => unknown) => callback() };
    const stream = {
        actionClientId$: new BehaviorSubject<string | null>(null), actionControlReceived: new Subject<{ payload: unknown; receivedAt: number }>(),
        sendActionControl: vi.fn(() => true),
        parseMapPartitionKeySafe: vi.fn((key: string) => key.startsWith('Features:') || key.startsWith('SourceData:') ? ['map', 'layer', { kind: 'tile', id: 1 }] : null),
        locateFeature: vi.fn<() => Promise<Array<{ mapTileKey: string; featureId: string }>>>(() => Promise.resolve([])),
        loadFeatures: vi.fn(() => Promise.resolve([])), isTileStreamConnected: vi.fn(() => true), tilePipelinePaused: false,
        getPendingFrameQueueSize: vi.fn(() => 0), getDownstreamBytesPerSecond: vi.fn(() => 100), getTileStreamTransportCompressionStats: vi.fn(() => ({})),
        resolveFeatureIdentities: MapTileStreamService.prototype.resolveFeatureIdentities
    };
    const inspections = Object.assign(new InspectionSelectionService(state, stream as never, views,
        { registerShortcut() { } } as never, { showError() { } } as never, zone as never, owners.inspectionState, owners.viewSettings), {
        inspectFeatureIds: vi.fn((features, lock) => {
            const panelId = owners.inspectionState.setSelection(features);
            if (lock && panelId !== undefined) owners.inspectionState.setInspectionPanelLockedState(panelId, true);
        }), featureSetZoomTarget: vi.fn(() => ({ x: 10, y: 40, z: 500 }))
    });
    const styles = Object.assign(owners.styleService, {
        validateStyleSource: vi.fn((): Pick<StyleValidationReport, 'valid' | 'loadable' | 'issues'> => ({ valid: true, loadable: true, issues: [] })),
        createEditorSourceRef: vi.fn(), importStyleYamlSource: vi.fn(() => 'new-style'), setStyleSource: vi.fn(() => 'style'),
        resetModifiedBuiltinStyle: vi.fn(() => 'style'), deleteStyle: vi.fn(), toggleStyle: vi.fn()
    });
    const render = { queueSummary: vi.fn(() => ({ queued: 3, latestNativeMs: 12 })), currentFrameTimeMs: vi.fn(() => 0), debugSnapshot: vi.fn() };
    const diagnostics = Object.assign(owners.diagnostics, { snapshot$: new BehaviorSubject({ at: Date.now(), tiles: { expected: 3, loaded: 2, errors: 1 }, progress: { rendered: { done: 1, total: 2 } } }), perfStats$: new BehaviorSubject([]) });
    const viewDiagnostics = { cameraInteracting$: new BehaviorSubject(false), snapshot: vi.fn() };
    const styleReports = { reports$: new BehaviorSubject<import('../../../app/mapstyle/style-validation.model').StyleValidationIssue[]>([]) };
    Object.assign(diagnostics, { mapService: stream, renderService: render, maps, searches, styleValidationReportService: styleReports });
    const navigation = new LocationNavigationService({} as never, views, state, viewDiagnostics as never, {} as never,
        {} as never, owners.viewSettings, stream as never, inspections, zone as never);
    const ui = new UiAutomationService(views, owners.viewSettings);
    const jumps = new JumpTargetService(maps, inspections, {} as never, {} as never, config,
        owners.coordinates, owners.inspectionState, owners.viewSettings, views);
    const external = new ExternalViewerService(config, owners.coordinates.state, owners.viewSettings);
    const actions = new AppActionRegistry(state);
    actions.registerContributors([jumps, external, views, maps, searches, inspections, styles, diagnostics, navigation, ui,
        owners.inspectionState, owners.coordinates, owners.url]);
    const service = new McpActionService(state, actions, zone as never, stream as never, ui);
    return { state, views, maps, renderers, searches, inspections, zone, service, stream, styles, config, render, diagnostics, viewDiagnostics, styleReports };
}

/** Uses a representable oblique camera so persisted decimal rounding is not a projection boundary. */
function camera(lon = 11, lat = 48, alt = 500): CameraViewState {
    return { destination: { lon, lat, alt }, orientation: { heading: 0, pitch: -1, roll: 0 }, position: [0, 0, 0] };
}

/** Calls the generic action boundary and validates its typed response. */
function read(service: McpActionService, targets?: unknown[]): ViewerActionOutput<"viewer_get_controls"> {
    return viewerActions.viewer_get_controls.outputSchema.parse(service.execute("viewer_get_controls", targets ? { targets } : {}));
}

describe("McpActionService", () => {
    const cleanups: AppStateService[] = [];
    const actionCleanups: McpActionService[] = [];
    afterEach(() => {
        actionCleanups.splice(0).forEach(service => service.ngOnDestroy());
        cleanups.splice(0).forEach(state => state.ngOnDestroy());
        localStorage.clear();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.mocked(domToImage.toCanvas).mockReset();
    });

    /** Keeps each real AppState owner scoped to its test. */
    function fixture() {
        const result = setup();
        cleanups.push(result.state);
        actionCleanups.push(result.service);
        return result;
    }

    /** Opens only the action boundary with a matching trusted catalog; there is no test websocket. */
    async function activeFixture() {
        const result = fixture();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
            enabled: true, endpoint: "http://localhost:8099/mcp", authentication: "local", scopes: [], catalogId: VIEWER_ACTION_CATALOG_ID
        }))));
        result.service.initialize();
        const clientId = "b3e68f32-3b51-472d-8cab-14b597f7de91";
        result.stream.actionClientId$.next(clientId);
        await vi.waitFor(() => expect(result.stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({ type: "mapget.actions.register" })));
        result.stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.registered", version: 1, clientId, catalogId: VIEWER_ACTION_CATALOG_ID
            }, receivedAt: performance.now()
        });
        expect(result.service.availability$.value.ready).toBe(true);
        result.stream.sendActionControl.mockClear();
        return { ...result, clientId };
    }

    it("runs WebMCP locally without backend registration or a clientId", async () => {
        const { service, stream } = fixture();
        const result = await service.invokeLocal("viewer_get_controls", {}, new AbortController().signal);
        expect(viewerActions.viewer_get_controls.outputSchema.safeParse(result).success).toBe(true);
        expect(stream.sendActionControl).not.toHaveBeenCalled();
        expect(service.activity$.value.at(-1)).toMatchObject({ action: "viewer_get_controls", status: "completed" });
        await expect(service.invokeLocal("viewer_get_controls", { clientId: "another-tab" }, new AbortController().signal))
            .rejects.toMatchObject({ detail: { code: "invalid_arguments" } });
    });

    it("shares mutation admission, user stop and cancellation between WebMCP and the relay", async () => {
        const { service, stream, clientId } = await activeFixture();
        const execute = vi.spyOn(service, "execute").mockImplementation(() => new Promise(() => { }));
        const abort = new AbortController();
        const local = service.invokeLocal("viewer_navigate", {}, abort.signal);
        const localFailure = expect(local).rejects.toMatchObject({ detail: { code: "cancelled" } });
        await Promise.resolve();
        stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.invoke", version: 1, callId: "relay-busy", action: "viewer_navigate", arguments: {}, timeoutMs: 30000
            }, receivedAt: performance.now()
        });
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({ error: expect.objectContaining({ code: "busy" }) }));
        expect(execute).toHaveBeenCalledTimes(1);
        service.stopCurrentAction();
        await localFailure;
        expect(service.hasPendingAction).toBe(false);
        const second = service.invokeLocal("viewer_navigate", {}, abort.signal);
        const secondFailure = expect(second).rejects.toMatchObject({ detail: { code: "cancelled" } });
        abort.abort();
        await secondFailure;
        expect(service.hasPendingAction).toBe(false);
    });

    it("keeps optional MCP discovery alive during slow map initialization", async () => {
        vi.useFakeTimers();
        const { service, stream } = fixture();
        let resolve!: (value: Response) => void;
        const response = new Promise<Response>(done => { resolve = done; });
        vi.stubGlobal("fetch", vi.fn().mockReturnValue(response));
        try {
            service.initialize();
            await vi.advanceTimersByTimeAsync(6000);
            const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
            expect(signal.aborted).toBe(false);
            resolve(new Response(JSON.stringify({
                enabled: true, endpoint: "http://localhost:8099/mcp",
                authentication: "local", scopes: [], catalogId: VIEWER_ACTION_CATALOG_ID
            })));
            await vi.advanceTimersByTimeAsync(0);
            stream.actionClientId$.next("b3e68f32-3b51-472d-8cab-14b597f7de91");
            expect(stream.sendActionControl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: "mapget.actions.register" }));
        } finally {
            service.ngOnDestroy();
            vi.useRealTimers();
        }
    });

    it("captures the full viewport with bounded image metadata and frozen map canvases", async () => {
        const { service, renderers, views } = fixture();
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1600);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(1000);
        const encoded = { width: 1280, height: 800, toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/2Q==") };
        vi.mocked(domToImage.toCanvas).mockImplementation(async (root, options) => {
            expect(root).toBe(document.body);
            expect(options).toMatchObject({ width: 1600, height: 1000, scale: 0.8, preserveScroll: true });
            expect(options!.filterStyles!(document.body, "--p-primary-color")).toBe(false);
            expect(options!.filterStyles!(document.body, "color")).toBe(true);
            const snapshot = renderers[0].captureCanvas.mock.results[0].value;
            const clone = document.createElement("img");
            clone.style.color = "var(--p-primary-color)";
            options!.adjustClonedNode!(snapshot.canvas, clone, false);
            expect(clone.src).toBe(snapshot.dataUrl);
            expect(clone.hasAttribute("style")).toBe(false);
            return encoded as unknown as HTMLCanvasElement;
        });
        const result = viewerActions.viewer_screenshot.outputSchema.parse(await service.execute("viewer_screenshot", {}));
        expect(renderers.every(renderer => renderer.captureCanvas.mock.calls.length === 1)).toBe(true);
        expect(result.metadata).toMatchObject({
            scope: "application-viewport", width: 1280, height: 800,
            viewportWidth: 1600, viewportHeight: 1000, readiness: { status: "unknown" }
        });
        expect(result.metadata.warnings).toContain("Image downscaled to fit the requested dimensions and transport budget.");
    });

    it("downscales oversized screenshots without changing the relay byte budget", async () => {
        const { service } = fixture();
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        const large = { width: 1280, height: 800, toDataURL: vi.fn(() => "data:image/jpeg;base64," + "A".repeat(240004)) };
        const drawImage = vi.fn();
        const small = { width: 0, height: 0, toDataURL: () => "data:image/jpeg;base64,/9j/2Q==", getContext: () => ({ drawImage }) };
        vi.mocked(domToImage.toCanvas).mockImplementation(async () => {
            vi.spyOn(document, "createElement").mockReturnValue(small as unknown as HTMLCanvasElement);
            return large as unknown as HTMLCanvasElement;
        });
        const result = viewerActions.viewer_screenshot.outputSchema.parse(await service.execute("viewer_screenshot", {}));
        expect(result.metadata).toMatchObject({ width: 960, height: 600 });
        expect(large.toDataURL).toHaveBeenCalledTimes(2);
        expect(drawImage).toHaveBeenCalledWith(large, 0, 0, 960, 600);
    });

    it("rejects stale layouts and missing renderers before DOM capture", async () => {
        const { service, renderers, views } = fixture();
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        renderers[0].isAvailable.mockReturnValue(false);
        await expect(service.execute("viewer_screenshot", {})).rejects.toMatchObject({ detail: { code: "not_available" } });
        expect(domToImage.toCanvas).not.toHaveBeenCalled();
    });

    it.each(["cancel", "resize", "failure"])("releases screenshot admission after %s, never returning a late/stale capture", async reason => {
        const { service } = fixture();
        let width = 1280;
        vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => width);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        let finish!: (canvas: HTMLCanvasElement) => void;
        let fail!: (error: Error) => void;
        vi.mocked(domToImage.toCanvas).mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
        const controller = new AbortController();
        const capture = service.execute("viewer_screenshot", {}, controller.signal);
        await vi.waitFor(() => expect(domToImage.toCanvas).toHaveBeenCalledOnce());
        await expect(service.execute("viewer_screenshot", {})).rejects.toMatchObject({ detail: { code: "busy" } });
        if (reason === "cancel") controller.abort();
        if (reason === "resize") width = 1200;
        if (reason === "failure") fail(new Error("SecurityError"));
        else finish({} as HTMLCanvasElement);
        await expect(capture).rejects.toMatchObject({ detail: { code: reason === "cancel" ? "cancelled" : "not_available" } });
        vi.mocked(domToImage.toCanvas).mockResolvedValue({ width: 128, height: 80, toDataURL: () => "data:image/jpeg;base64,/9j/2Q==" } as unknown as HTMLCanvasElement);
        await expect(service.execute("viewer_screenshot", {})).resolves.toMatchObject({ image: { mimeType: "image/jpeg" } });
    });

    it("bounds concurrent calls, rejects queued mutations and releases slots", async () => {
        const { service, stream, views, clientId } = await activeFixture();
        const send = (callId: string, action = "viewer_get_controls", args: object = {}) => stream.actionControlReceived.next({
            payload: { type: "mapget.actions.invoke", version: 1, callId, action, arguments: args, timeoutMs: 30000 }, receivedAt: performance.now()
        });
        const args = { target: { control: "view.camera", viewId: "view-0" }, value: camera() };
        send("write-1", "viewer_set_control", args);
        send("write-2", "viewer_set_control", args);
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({ callId: "write-2", error: expect.objectContaining({ code: "busy" }) }));
        send("read-1"); send("read-2"); send("read-3"); send("read-4");
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({ callId: "read-4", error: expect.objectContaining({ code: "busy" }) }));
        await Promise.resolve();
        expect(service.hasPendingAction).toBe(false);
        send("write-3", "viewer_set_control", args);
        await Promise.resolve();
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({ callId: "write-3", result: expect.objectContaining({ status: "applied" }) }));
    });

    it.each(["cancel", "stop", "disconnect", "expired"])("%s prevents a pending camera commit", async operation => {
        const { service, state, views, stream } = await activeFixture();
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.invoke", version: 1, callId: "write", action: "viewer_set_control", timeoutMs: 100,
                arguments: { target: { control: "view.camera", viewId: "view-0" }, value: camera() }
            }, receivedAt: performance.now() - (operation === "expired" ? 1000 : 0)
        });
        if (operation === "cancel") stream.actionControlReceived.next({ payload: { type: "mapget.actions.cancel", version: 1, callId: "write", reason: "cancelled" }, receivedAt: performance.now() });
        if (operation === "stop") service.stopCurrentAction();
        if (operation === "disconnect") stream.actionClientId$.next(null);
        await Promise.resolve();
        expect(setter).not.toHaveBeenCalled();
        expect(service.hasPendingAction).toBe(false);
        expect(stream.sendActionControl.mock.calls.length).toBe(operation === "disconnect" ? 0 : 1);
    });

    it.each(["catalog_changed", "authorization_expired"])("handles %s without confusing catalog lifetime with action lifetime", async reason => {
        const { service, state, views, stream, clientId } = await activeFixture();
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        const invoke = (callId: string) => stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.invoke", version: 1, callId, action: "viewer_set_control", timeoutMs: 30000,
                arguments: { target: { control: "view.camera", viewId: "view-0" }, value: camera() }
            }, receivedAt: performance.now()
        });
        invoke("accepted");
        stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.error", version: 1, operation: "register",
                error: { code: "not_available", message: "Registration retired", reason }
            }, receivedAt: performance.now()
        });
        expect(service.availability$.value.ready).toBe(false);
        invoke("after-retirement");
        expect(stream.sendActionControl).toHaveBeenLastCalledWith(clientId, expect.objectContaining({
            callId: "after-retirement", error: expect.objectContaining({ code: "not_available" })
        }));
        await Promise.resolve();
        expect(service.hasPendingAction).toBe(false);
        expect(setter).toHaveBeenCalledTimes(reason === "catalog_changed" ? 1 : 0);
        if (reason === "catalog_changed") {
            expect(service.availability$.value.message).toContain("reload the viewer");
            expect(stream.sendActionControl).toHaveBeenLastCalledWith(clientId, expect.objectContaining({
                callId: "accepted", result: expect.objectContaining({ status: "applied" })
            }));
        }
    });

    it("ignores duplicate invokes and late cancellation without rolling back a completed write", async () => {
        const { service, state, views, stream } = await activeFixture();
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        const message = {
            payload: {
                type: "mapget.actions.invoke", version: 1, callId: "once", action: "viewer_set_control", timeoutMs: 30000,
                arguments: { target: { control: "view.camera", viewId: "view-0" }, value: camera() }
            }, receivedAt: performance.now()
        };
        stream.actionControlReceived.next(message);
        stream.actionControlReceived.next(message);
        await Promise.resolve();
        stream.actionControlReceived.next(message);
        stream.actionControlReceived.next({ payload: { type: "mapget.actions.cancel", version: 1, callId: "once", reason: "late" }, receivedAt: performance.now() });
        service.stopCurrentAction();
        await Promise.resolve();
        expect(setter).toHaveBeenCalledOnce();
        expect(stream.sendActionControl).toHaveBeenCalledOnce();
        expect(stateOwners(state).viewSettings.cameraViewDataState.getValue(0)).toEqual(camera());
    });

    it("does not re-register or replay mutations under a retired UUID", async () => {
        const { service, stream, clientId } = await activeFixture();
        stream.actionClientId$.next(null);
        const nextClientId = "b3e68f32-3b51-472d-8cab-14b597f7de92";
        stream.actionClientId$.next(nextClientId);
        expect(stream.sendActionControl).toHaveBeenLastCalledWith(nextClientId, expect.objectContaining({ type: "mapget.actions.register" }));
        stream.actionControlReceived.next({ payload: { type: "mapget.actions.registered", version: 1, clientId, catalogId: VIEWER_ACTION_CATALOG_ID }, receivedAt: performance.now() });
        expect(service.availability$.value.ready).toBe(false);
    });

    it("keeps activity bounded and excludes arguments/session identity", async () => {
        const { service, stream, clientId } = await activeFixture();
        for (let index = 0; index < 25; ++index) {
            stream.actionControlReceived.next({
                payload: {
                    type: "mapget.actions.invoke", version: 1, callId: `read-${index}`, action: "viewer_get_controls", arguments: { targets: [] }, timeoutMs: 30000
                }, receivedAt: performance.now()
            });
            await Promise.resolve();
        }
        expect(service.activity$.value).toHaveLength(20);
        expect(JSON.stringify(service.activity$.value)).not.toContain(clientId);
        expect(JSON.stringify(service.activity$.value)).not.toContain("targets");
    });

    it("keeps 120 label code points and never sends a split surrogate pair", async () => {
        const { service, stream, clientId } = await activeFixture();
        for (const label of ["😀".repeat(120), "a".repeat(119) + "😀"]) {
            service.renameSession(`  ${label}x  `);
            expect(service.label).toBe(label);
            expect(stream.sendActionControl).toHaveBeenLastCalledWith(clientId, expect.objectContaining({
                type: "mapget.actions.update", label
            }));
        }
        service.renameSession("   ");
        expect(service.label).toBe("erdblick");
    });

    it("reads live camera motion without persisting it", () => {
        const { service, state, renderers } = fixture();
        renderers[0].getLiveCameraState.mockReturnValue(camera(12, 49, 300));
        const previous = structuredClone(stateOwners(state).viewSettings.cameraViewDataState.getValue(0));
        const result = read(service, [{ control: "view.camera", viewId: "view-0" }]);
        expect(result.values[0]).toMatchObject({ value: { destination: { lon: 12, lat: 49, alt: 300 } } });
        expect(stateOwners(state).viewSettings.cameraViewDataState.getValue(0)).toEqual(previous);
    });

    it("keeps hidden, paused and restored search definitions visible", () => {
        const { service, state, searches } = fixture();
        stateOwners(state).searchService.state.featureSearches = [createFeatureSearchStateEntry({
            id: "hidden", query: "**.warningSign", pinColor: "#2477dd", enabled: false, paused: true, showResultsOnMap: false
        })];
        const result = read(service, [{ control: "app.searches" }]);
        expect(result.values).toEqual([{
            target: { control: "app.searches" }, value: [{
                searchId: "hidden", query: "**.warningSign", pinColor: "#2477dd", enabled: false, paused: true, autoUpdate: true, showResultsOnMap: false
            }]
        }]);
        expect(searches.getSession).toHaveBeenCalledWith("hidden");
    });

    it("rejects retired view identities before changing focus or camera", () => {
        const { service, state, views } = fixture();
        const revision = views.viewLayoutRevision;
        stateOwners(state).viewSettings.numViews = 1;
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        expect(() => service.execute("viewer_set_control", {
            target: { control: "view.camera", viewId: "view-1" }, value: camera()
        })).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: "view_unavailable", outcome: "not_applied" }) }));
        expect(setter).not.toHaveBeenCalled();
        expect(stateOwners(state).viewSettings.focusedView).toBe(0);
    });

    it.each([{ sync: [] }, { sync: [VIEW_SYNC_POSITION] }, { sync: [VIEW_SYNC_MOVEMENT] }])("uses owner synchronization for an unfocused target: $sync", ({ sync }) => {
        const { service, state, views, zone } = fixture();
        stateOwners(state).viewSettings.viewSyncState.next(sync);
        const result = viewerActions.viewer_set_control.outputSchema.parse(service.execute("viewer_set_control", {
            target: { control: "view.camera", viewId: "view-1" }, value: camera(21, 52, 700)
        }));
        expect(stateOwners(state).viewSettings.focusedView).toBe(1);
        expect(result.changed).toBe(true);
        expect(result.readiness.status).toBe("unknown");
        expect(stateOwners(state).viewSettings.cameraViewDataState.getValue(1)).toEqual(camera(21, 52, 700));
        expect(stateOwners(state).viewSettings.cameraViewDataState.getValue(0)).toEqual(sync.includes(VIEW_SYNC_POSITION)
            ? camera(21, 52, 700) : sync.includes(VIEW_SYNC_MOVEMENT) ? camera(11, 42, 500) : camera(10, 40, 500));
        expect(zone.run).toHaveBeenCalledOnce();
    });

    it("reports an unchanged camera as a successful no-op", () => {
        const { service, state, views } = fixture();
        const result = service.execute("viewer_set_control", {
            target: { control: "view.camera", viewId: "view-0" }, value: stateOwners(state).viewSettings.cameraViewDataState.getValue(0)
        });
        expect(result).toMatchObject({ status: "applied", changed: false });
    });

    it("does not override a human gesture or first-person view in the sync group", () => {
        const { service, state, views, renderers } = fixture();
        stateOwners(state).viewSettings.viewSyncState.next([VIEW_SYNC_POSITION]);
        const args = { target: { control: "view.camera", viewId: "view-1" }, value: camera() };
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        renderers[0].isCameraInteractionActive.mockReturnValue(true);
        expect(() => service.execute("viewer_set_control", args)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "busy" }) }));
        renderers[0].isCameraInteractionActive.mockReturnValue(false);
        renderers[0].isFirstPersonViewActive.mockReturnValue(true);
        expect(() => service.execute("viewer_set_control", args)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: "first_person" }) }));
        expect(setter).not.toHaveBeenCalled();
        expect(stateOwners(state).viewSettings.focusedView).toBe(0);
    });

    it("does not misreport a first-person map camera as an empty success", () => {
        const { service, renderers } = fixture();
        renderers[0].getLiveCameraState.mockReturnValue(undefined);
        expect(read(service, [{ control: "view.camera", viewId: "view-0" }])).toMatchObject({
            complete: false, values: [{ unavailable: "first_person" }]
        });
    });

    it("rejects 2D tilt and readonly/unexposed writes with no effects", () => {
        const { service, state, views } = fixture();
        stateOwners(state).viewSettings.mode2dState.next(0, true);
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setView");
        for (const target of [{ control: "view.camera", viewId: "view-0" }, { control: "app.searches" }, { control: "__proto__" }]) {
            expect(() => service.execute("viewer_set_control", { target, value: camera() }))
                .toThrow(ViewerActionFailure);
        }
        expect(() => service.execute("constructor", {})).toThrow(ViewerActionFailure);
        expect(setter).not.toHaveBeenCalled();
    });

    it("distinguishes an unavailable target from an empty search collection", () => {
        const { service } = fixture();
        expect(read(service, [{ control: "app.searches" }])).toMatchObject({ complete: true, values: [{ value: [] }] });
        expect(read(service, [{ control: "app.searches", searchId: "missing" }])).toMatchObject({ complete: false, values: [{ unavailable: "target_unavailable" }] });
    });

    it("caps copying and explicitly reports oversized search collections/text", () => {
        const { service, state, searches } = fixture();
        stateOwners(state).searchService.state.featureSearches = Array.from({ length: 120 }, (_, index) => createFeatureSearchStateEntry({
            id: `search-${index}`, query: "x".repeat(5000)
        }));
        const result = read(service, [{ control: "app.searches" }]);
        expect(result.complete).toBe(false);
        expect(result.omissions).toEqual([{ target: { control: "app.searches" }, reason: "text_limit" }]);
        expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(256 * 1024);
        expect(searches.getSession.mock.calls.length).toBeLessThan(100);
    });

    it.each([false, true])("truncates search summaries by code points (over limit=%s)", overLimit => {
        const { service, state } = fixture();
        const prefix = "😀".repeat(4096);
        const query = prefix + (overLimit ? "x" : "");
        stateOwners(state).searchService.state.featureSearches = [createFeatureSearchStateEntry({ id: "unicode", query })];
        const result = read(service, [{ control: "app.searches" }]);
        expect(result.values[0]).toMatchObject({ value: [{ query: prefix }] });
        expect(result.complete).toBe(!overLimit);
        expect(result.omissions).toEqual(overLimit ? [{ target: { control: "app.searches" }, reason: "text_limit" }] : []);
        expect(stateOwners(state).searchService.state.featureSearches[0].query).toBe(query);
    });

    it("describes canonical runtime values, not storage codecs", () => {
        const { service } = fixture();
        const result = viewerActions.viewer_describe_controls.outputSchema.parse(service.execute("viewer_describe_controls", { prefix: "view.camera" }));
        expect(result.controls).toHaveLength(1);
        expect(result.controls[0].valueSchema["properties"]).toHaveProperty("destination");
    });

    it.each([
        ["app.preferences.navigation", { zoomStep: 0.2, featureZoomClearance: 12 }],
        ["app.preferences.inspection", { limit: 8, drillPickRadius: 4, expandByDefault: true, varyColors: false, varyOutlines: true, varyStriping: true }],
        ["app.preferences.hover", { enabled: true, fields: [{ expression: "a.b", customExpression: false, displayKey: "B" }] }],
        ["app.preferences.rendering", { antialiasing: false, semanticCompositing: false, contactShading: false, tileLimit: 1024, renderWorkers: 2 }],
        ["app.marker", { enabled: true, position: { lon: 11, lat: 48, alt: 12 } }],
        ["app.viewSync", ["lay"]]
    ])("round-trips %s through the normal state owner", (control, value) => {
        const { service } = fixture();
        const result = viewerActions.viewer_set_control.outputSchema.parse(service.execute("viewer_set_control", { target: { control }, value }));
        expect(result).toMatchObject({ status: "applied", value, readiness: { status: "unknown" } });
        expect(read(service, [{ control }])).toMatchObject({ complete: true, values: [{ value }] });
        expect(service.execute("viewer_set_control", { target: { control }, value })).toMatchObject({ changed: false });
    });

    it("does not let an invalid control/value pair mutate any preference", () => {
        const { service, state } = fixture();
        const before = stateOwners(state).inspectionState.state.inspectionsLimit;
        expect(() => service.execute("viewer_set_control", { target: { control: "app.preferences.inspection" }, value: "3d" })).toThrow(ViewerActionFailure);
        expect(stateOwners(state).inspectionState.state.inspectionsLimit).toBe(before);
        expect(() => service.execute("viewer_set_control", { target: { control: "app.viewSync" }, value: ["pos", "mov"] })).toThrow(ViewerActionFailure);
        expect(stateOwners(state).viewSettings.viewSync).toEqual([]);
    });

    it("reports each unavailable setting without dropping successful sibling reads", () => {
        const { service } = fixture();
        expect(read(service, [{ control: "view.layer", viewId: "view-0", mapId: "missing", layerId: "missing" },
        { control: "inspection.panel", panelId: 999 }, { control: "app.focusedView" }])).toMatchObject({
            complete: false, values: [
                { unavailable: "target_unavailable" }, { unavailable: "target_unavailable" }, { value: "view-0" }
            ]
        });
    });

    it("validates background identities and discovers metadata without URLs", () => {
        const { service, state } = fixture();
        expect(service.execute("viewer_list_backgrounds", {})).toMatchObject({ complete: true, items: [{ id: "osm", name: "OpenStreetMap", kind: "xyz" }] });
        const previous = stateOwners(state).viewSettings.getBackgroundState(0);
        expect(() => service.execute("viewer_set_control", {
            target: { control: "view.background", viewId: "view-0" },
            value: { layerId: "unknown", opacity: 50 }
        })).toThrow(ViewerActionFailure);
        expect(stateOwners(state).viewSettings.getBackgroundState(0)).toEqual(previous);
    });

    it("pages the default layer catalog and includes advertised levels and feature types", () => {
        const { service, maps } = fixture();
        const layers = new Map(["Road", "Lane", "POI"].map(id => [id, {
            id, type: "Features", viewConfig: [{ visible: true }],
            info: { zoomLevels: [11, 13], featureTypes: [{ name: id }, { name: "ReferenceOnly" }], schemaFeatureTypes: [id], partitionKind: "tile" }
        }]));
        layers.set("Raw", {
            id: "Raw", type: "SourceData", viewConfig: [{ visible: false }],
            info: { zoomLevels: [], featureTypes: [], schemaFeatureTypes: [], partitionKind: "tile" }
        });
        maps.maps.maps.set("map", { id: "map", layers } as never);
        expect(service.execute("viewer_list_layers", { layerType: "SourceData" }))
            .toMatchObject({ complete: true, items: [{ id: "Raw" }] });
        expect(viewerActions.viewer_list_layers.outputSchema.parse(service.execute("viewer_list_layers", { layerType: "all" })).items).toHaveLength(4);
        const first = viewerActions.viewer_list_layers.outputSchema.parse(service.execute("viewer_list_layers", { limit: 2 }));
        expect(first).toMatchObject({
            complete: false, nextOffset: 2,
            items: [{ id: "Road", zoomLevels: [11, 13], featureTypes: ["Road", "ReferenceOnly"], schemaFeatureTypes: ["Road"], partitionKind: "tile" }, { id: "Lane" }]
        });
        expect(service.execute("viewer_list_layers", { offset: first.nextOffset, limit: 2 }))
            .toMatchObject({ complete: true, items: [{ id: "POI" }] });
        expect(service.execute("viewer_list_maps", {}))
            .toMatchObject({ complete: true, items: [{ id: "map", available: true }] });
    });

    it("returns selection provenance without narrowing object partition identities", () => {
        const { service, state, stream } = fixture();
        stateOwners(state).inspectionState.setSelection([{ mapTileKey: "Features:map:layer:object/18446744073709551615", featureId: "Road.1" }]);
        stream.parseMapPartitionKeySafe.mockReturnValue(["map", "layer", { kind: "object", id: "18446744073709551615" }] as never);
        expect(read(service, [{ control: "app.selections" }])).toMatchObject({
            complete: true, values: [{
                value: [{
                    features: [{
                        featureId: "Road.1", mapId: "map", layerId: "layer", partition: { kind: "object", id: "18446744073709551615" }
                    }]
                }]
            }]
        });
    });

    it("returns an option write target for the requested view without exposing internal options", () => {
        const { service, maps } = fixture();
        const option = new StyleOptionNode("map", "Road", {
            id: "labels", label: "Labels", type: "Bool", defaultValue: false, description: "Show labels", internal: false
        }, "style", "s", true);
        option.value = [false, true];
        const internal = new StyleOptionNode("map", "Road", { ...option.info, id: "private", internal: true }, "style", "s", false);
        maps.maps.maps.set("map", { id: "map", layers: new Map([["Road", { id: "Road", mapId: "map", children: [option, internal] }]]) } as never);
        const result = viewerActions.viewer_list_style_options.outputSchema.parse(service.execute("viewer_list_style_options", {
            mapId: "map", layerId: "Road", viewId: "view-1"
        }));
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            id: "labels", value: true, writeTarget: {
                control: "view.styleOption", viewId: "view-1", mapId: "map", layerId: "Road", styleId: "style", optionId: "labels"
            }
        });
        expect(viewerActions.viewer_set_control.inputSchema.safeParse({
            target: result.items[0].writeTarget, value: false
        }).success).toBe(true);
    });

    it("discovers hidden and optionless styles by native layer affinity", () => {
        const { service, maps, styles } = fixture();
        maps.maps.maps.set("map", { id: "map", layers: new Map([["Road", { id: "Road", mapId: "map", children: [] }]]) } as never);
        for (const [id, visible, layerId] of [["optionless", true, "Road"], ["hidden", false, "Road"], ["unrelated", true, "Lane"]] as const) {
            styles.styles.set(id, styleFixture({ id, visible, featureLayerStyle: { hasLayerAffinity: (candidate: string) => candidate === layerId } as never }));
        }
        const result = viewerActions.viewer_list_styles.outputSchema.parse(service.execute("viewer_list_styles", {
            layerId: "Road"
        }));
        expect(result.complete).toBe(true);
        expect(result.items.map(({ id, visible }) => ({ id, visible }))).toEqual([
            { id: "optionless", visible: true }, { id: "hidden", visible: false }
        ]);
        expect(service.execute("viewer_list_styles", { layerId: "Road", styleId: "hidden" }))
            .toMatchObject({ complete: true, items: [{ id: "hidden", visible: false }] });
        for (const tool of ["viewer_list_style_options", "viewer_list_presets"] as const) {
            expect(service.execute(tool, { mapId: "map", layerId: "Road", viewId: "view-0" })).toMatchObject({ items: [] });
        }
        expect(styles.toggleStyle).not.toHaveBeenCalled();
    });

    it("reports the actual dropped targets when the default overview exceeds its bound", () => {
        const { service, state } = fixture();
        stateOwners(state).viewSettings.numViews = 32;
        const result = read(service);
        expect(result.values).toHaveLength(32);
        const omission = result.omissions.find(item => item.omittedCount);
        expect(omission?.omittedCount).toBe(35);
        expect(result.values.some(item => JSON.stringify(item.target) === JSON.stringify(omission?.target))).toBe(false);
        expect(result.complete).toBe(false);
    });

    it("guards focus and view creation/removal with stable identities", () => {
        const { service, state } = fixture();
        expect(service.execute("viewer_set_control", { target: { control: "app.focusedView" }, value: "view-1" })).toMatchObject({ changed: true });
        service.execute("viewer_manage_view", { operation: "remove", viewId: "view-0" });
        expect(stateOwners(state).viewSettings.numViews).toBe(1);
        expect(() => service.execute("viewer_manage_view", { operation: "create", viewId: "view-0" })).toThrow(ViewerActionFailure);
        service.execute("viewer_manage_view", { operation: "create", viewId: "view-1" });
        expect(stateOwners(state).viewSettings.numViews).toBe(2);
        service.execute("viewer_manage_view", { operation: "create", viewId: "view-1" });
        expect(stateOwners(state).viewSettings.numViews).toBe(3);
        stateOwners(state).viewSettings.numViews = 32;
        expect(() => service.execute("viewer_manage_view", { operation: "create", viewId: "view-1" })).toThrow(ViewerActionFailure);
    });

    it.each(["isCameraInteractionActive", "isFirstPersonViewActive"] as const)("honors a synchronized sibling's %s before changing projection or focus", method => {
        const { service, state, views, renderers } = fixture();
        stateOwners(state).viewSettings.viewSyncState.next(["proj"]);
        renderers[0][method].mockReturnValue(true);
        const setter = vi.spyOn(stateOwners(state).viewSettings, "setProjectionMode");
        expect(() => service.execute("viewer_set_control", {
            target: { control: "view.projection", viewId: "view-1" },
            value: "2d"
        })).toThrow(ViewerActionFailure);
        expect(setter).not.toHaveBeenCalled();
        expect(stateOwners(state).viewSettings.focusedView).toBe(0);
    });

    it("opens, updates and closes a real inspection shell without waiting for data", async () => {
        const { service, state, stream } = fixture();
        const feature = { mapTileKey: "Features:map:layer:1", featureId: "Road.1:attribute#2" };
        const result = viewerActions.viewer_inspect.outputSchema.parse(await service.execute("viewer_inspect", { features: [feature], lock: true }));
        expect(result).toMatchObject({ complete: true, features: [feature], panelIds: [0] });
        expect(stateOwners(state).inspectionState.state.selection[0].locked).toBe(true);
        expect(stream.loadFeatures).not.toHaveBeenCalled();
        expect(service.execute("viewer_set_control", {
            target: { control: "inspection.panel", panelId: 0 },
            value: { locked: true, undocked: true, focused: true, color: "#123456" }
        })).toMatchObject({ changed: true });
        expect(read(service, [{ control: "inspection.panel", panelId: 0 }])).toMatchObject({ values: [{ value: { undocked: true, color: "#123456" } }] });
        expect(service.execute("viewer_close_inspection", { panelId: 0 })).toMatchObject({ status: "applied" });
        expect(stateOwners(state).inspectionState.state.selection).toHaveLength(0);
        expect(() => service.execute("viewer_close_inspection", { panelId: 0 })).toThrow(ViewerActionFailure);
    });

    it.each([
        [{ attributeIndex: 0, validityIndex: 0 }, "Road.1:attribute#0:validity#0"],
        [{ attributeIndex: 2 }, "Road.1:attribute#2"],
        [{ relationIndex: 1, validityIndex: 0 }, "Road.1:relation#1:validity#0"]
    ])("formats observed inspection selectors %j without leaking them into the resolved identity", async (selectors, featureId) => {
        const { service, stream } = fixture();
        const feature = { mapTileKey: "Features:map:layer:1", featureId: "Road.1", ...selectors };
        const result = viewerActions.viewer_inspect.outputSchema.parse(await service.execute("viewer_inspect", { features: [feature], newPanel: true }));
        expect(result.features).toEqual([{ mapTileKey: feature.mapTileKey, featureId }]);
        expect(stream.locateFeature).not.toHaveBeenCalled();
    });

    it("rejects ambiguous or incomplete inspection selectors before changing selections", async () => {
        const { service, state, stream } = fixture();
        const feature = { mapTileKey: "Features:map:layer:1", featureId: "Road.1" };
        for (const selectors of [{ validityIndex: 0 }, { attributeIndex: 0, relationIndex: 0 },
        { featureId: "Road.1:attribute#2", attributeIndex: 0 }]) {
            await expect(service.execute("viewer_inspect", { features: [{ ...feature, ...selectors }], newPanel: true })).rejects.toThrow(ViewerActionFailure);
            expect(stateOwners(state).inspectionState.state.selection).toHaveLength(0);
        }
        expect(stream.locateFeature).not.toHaveBeenCalled();
        expect(viewerActions.viewer_inspect.inputSchema.safeParse({ features: [{ ...feature, attributeIndex: -1 }] }).success).toBe(false);
        expect(viewerActions.viewer_inspect.inputSchema.safeParse({ features: [{ ...feature, validityIndex: 0.5 }] }).success).toBe(false);
    });

    it("colors a new inspection group without recoloring an existing overlapping panel", async () => {
        const { service, state } = fixture();
        const feature = { mapTileKey: "Features:map:layer:1", featureId: "Road.1" };
        await service.execute("viewer_inspect", { features: [feature], newPanel: true, color: "#cc3300", lock: true });
        const original = stateOwners(state).inspectionState.state.selection[0];
        const result = await service.execute("viewer_inspect", { features: [feature], newPanel: true, color: "#0033cc" });
        expect(result).toMatchObject({ panelIds: [1], complete: true });
        expect(stateOwners(state).inspectionState.state.selection.find(panel => panel.id === original.id)?.color).toBe("#cc3300");
        expect(stateOwners(state).inspectionState.state.selection.find(panel => panel.id === 1)?.color).toBe("#0033cc");
        await expect(service.execute("viewer_inspect", { features: [feature], color: "#ffffff" })).rejects.toThrow(ViewerActionFailure);
    });

    it("rejects ambiguous locations and preserves attribute suffixes after canonical locate", async () => {
        const { service, stream } = fixture();
        const feature = { mapTileKey: "Features:map:layer:1", featureId: "Road.9" };
        stream.locateFeature.mockResolvedValue([feature, feature]);
        await expect(service.execute("viewer_inspect", { features: [{ mapId: "map", featureId: "Road.1" }] })).rejects.toThrow(ViewerActionFailure);
        stream.locateFeature.mockResolvedValue([feature]);
        expect(await service.execute("viewer_inspect", { features: [{ mapId: "map", featureId: "Road.1:attribute#2:validity#0" }] }))
            .toMatchObject({ features: [{ ...feature, featureId: "Road.9:attribute#2:validity#0" }] });
        expect(await service.execute("viewer_inspect", { features: [{ mapId: "map", featureId: "Road.1", attributeIndex: 2, validityIndex: 0 }] }))
            .toMatchObject({ features: [{ ...feature, featureId: "Road.9:attribute#2:validity#0" }] });
    });

    it("does not overwrite an in-place human selection change while locating", async () => {
        const { service, stream, state, inspections } = fixture();
        let resolve!: (value: Array<{ mapTileKey: string; featureId: string }>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        const action = service.execute("viewer_inspect", { features: [{ mapId: "map", featureId: "Road.1" }] });
        stateOwners(state).inspectionState.setSelection([{ mapTileKey: "Features:map:layer:1", featureId: "Human.1" }]);
        resolve([{ mapTileKey: "Features:map:layer:1", featureId: "Road.1" }]);
        await expect(action).rejects.toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "cancelled" }) }));
        expect(inspections.inspectFeatureIds).not.toHaveBeenCalled();
        expect(stateOwners(state).inspectionState.state.selection[0].features[0].featureId).toBe("Human.1");
    });

    it.each(["cancel", "stop", "disconnect", "timeout"])("%s retires an async locate without a late inspection", async operation => {
        const { service, stream, inspections } = await activeFixture();
        let resolve!: (value: Array<{ mapTileKey: string; featureId: string }>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        stream.actionControlReceived.next({
            payload: {
                type: "mapget.actions.invoke", version: 1, callId: "async", action: "viewer_inspect",
                arguments: { features: [{ mapId: "map", featureId: "Road.1" }] }, timeoutMs: operation === "timeout" ? 10 : 30000
            }, receivedAt: performance.now()
        });
        await Promise.resolve();
        expect(stream.locateFeature).toHaveBeenCalled();
        if (operation === "cancel") stream.actionControlReceived.next({ payload: { type: "mapget.actions.cancel", version: 1, callId: "async", reason: "cancelled" }, receivedAt: performance.now() });
        if (operation === "stop") service.stopCurrentAction();
        if (operation === "disconnect") stream.actionClientId$.next(null);
        if (operation === "timeout") await vi.waitFor(() => expect(service.hasPendingAction).toBe(false));
        resolve([{ mapTileKey: "Features:map:layer:1", featureId: "Road.1" }]);
        await vi.waitFor(() => expect(service.hasPendingAction).toBe(false));
        expect(inspections.inspectFeatureIds).not.toHaveBeenCalled();
        expect(stream.sendActionControl).toHaveBeenCalledTimes(operation === "disconnect" ? 0 : 1);
    });

    it("navigates explicit bounds but cancels a pending fit on a human gesture", async () => {
        const { service, views, stream, inspections, renderers, viewDiagnostics } = fixture();
        const moved = vi.fn();
        views.moveToRectangleTopic.subscribe(moved);
        expect(await service.execute("viewer_navigate", {
            viewId: "view-0",
            target: { bounds: { west: 10, south: 40, east: 11, north: 41 } }
        })).toMatchObject({ status: "applied" });
        expect(moved).toHaveBeenCalledOnce();
        let resolve!: (value: Array<{ mapTileKey: string; featureId: string }>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        const pending = service.execute("viewer_navigate", {
            viewId: "view-1",
            target: { features: [{ mapId: "map", featureId: "Road.1" }] }
        });
        renderers[1].isCameraInteractionActive.mockReturnValue(true);
        viewDiagnostics.cameraInteracting$.next(true);
        resolve([{ mapTileKey: "Features:map:layer:1", featureId: "Road.1" }]);
        await expect(pending).rejects.toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "cancelled" }) }));
        expect(inspections.featureSetZoomTarget).not.toHaveBeenCalled();
        expect(stream.loadFeatures).not.toHaveBeenCalled();
    });

    it("opens a source-data address losslessly through the ordinary panel state", () => {
        const { service, state } = fixture();
        expect(service.execute("viewer_open_source_data", { source: { mapTileKey: "SourceData:map:layer:1", address: "18446744073709551615" } }))
            .toMatchObject({ panelId: 0, status: "applied" });
        expect(stateOwners(state).inspectionState.state.selection[0].sourceData?.address).toBe(18446744073709551615n);
        expect(() => service.execute("viewer_open_source_data", { source: { mapTileKey: "SourceData:map:layer:1", address: "18446744073709551616" } })).toThrow(ViewerActionFailure);
        expect(stateOwners(state).inspectionState.state.selection).toHaveLength(1);
    });

    it("reads bounded search slices, rejects stale runs and delegates lifecycle without touching sibling searches", () => {
        const { service, searches, state, views } = fixture();
        const definition = createFeatureSearchStateEntry({ id: "s", query: "**.warningSign", selectedViewIndices: [0], selectedMapLayers: [] });
        const result = {
            label: "sign", mapId: "m", layerId: "l", featureId: "Road.1", resultIndex: 0, resultKey: "r", mapTileKey: "Features:m:l:1",
            sourceTileKey: "Features:m:l:1", sourceMapId: "m", sourceLayerId: "l", sourceTileId: -2147483648, hoverFeatureId: "Road.1"
        };
        const session = {
            id: "s", definition, runId: "run-1", refresh: 2, complete: true, paused: false,
            schemaAnalysis: readySearchAnalysis(definition.query),
            searchResults: [result, { ...result, resultKey: "r2" }], errors: new Set<string>(), progressDone: 2, progressTotal: 2
        } satisfies Partial<FeatureSearchSession> as FeatureSearchSession;
        searches.getSession.mockReturnValue(session);
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" }))).toMatchObject({ responseComplete: true, searchComplete: true, settings: { scope: "auto" }, status: { resultCount: 2 } });
        searches.getSession.mockReturnValue({ ...session, complete: false } as FeatureSearchSession);
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })))
            .toMatchObject({ responseComplete: true, searchComplete: false, status: { complete: false } });
        searches.getSession.mockReturnValue({
            ...session,
            schemaAnalysis: { ...session.schemaAnalysis, status: "pending" }
        });
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })))
            .toMatchObject({
                responseComplete: true, searchComplete: false,
                schemaAnalysis: { status: "pending" }, status: { complete: false }
            });
        expect(viewerActions.viewer_get_search_results.outputSchema.parse(service.execute("viewer_get_search_results", { searchId: "s" })))
            .toMatchObject({ complete: false, searchComplete: false, reason: "loading" });
        expect(viewerActions.viewer_export_search.outputSchema.parse(service.execute("viewer_export_search", { searchId: "s", include: "results" })))
            .toMatchObject({ complete: false, reason: "loading" });
        stateOwners(state).searchService.state.featureSearches = [definition];
        expect(read(service, [{ control: "app.searches" }])).toMatchObject({ values: [{ value: [{ runtime: { complete: false } }] }] });
        searches.getSession.mockReturnValue({
            ...session,
            schemaAnalysis: {
                ...session.schemaAnalysis, concreteScope: "attribute", normalizedQuery: "$name == 'WARNING_SIGN'",
                rewriteSuppressed: true, rewriteSuppressionReason: "Too many candidate scopes"
            }
        });
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })))
            .toMatchObject({
                schemaAnalysis: {
                    concreteScope: "attribute", normalizedQuery: "$name == 'WARNING_SIGN'",
                    rewriteSuppressed: true, rewriteSuppressionReason: "Too many candidate scopes"
                }
            });
        searches.getSession.mockReturnValue({
            ...session,
            schemaAnalysis: { ...session.schemaAnalysis, status: "error", error: "Schema unavailable" }
        });
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })))
            .toMatchObject({
                schemaAnalysis: { status: "error", error: "Schema unavailable" },
                status: { errors: ["Schema unavailable"] }
            });
        expect(read(service, [{ control: "app.searches" }])).toMatchObject({ values: [{ value: [{ runtime: { errorCount: 1 } }] }] });
        searches.getSession.mockReturnValue({
            ...session,
            schemaAnalysis: { ...session.schemaAnalysis, normalizedQuery: "x".repeat(5000) }
        });
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })))
            .toMatchObject({
                responseComplete: false, reason: "text_limit",
                schemaAnalysis: { normalizedQuery: "x".repeat(4096) }
            });
        searches.getSession.mockReturnValue(session);
        const slice = viewerActions.viewer_get_search_results.outputSchema.parse(service.execute("viewer_get_search_results", { searchId: "s", limit: 1 }));
        expect(slice).toMatchObject({ complete: false, reason: "item_limit", results: [result] });
        expect(() => service.execute("viewer_get_search_results", { searchId: "s", runId: "older" })).toThrow(ViewerActionFailure);
        const exported = viewerActions.viewer_export_search.outputSchema.parse(service.execute("viewer_export_search", { searchId: "s", include: "both", offset: 1 }));
        expect(JSON.parse(exported.content).results.results).toEqual([{ ...result, resultKey: "r2" }]);
        expect(exported.complete).toBe(true);
        for (const operation of ["pause", "stop", "close", "refresh", "rerun"]) service.execute("viewer_control_search", { searchId: "s", operation, ...(operation === "rerun" ? { query: "new" } : {}) });
        expect(searches.pauseSearch).toHaveBeenCalledWith("s");
        expect(searches.stopSearch).toHaveBeenCalledWith("s");
        expect(searches.closeSearch).toHaveBeenCalledWith("s");
        expect(searches.updateSearchInArea).toHaveBeenCalledWith("s");
        expect(searches.rerunSearch).toHaveBeenCalledWith("s", "new");
        expect(service.execute("viewer_control_search", { searchId: "s", operation: "resume" })).toMatchObject({ changed: false });
        session.paused = true;
        service.execute("viewer_control_search", { searchId: "s", operation: "resume" });
        expect(searches.resumeSearch).toHaveBeenCalledWith("s");
        session.definition.enabled = false;
        expect(() => service.execute("viewer_control_search", { searchId: "s", operation: "refresh" })).toThrow(ViewerActionFailure);
        stateOwners(state).searchService.state.featureSearches = [definition];
        const settings = viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", { searchId: "s" })).settings;
        expect(service.execute("viewer_set_search", { searchId: "s", settings: { ...settings, showResultsOnMap: false } }))
            .toMatchObject({ changed: true });
        expect(stateOwners(state).searchService.state.featureSearches[0].showResultsOnMap).toBe(false);
    });

    it("patches search presentation without replacing omitted settings or automatic layer selection", () => {
        const { service, searches, state, views } = fixture();
        const definition = createFeatureSearchStateEntry({ id: "patch", query: "true", bookmarked: true });
        const sibling = createFeatureSearchStateEntry({ id: "sibling", query: "false" });
        const searchResults: FeatureSearchSession["searchResults"] = [];
        const session = {
            id: definition.id, definition, runId: "run", refresh: 0, complete: false,
            schemaAnalysis: readySearchAnalysis(definition.query),
            paused: false, searchResults, errors: new Set<string>(), progressDone: 0,
            progressTotal: 1
        } satisfies Partial<FeatureSearchSession> as FeatureSearchSession;
        searches.getSession.mockReturnValue(session);
        stateOwners(state).searchService.state.featureSearches = [definition, sibling];
        const settings = { autoUpdate: false, renderStrategy: { showHighFiGeometry: true, showLowFiDots: false } };
        service.execute("viewer_set_search", { searchId: definition.id, settings });
        expect(stateOwners(state).searchService.state.featureSearches[0]).toEqual({
            ...definition, autoUpdate: false,
            renderStrategy: { ...definition.renderStrategy, ...settings.renderStrategy }
        });
        expect(stateOwners(state).searchService.state.featureSearches[1]).toEqual(sibling);
        expect(() => service.execute("viewer_set_search", {
            searchId: definition.id,
            settings: { renderStrategy: { highFidelityMaxVisibleTiles: 0 } }
        }))
            .toThrow(ViewerActionFailure);
    });

    it("returns the current page URL and identifies local style dependencies", () => {
        const { service, state, styles } = fixture();
        styles.styles.set("draft", styleFixture({ id: "draft", source: "name: draft", imported: true, modified: false, visible: true }));
        styles.styles.set("stock", styleFixture({ id: "stock", source: "name: stock", imported: false, modified: false, visible: true }));
        const search = stateOwners(state).searchService.state.addFeatureSearch({ query: "typeId == 'Road'", enabled: true, showResultsOnMap: true });
        stateOwners(state).searchService.state.addFeatureSearch({ query: "hidden", enabled: false });
        const previous = window.location.href;
        const result = viewerActions.viewer_get_share_link.outputSchema.parse(service.execute("viewer_get_share_link", {}));
        expect(result.url).toBe(window.location.href);
        expect(result.localStyleIds).toEqual(["draft"]);
        expect(result.localSearchIds).toEqual([search.id]);
        expect(result.complete).toBe(true);
        expect(window.location.href).toBe(previous);
    });

    it("copies deployment query parameters and fragments without rebuilding URL-backed state", () => {
        const previous = window.location.href;
        try {
            window.history.replaceState({}, "", "/viewer/nested/?external=keep&external=also-keep#inspection");
            const { service, state } = fixture();
            const serialize = vi.spyOn(stateOwners(state).url, "serialize");
            const address = window.location.href;

            const result = viewerActions.viewer_get_share_link.outputSchema.parse(
                service.execute("viewer_get_share_link", {})
            );

            expect(result.url).toBe(address);
            expect(window.location.href).toBe(address);
            expect(serialize).not.toHaveBeenCalled();
        } finally {
            window.history.replaceState({}, "", previous);
        }
    });

    it("validates style drafts and delegates browser-local lifecycle operations without server writes", () => {
        const { service, styles } = fixture();
        styles.styles.set("style", styleFixture({ id: "style", source: "name: style", imported: false, modified: true, visible: true }));
        expect(service.execute("viewer_get_style", { styleId: "style" })).toMatchObject({ source: "name: style", modified: true });
        expect(service.execute("viewer_validate_style", { source: "name: draft" })).toMatchObject({ valid: true, runtimeVerified: false, issues: [], complete: true });
        expect(service.execute("viewer_edit_style", { operation: "create", source: "name: new-style", visible: false })).toMatchObject({ styleId: "new-style" });
        expect(styles.importStyleYamlSource).toHaveBeenCalledWith("name: new-style", false);
        service.execute("viewer_edit_style", { operation: "update", styleId: "style", source: "name: style" });
        expect(styles.setStyleSource).toHaveBeenCalledWith("style", "name: style");
        service.execute("viewer_edit_style", { operation: "reset", styleId: "style" });
        expect(styles.resetModifiedBuiltinStyle).toHaveBeenCalledWith("style");
        service.execute("viewer_edit_style", { operation: "visibility", styleId: "style", visible: false });
        expect(styles.toggleStyle).toHaveBeenCalledWith("style", false, true);
        expect(() => service.execute("viewer_edit_style", { operation: "delete", styleId: "style" })).toThrow(ViewerActionFailure);
        expect(styles.deleteStyle).not.toHaveBeenCalled();
        styles.styles.get("style")!.imported = true;
        service.execute("viewer_edit_style", { operation: "delete", styleId: "style" });
        expect(styles.deleteStyle).toHaveBeenCalledWith("style", true);
    });

    it("patches exact style fragments atomically while preserving surrounding YAML", () => {
        const { service, styles } = fixture();
        const source = "# Keep this comment\nname: style\nrules:\n  - color: red\n    width: 2\n  - color: red\n    width: 4\n";
        styles.styles.set("style", styleFixture({ id: "style", source, imported: false, modified: false, visible: true }));
        const patch = (edits: Array<{ find: string; replace: string }>) => service.execute("viewer_edit_style", { operation: "patch", styleId: "style", edits });
        expect(patch([{ find: "color: red\n    width: 2", replace: "color: blue\n    width: 3" }]))
            .toMatchObject({ status: "applied", styleId: "style", changed: true, editCount: 1 });
        expect(styles.setStyleSource).toHaveBeenCalledWith("style", source.replace("color: red\n    width: 2", "color: blue\n    width: 3"));
        styles.setStyleSource.mockClear();
        expect(() => patch([{ find: "color: red", replace: "color: green" }])).toThrow(/matches more than once/);
        expect(() => patch([{ find: "width: 2", replace: "width: 3" }, { find: "missing", replace: "value" }])).toThrow(/no exact match/);
        expect(styles.setStyleSource).not.toHaveBeenCalled();
        expect(patch([{ find: "width: 2", replace: "width: 2" }])).toMatchObject({ changed: false });
        expect(styles.setStyleSource).not.toHaveBeenCalled();
        expect(() => patch([{ find: "", replace: "value" }])).toThrow(ViewerActionFailure);
        expect(() => service.execute("viewer_edit_style", { operation: "update", styleId: "style", source, edits: [{ find: "a", replace: "b" }] }))
            .toThrow(/other operations do not accept edits/);
        styles.validateStyleSource.mockReturnValue({ valid: false, loadable: false, issues: [] });
        expect(() => patch([{ find: "width: 2", replace: "width: broken" }])).toThrow(/no changes were applied/);
        expect(styles.setStyleSource).not.toHaveBeenCalled();
    });

    it("returns candidate validation errors for rejected patches without installing a partial edit", () => {
        const { service, styles } = fixture();
        const source = "name: style\nrules:\n  - width: 2\n";
        styles.styles.set("style", styleFixture({ id: "style", source, imported: false, modified: false, visible: true }));
        styles.validateStyleSource.mockReturnValue({
            valid: false, loadable: false, issues: [
                { id: "warning", at: 0, impact: "property-fallback", source: { sourceKind: "editor" }, severity: "warning", message: "Earlier warning", phase: "yaml" },
                { id: "width", at: 0, impact: "stylesheet-failed", source: { sourceKind: "editor" }, severity: "error", message: "Expected numeric width", phase: "schema", rulePath: "rules[0]", property: "width", location: { line: 3, column: 5 } }
            ]
        });
        let failure: ViewerActionFailure | undefined;
        try {
            service.execute("viewer_edit_style", { operation: "patch", styleId: "style", edits: [{ find: "width: 2", replace: "width: broken" }] });
        } catch (error) { if (error instanceof ViewerActionFailure) failure = error; else throw error; }
        expect(failure?.detail).toMatchObject({ code: "invalid_arguments", reason: "style_validation_failed", outcome: "not_applied" });
        expect(failure?.message).toContain("Expected numeric width");
        expect(failure?.message).toContain('"property":"width"');
        expect(failure?.message).toContain('"line":3');
        expect(failure?.message).not.toContain("Earlier warning");
        expect(styles.setStyleSource).not.toHaveBeenCalled();
        expect(styles.styles.get("style")!.source).toBe(source);
    });

    it("bounds style rejection details within the relay error message budget", () => {
        const { service, styles } = fixture();
        styles.validateStyleSource.mockReturnValue({
            valid: false, loadable: false, issues: Array.from({ length: 8 }, () =>
                ({ id: "long", at: 0, impact: "stylesheet-failed", source: { sourceKind: "editor" }, severity: "error", message: "💥".repeat(5000), phase: "schema", rulePath: "rules[0]" }))
        });
        let failure: ViewerActionFailure | undefined;
        try { service.execute("viewer_edit_style", { operation: "create", source: "name: invalid" }); }
        catch (error) { if (error instanceof ViewerActionFailure) failure = error; else throw error; }
        expect(failure?.detail.reason).toBe("style_validation_failed");
        expect(Array.from(failure!.message).length).toBeLessThanOrEqual(4096);
        expect(styles.importStyleYamlSource).not.toHaveBeenCalled();
    });

    it("preserves the failing style expression and property in bounded diagnostics", () => {
        const { service, styleReports } = fixture();
        styleReports.reports$.next([{
            id: "projection-test", at: 0, severity: "warning", phase: "runtime",
            impact: "property-fallback", source: { styleName: "Lane labels", sourceKind: "editor" },
            message: "Style expression returned multiple values; expected at most one.",
            property: "projection", expression: "id", rulePath: "rules[0]",
            runtimeContext: { mapName: "Map", layerName: "Road", featureId: "Road.1" }
        }]);
        const result = viewerActions.viewer_get_diagnostics.outputSchema.parse(
            service.execute("viewer_get_diagnostics", { sections: ["errors"] }));
        expect(result.errors).toEqual([expect.objectContaining({
            source: "Lane labels", property: "projection", expression: "id", rulePath: "rules[0]",
            severity: "warning", phase: "runtime", mapId: "Map", layerId: "Road", featureId: "Road.1"
        })]);
    });

    it("samples diagnostic counters/caches without scene traversal or treating missing GPU data as zero", () => {
        const { service, render, viewDiagnostics } = fixture();
        const result = viewerActions.viewer_get_diagnostics.outputSchema.parse(service.execute("viewer_get_diagnostics", { viewId: "view-0" }));
        expect(result).toMatchObject({ complete: true, errors: [] });
        expect(result.executionContext).toBe("browser");
        expect(result.interpretation).toContain("Backend queues, CPU and memory were not sampled");
        expect(result.metrics).toContainEqual(expect.objectContaining({ name: "latestWasmMs", value: 12 }));
        expect(result.metrics.some(metric => metric.name === "latestNativeMs")).toBe(false);
        expect(result.metrics).toContainEqual(expect.objectContaining({ name: "queued", value: 3 }));
        expect(result.metrics).toContainEqual(expect.objectContaining({ name: "frameIntervalP90Ms", value: null, scope: "view", viewId: "view-0" }));
        expect(result.unavailable.join(" ")).toContain("Scoped GPU allocation is unavailable");
        expect(render.debugSnapshot).not.toHaveBeenCalled();
        expect(viewDiagnostics.snapshot).not.toHaveBeenCalled();
    });
});
