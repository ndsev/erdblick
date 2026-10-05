import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {BehaviorSubject, Subject} from "rxjs";
import {AppStateService, type CameraViewState, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../shared/appstate.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {createFeatureSearchStateEntry} from "../shared/feature-search-state";
import {ViewerActionService} from "./viewer-action.service";
import {ViewerActionFailure} from "./viewer-action-relay.contract";
import {ViewerUiService} from "./viewer-ui.service";
import {viewerActions, type ViewerActionOutput} from "./viewer-action.contract";
import {VIEWER_ACTION_CATALOG_ID} from "./generated/catalog-id";
import {type FeatureSearchSession} from "../search/feature.search.service";
import domToImage from "dom-to-image-more";

vi.mock("dom-to-image-more", () => ({default: {toCanvas: vi.fn()}}));

/** Builds real state/sync owners, with inert renderers and no tile/schema/scene access. */
function setup() {
    const state = new AppStateService({
        events: new Subject(), routerState: {snapshot: {root: {queryParams: {}}}}, navigate: vi.fn()
    } as never, {showError: vi.fn()} as never);
    const maps = {
        layerStateChanged: new Subject<string>(), reapplySyncOptionsForAllViews: vi.fn(),
        maps: {maps: new Map()}
    };
    state.numViews = 2;
    state.viewSyncState.next([]);
    state.cameraViewDataState.next(0, camera(10, 40, 500));
    state.cameraViewDataState.next(1, camera(20, 50, 1000));
    const views = new MapViewStateService(state, maps as never);
    const renderers = [0, 1].map(viewIndex => ({
        viewIndex, isAvailable: vi.fn(() => true),
        getLiveCameraState: vi.fn((): CameraViewState | undefined => structuredClone(state.cameraViewDataState.getValue(viewIndex))),
        isFirstPersonViewActive: vi.fn(() => false), isCameraInteractionActive: vi.fn(() => false), rendererInvalidated: new Subject<void>(),
        captureCanvas: vi.fn(() => ({canvas: document.createElement("canvas"), dataUrl: "data:image/png;base64,AAAA"}))
    }));
    renderers.forEach(renderer => views.registerRenderView(renderer as never));
    const searches = {getSession: vi.fn<() => FeatureSearchSession | undefined>(() => undefined), getSessions: vi.fn(() => []),
        run: vi.fn(() => ({id: "search"})), pauseSearch: vi.fn(), resumeSearch: vi.fn(), stopSearch: vi.fn(), closeSearch: vi.fn(),
        rerunSearch: vi.fn(), updateSearchInArea: vi.fn()};
    const inspections = {selectionTopic: {getValue: () => []}, inspectFeatureIds: vi.fn((features, lock) => {
        const panelId = state.setSelection(features);
        if (lock && panelId !== undefined) state.setInspectionPanelLockedState(panelId, true);
    }), featureSetZoomTarget: vi.fn(() => ({x: 10, y: 40, z: 500}))};
    const zone = {run: vi.fn((callback: () => unknown) => callback()), runOutsideAngular: (callback: () => unknown) => callback()};
    const stream = {
        actionClientId$: new BehaviorSubject<string | null>(null),
        actionControlReceived: new Subject<{payload: unknown; receivedAt: number}>(),
        sendActionControl: vi.fn(() => true),
        parseMapPartitionKeySafe: vi.fn((key: string) => key.startsWith("Features:") || key.startsWith("SourceData:") ? ["map", "layer", {kind: "tile", id: 1}] : null),
        locateFeature: vi.fn<() => Promise<Array<{mapTileKey: string; featureId: string}>>>(() => Promise.resolve([])),
        loadFeatures: vi.fn(() => Promise.resolve([])), isTileStreamConnected: vi.fn(() => true), tilePipelinePaused: false,
        getPendingFrameQueueSize: vi.fn(() => 0), getDownstreamBytesPerSecond: vi.fn(() => 100), getTileStreamTransportCompressionStats: vi.fn(() => ({}))
    };
    const styles = {styles: new Map(), validateStyleSource: vi.fn(() => ({valid: true, loadable: true, issues: []})),
        createEditorSourceRef: vi.fn(), importStyleYamlSource: vi.fn(() => "new-style"), setStyleSource: vi.fn(() => "style"),
        resetModifiedBuiltinStyle: vi.fn(() => "style"), deleteStyle: vi.fn(), toggleStyle: vi.fn()};
    const config = {getBackgroundLayers: () => [{id: "osm", name: "OSM", type: "xyz", url: "never exposed"}]};
    const render = {queueSummary: vi.fn(() => ({queued: 3})), currentFrameTimeMs: vi.fn(() => 0), debugSnapshot: vi.fn()};
    const diagnostics = {snapshot$: new BehaviorSubject({at: Date.now(), tiles: {expected: 3, loaded: 2, errors: 1}, progress: {rendered: {done: 1, total: 2}}}), perfStats$: new BehaviorSubject([])};
    const viewDiagnostics = {cameraInteracting$: new BehaviorSubject(false), snapshot: vi.fn()};
    const styleReports = {reports$: new BehaviorSubject([])};
    const service = new ViewerActionService(state, views, maps as never, searches as never, inspections as never, zone as never, stream as never,
        styles as never, config as never, render as never, diagnostics as never, viewDiagnostics as never, styleReports as never, new ViewerUiService());
    return {state, views, maps, renderers, searches, inspections, zone, service, stream, styles, config, render, diagnostics, viewDiagnostics, styleReports};
}

/** Uses a representable oblique camera so persisted decimal rounding is not a projection boundary. */
function camera(lon = 11, lat = 48, alt = 500): CameraViewState {
    return {destination: {lon, lat, alt}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
}

/** Calls the generic action boundary and validates its typed response. */
function read(service: ViewerActionService, targets?: unknown[]): ViewerActionOutput<"viewer_get_app_state"> {
    return viewerActions.viewer_get_app_state.outputSchema.parse(service.execute("viewer_get_app_state", targets ? {targets} : {}));
}

describe("ViewerActionService", () => {
    const cleanups: AppStateService[] = [];
    const actionCleanups: ViewerActionService[] = [];
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
        await vi.waitFor(() => expect(result.stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({type: "mapget.actions.register"})));
        result.stream.actionControlReceived.next({payload: {
            type: "mapget.actions.registered", version: 1, clientId, catalogId: VIEWER_ACTION_CATALOG_ID
        }, receivedAt: performance.now()});
        expect(result.service.availability$.value.ready).toBe(true);
        result.stream.sendActionControl.mockClear();
        return {...result, clientId};
    }

    it("captures the full viewport with bounded image metadata and frozen map canvases", async () => {
        const {service, renderers, views} = fixture();
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1600);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(1000);
        const encoded = {width: 1280, height: 800, toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/2Q==")};
        vi.mocked(domToImage.toCanvas).mockImplementation(async (root, options) => {
            expect(root).toBe(document.body);
            expect(options).toMatchObject({width: 1600, height: 1000, scale: 0.8, preserveScroll: true});
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
        expect(result.metadata).toMatchObject({scope: "application-viewport", width: 1280, height: 800,
            viewportWidth: 1600, viewportHeight: 1000, viewLayoutRevision: views.viewLayoutRevision, readiness: {status: "unknown"}});
        expect(result.metadata.warnings).toContain("Image downscaled to fit the requested dimensions and transport budget.");
    });

    it("downscales oversized screenshots without changing the relay byte budget", async () => {
        const {service} = fixture();
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        const large = {width: 1280, height: 800, toDataURL: vi.fn(() => "data:image/jpeg;base64," + "A".repeat(240004))};
        const drawImage = vi.fn();
        const small = {width: 0, height: 0, toDataURL: () => "data:image/jpeg;base64,/9j/2Q==", getContext: () => ({drawImage})};
        vi.mocked(domToImage.toCanvas).mockImplementation(async () => {
            vi.spyOn(document, "createElement").mockReturnValue(small as unknown as HTMLCanvasElement);
            return large as unknown as HTMLCanvasElement;
        });
        const result = viewerActions.viewer_screenshot.outputSchema.parse(await service.execute("viewer_screenshot", {}));
        expect(result.metadata).toMatchObject({width: 960, height: 600});
        expect(large.toDataURL).toHaveBeenCalledTimes(2);
        expect(drawImage).toHaveBeenCalledWith(large, 0, 0, 960, 600);
    });

    it("rejects stale layouts and missing renderers before DOM capture", async () => {
        const {service, renderers, views} = fixture();
        await expect(service.execute("viewer_screenshot", {viewLayoutRevision: views.viewLayoutRevision + 1}))
            .rejects.toMatchObject({detail: {reason: "stale_view_layout"}});
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        renderers[0].isAvailable.mockReturnValue(false);
        await expect(service.execute("viewer_screenshot", {})).rejects.toMatchObject({detail: {code: "not_available"}});
        expect(domToImage.toCanvas).not.toHaveBeenCalled();
    });

    it.each(["cancel", "resize", "failure"])("releases screenshot admission after %s, never returning a late/stale capture", async reason => {
        const {service} = fixture();
        let width = 1280;
        vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => width);
        vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
        let finish!: (canvas: HTMLCanvasElement) => void;
        let fail!: (error: Error) => void;
        vi.mocked(domToImage.toCanvas).mockImplementation(() => new Promise((resolve, reject) => {finish = resolve; fail = reject;}));
        const controller = new AbortController();
        const capture = service.execute("viewer_screenshot", {}, controller.signal);
        await vi.waitFor(() => expect(domToImage.toCanvas).toHaveBeenCalledOnce());
        await expect(service.execute("viewer_screenshot", {})).rejects.toMatchObject({detail: {code: "busy"}});
        if (reason === "cancel") controller.abort();
        if (reason === "resize") width = 1200;
        if (reason === "failure") fail(new Error("SecurityError"));
        else finish({} as HTMLCanvasElement);
        await expect(capture).rejects.toMatchObject({detail: {code: reason === "cancel" ? "cancelled" : "not_available"}});
        vi.mocked(domToImage.toCanvas).mockResolvedValue({width: 128, height: 80, toDataURL: () => "data:image/jpeg;base64,/9j/2Q=="} as unknown as HTMLCanvasElement);
        await expect(service.execute("viewer_screenshot", {})).resolves.toMatchObject({image: {mimeType: "image/jpeg"}});
    });

    it("bounds concurrent calls, rejects queued mutations and releases slots", async () => {
        const {service, stream, views, clientId} = await activeFixture();
        const send = (callId: string, action = "viewer_get_app_state", args: object = {}) => stream.actionControlReceived.next({
            payload: {type: "mapget.actions.invoke", version: 1, callId, action, arguments: args, timeoutMs: 30000}, receivedAt: performance.now()
        });
        const args = {target: {channel: "view.camera", viewIndex: 0}, value: camera(), viewLayoutRevision: views.viewLayoutRevision};
        send("write-1", "viewer_set_app_state", args);
        send("write-2", "viewer_set_app_state", args);
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({callId: "write-2", error: expect.objectContaining({code: "busy"})}));
        send("read-1"); send("read-2"); send("read-3"); send("read-4");
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({callId: "read-4", error: expect.objectContaining({code: "busy"})}));
        await Promise.resolve();
        expect(service.hasPendingAction).toBe(false);
        send("write-3", "viewer_set_app_state", args);
        await Promise.resolve();
        expect(stream.sendActionControl).toHaveBeenCalledWith(clientId, expect.objectContaining({callId: "write-3", result: expect.objectContaining({status: "applied"})}));
    });

    it.each(["cancel", "stop", "disconnect", "expired"])("%s prevents a pending camera commit", async operation => {
        const {service, state, views, stream} = await activeFixture();
        const setter = vi.spyOn(state, "setView");
        stream.actionControlReceived.next({payload: {
            type: "mapget.actions.invoke", version: 1, callId: "write", action: "viewer_set_app_state", timeoutMs: 100,
            arguments: {target: {channel: "view.camera", viewIndex: 0}, value: camera(), viewLayoutRevision: views.viewLayoutRevision}
        }, receivedAt: performance.now() - (operation === "expired" ? 1000 : 0)});
        if (operation === "cancel") stream.actionControlReceived.next({payload: {type: "mapget.actions.cancel", version: 1, callId: "write", reason: "cancelled"}, receivedAt: performance.now()});
        if (operation === "stop") service.stopCurrentAction();
        if (operation === "disconnect") stream.actionClientId$.next(null);
        await Promise.resolve();
        expect(setter).not.toHaveBeenCalled();
        expect(service.hasPendingAction).toBe(false);
        expect(stream.sendActionControl.mock.calls.length).toBe(operation === "disconnect" ? 0 : 1);
    });

    it.each(["catalog_changed", "authorization_expired"])("handles %s without confusing catalog lifetime with action lifetime", async reason => {
        const {service, state, views, stream, clientId} = await activeFixture();
        const setter = vi.spyOn(state, "setView");
        const invoke = (callId: string) => stream.actionControlReceived.next({payload: {
            type: "mapget.actions.invoke", version: 1, callId, action: "viewer_set_app_state", timeoutMs: 30000,
            arguments: {target: {channel: "view.camera", viewIndex: 0}, value: camera(), viewLayoutRevision: views.viewLayoutRevision}
        }, receivedAt: performance.now()});
        invoke("accepted");
        stream.actionControlReceived.next({payload: {
            type: "mapget.actions.error", version: 1, operation: "register",
            error: {code: "not_available", message: "Registration retired", reason}
        }, receivedAt: performance.now()});
        expect(service.availability$.value.ready).toBe(false);
        invoke("after-retirement");
        expect(stream.sendActionControl).toHaveBeenLastCalledWith(clientId, expect.objectContaining({
            callId: "after-retirement", error: expect.objectContaining({code: "not_available"})
        }));
        await Promise.resolve();
        expect(service.hasPendingAction).toBe(false);
        expect(setter).toHaveBeenCalledTimes(reason === "catalog_changed" ? 1 : 0);
        if (reason === "catalog_changed") {
            expect(service.availability$.value.message).toContain("reload the viewer");
            expect(stream.sendActionControl).toHaveBeenLastCalledWith(clientId, expect.objectContaining({
                callId: "accepted", result: expect.objectContaining({status: "applied"})
            }));
        }
    });

    it("ignores duplicate invokes and late cancellation without rolling back a completed write", async () => {
        const {service, state, views, stream} = await activeFixture();
        const setter = vi.spyOn(state, "setView");
        const message = {payload: {
            type: "mapget.actions.invoke", version: 1, callId: "once", action: "viewer_set_app_state", timeoutMs: 30000,
            arguments: {target: {channel: "view.camera", viewIndex: 0}, value: camera(), viewLayoutRevision: views.viewLayoutRevision}
        }, receivedAt: performance.now()};
        stream.actionControlReceived.next(message);
        stream.actionControlReceived.next(message);
        await Promise.resolve();
        stream.actionControlReceived.next(message);
        stream.actionControlReceived.next({payload: {type: "mapget.actions.cancel", version: 1, callId: "once", reason: "late"}, receivedAt: performance.now()});
        service.stopCurrentAction();
        await Promise.resolve();
        expect(setter).toHaveBeenCalledOnce();
        expect(stream.sendActionControl).toHaveBeenCalledOnce();
        expect(state.cameraViewDataState.getValue(0)).toEqual(camera());
    });

    it("does not re-register or replay mutations under a retired UUID", async () => {
        const {service, stream, clientId} = await activeFixture();
        stream.actionClientId$.next(null);
        const nextClientId = "b3e68f32-3b51-472d-8cab-14b597f7de92";
        stream.actionClientId$.next(nextClientId);
        expect(stream.sendActionControl).toHaveBeenLastCalledWith(nextClientId, expect.objectContaining({type: "mapget.actions.register"}));
        stream.actionControlReceived.next({payload: {type: "mapget.actions.registered", version: 1, clientId, catalogId: VIEWER_ACTION_CATALOG_ID}, receivedAt: performance.now()});
        expect(service.availability$.value.ready).toBe(false);
    });

    it("keeps activity bounded and excludes arguments/session identity", async () => {
        const {service, stream, clientId} = await activeFixture();
        for (let index = 0; index < 25; ++index) {
            stream.actionControlReceived.next({payload: {
                type: "mapget.actions.invoke", version: 1, callId: `read-${index}`, action: "viewer_get_app_state", arguments: {targets: []}, timeoutMs: 30000
            }, receivedAt: performance.now()});
            await Promise.resolve();
        }
        expect(service.activity$.value).toHaveLength(20);
        expect(JSON.stringify(service.activity$.value)).not.toContain(clientId);
        expect(JSON.stringify(service.activity$.value)).not.toContain("targets");
    });

    it("keeps 120 label code points and never sends a split surrogate pair", async () => {
        const {service, stream, clientId} = await activeFixture();
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
        const {service, state, renderers} = fixture();
        renderers[0].getLiveCameraState.mockReturnValue(camera(12, 49, 300));
        const previous = structuredClone(state.cameraViewDataState.getValue(0));
        const result = read(service, [{channel: "view.camera", viewIndex: 0}]);
        expect(result.values[0]).toMatchObject({value: {destination: {lon: 12, lat: 49, alt: 300}}});
        expect(state.cameraViewDataState.getValue(0)).toEqual(previous);
    });

    it("keeps hidden, paused and restored search definitions visible", () => {
        const {service, state, searches} = fixture();
        state.featureSearchState.next([createFeatureSearchStateEntry({
            id: "hidden", query: "**.warningSign", enabled: false, paused: true, showResultsOnMap: false
        })]);
        const result = read(service, [{channel: "app.searches"}]);
        expect(result.values).toEqual([{target: {channel: "app.searches"}, value: [{
            searchId: "hidden", query: "**.warningSign", enabled: false, paused: true, autoUpdate: true, showResultsOnMap: false
        }]}]);
        expect(searches.getSession).toHaveBeenCalledWith("hidden");
    });

    it("rejects stale view indices before changing focus or camera", () => {
        const {service, state, views} = fixture();
        const revision = views.viewLayoutRevision;
        state.numViews = 1;
        const setter = vi.spyOn(state, "setView");
        expect(() => service.execute("viewer_set_app_state", {
            target: {channel: "view.camera", viewIndex: 0}, value: camera(), viewLayoutRevision: revision
        })).toThrow(expect.objectContaining({detail: expect.objectContaining({reason: "stale_view_layout", outcome: "not_applied"})}));
        expect(setter).not.toHaveBeenCalled();
        expect(state.focusedView).toBe(0);
    });

    it.each([{sync: []}, {sync: [VIEW_SYNC_POSITION]}, {sync: [VIEW_SYNC_MOVEMENT]}])("uses owner synchronization for an unfocused target: $sync", ({sync}) => {
        const {service, state, views, zone} = fixture();
        state.viewSyncState.next(sync);
        const result = viewerActions.viewer_set_app_state.outputSchema.parse(service.execute("viewer_set_app_state", {
            target: {channel: "view.camera", viewIndex: 1}, value: camera(21, 52, 700), viewLayoutRevision: views.viewLayoutRevision
        }));
        expect(state.focusedView).toBe(1);
        expect(result.focusedView).toBe(1);
        expect(result.changed).toBe(true);
        expect(result.affectedViews).toEqual(sync.length ? [0, 1] : [1]);
        expect(result.readiness.status).toBe("unknown");
        expect(state.cameraViewDataState.getValue(1)).toEqual(camera(21, 52, 700));
        expect(state.cameraViewDataState.getValue(0)).toEqual(sync.includes(VIEW_SYNC_POSITION)
            ? camera(21, 52, 700) : sync.includes(VIEW_SYNC_MOVEMENT) ? camera(11, 42, 500) : camera(10, 40, 500));
        expect(zone.run).toHaveBeenCalledOnce();
    });

    it("reports an unchanged camera as a successful no-op", () => {
        const {service, state, views} = fixture();
        const result = service.execute("viewer_set_app_state", {
            target: {channel: "view.camera", viewIndex: 0}, value: state.cameraViewDataState.getValue(0),
            viewLayoutRevision: views.viewLayoutRevision
        });
        expect(result).toMatchObject({status: "applied", changed: false});
    });

    it("does not override a human gesture or first-person view in the sync group", () => {
        const {service, state, views, renderers} = fixture();
        state.viewSyncState.next([VIEW_SYNC_POSITION]);
        const args = {target: {channel: "view.camera", viewIndex: 1}, value: camera(), viewLayoutRevision: views.viewLayoutRevision};
        const setter = vi.spyOn(state, "setView");
        renderers[0].isCameraInteractionActive.mockReturnValue(true);
        expect(() => service.execute("viewer_set_app_state", args)).toThrow(expect.objectContaining({detail: expect.objectContaining({code: "busy"})}));
        renderers[0].isCameraInteractionActive.mockReturnValue(false);
        renderers[0].isFirstPersonViewActive.mockReturnValue(true);
        expect(() => service.execute("viewer_set_app_state", args)).toThrow(expect.objectContaining({detail: expect.objectContaining({reason: "first_person"})}));
        expect(setter).not.toHaveBeenCalled();
        expect(state.focusedView).toBe(0);
    });

    it("does not misreport a first-person map camera as an empty success", () => {
        const {service, renderers} = fixture();
        renderers[0].getLiveCameraState.mockReturnValue(undefined);
        expect(read(service, [{channel: "view.camera", viewIndex: 0}])).toMatchObject({
            complete: false, values: [{unavailable: "first_person"}]
        });
    });

    it("rejects 2D tilt and readonly/unexposed writes with no effects", () => {
        const {service, state, views} = fixture();
        state.mode2dState.next(0, true);
        const setter = vi.spyOn(state, "setView");
        for (const target of [{channel: "view.camera", viewIndex: 0}, {channel: "app.searches"}, {channel: "__proto__"}]) {
            expect(() => service.execute("viewer_set_app_state", {target, value: camera(), viewLayoutRevision: views.viewLayoutRevision}))
                .toThrow(ViewerActionFailure);
        }
        expect(() => service.execute("constructor", {})).toThrow(ViewerActionFailure);
        expect(setter).not.toHaveBeenCalled();
    });

    it("distinguishes an unavailable target from an empty search collection", () => {
        const {service} = fixture();
        expect(read(service, [{channel: "app.searches"}])).toMatchObject({complete: true, values: [{value: []}]});
        expect(read(service, [{channel: "app.searches", searchId: "missing"}])).toMatchObject({complete: false, values: [{unavailable: "target_unavailable"}]});
    });

    it("caps copying and explicitly reports oversized search collections/text", () => {
        const {service, state, searches} = fixture();
        state.featureSearchState.next(Array.from({length: 120}, (_, index) => createFeatureSearchStateEntry({
            id: `search-${index}`, query: "x".repeat(5000)
        })));
        const result = read(service, [{channel: "app.searches"}]);
        expect(result.complete).toBe(false);
        expect(result.omissions).toEqual([{target: {channel: "app.searches"}, reason: "text_limit"}]);
        expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(256 * 1024);
        expect(searches.getSession.mock.calls.length).toBeLessThan(100);
    });

    it.each([false, true])("truncates search summaries by code points (over limit=%s)", overLimit => {
        const {service, state} = fixture();
        const prefix = "😀".repeat(4096);
        const query = prefix + (overLimit ? "x" : "");
        state.featureSearchState.next([createFeatureSearchStateEntry({id: "unicode", query})]);
        const result = read(service, [{channel: "app.searches"}]);
        expect(result.values[0]).toMatchObject({value: [{query: prefix}]});
        expect(result.complete).toBe(!overLimit);
        expect(result.omissions).toEqual(overLimit ? [{target: {channel: "app.searches"}, reason: "text_limit"}] : []);
        expect(state.featureSearchState.getValue()[0].query).toBe(query);
    });

    it("describes canonical runtime values, not storage codecs", () => {
        const {service} = fixture();
        const result = viewerActions.viewer_describe_app_state.outputSchema.parse(service.execute("viewer_describe_app_state", {prefix: "view.camera"}));
        expect(result.channels).toHaveLength(1);
        expect(result.channels[0].valueSchema["properties"]).toHaveProperty("destination");
        expect(result.views.views).toHaveLength(2);
    });

    it.each([
        ["app.preferences.navigation", {zoomStep: 0.2, featureZoomClearance: 12}],
        ["app.preferences.inspection", {limit: 8, drillPickRadius: 4, expandByDefault: true, varyColors: false, varyOutlines: true, varyStriping: true}],
        ["app.preferences.hover", {enabled: true, fields: [{expression: "a.b", customExpression: false, displayKey: "B"}]}],
        ["app.preferences.rendering", {antialiasing: false, semanticCompositing: false, contactShading: false, tilePullCompression: true, tileLimit: 1024, renderWorkers: 2}],
        ["app.marker", {enabled: true, position: {lon: 11, lat: 48, alt: 12}}],
        ["app.viewSync", ["lay"]]
    ])("round-trips %s through the normal state owner", (channel, value) => {
        const {service} = fixture();
        const result = viewerActions.viewer_set_app_state.outputSchema.parse(service.execute("viewer_set_app_state", {target: {channel}, value}));
        expect(result).toMatchObject({status: "applied", value, readiness: {status: "unknown"}});
        expect(read(service, [{channel}])).toMatchObject({complete: true, values: [{value}]});
        expect(service.execute("viewer_set_app_state", {target: {channel}, value})).toMatchObject({changed: false});
    });

    it("does not let an invalid channel/value pair mutate any preference", () => {
        const {service, state} = fixture();
        const before = state.inspectionsLimit;
        expect(() => service.execute("viewer_set_app_state", {target: {channel: "app.preferences.inspection"}, value: "3d"})).toThrow(ViewerActionFailure);
        expect(state.inspectionsLimit).toBe(before);
        expect(() => service.execute("viewer_set_app_state", {target: {channel: "app.viewSync"}, value: ["pos", "mov"]})).toThrow(ViewerActionFailure);
        expect(state.viewSync).toEqual([]);
    });

    it("reports each unavailable setting without dropping successful sibling reads", () => {
        const {service} = fixture();
        expect(read(service, [{channel: "view.layer", viewIndex: 0, mapId: "missing", layerId: "missing"},
            {channel: "inspection.panel", panelId: 999}, {channel: "app.focusedView"}])).toMatchObject({complete: false, values: [
            {unavailable: "target_unavailable"}, {unavailable: "target_unavailable"}, {value: 0}
        ]});
    });

    it("validates background identities and discovers metadata without URLs", () => {
        const {service, state} = fixture();
        expect(service.execute("viewer_get_catalog", {kind: "backgrounds"})).toMatchObject({complete: true, items: [{id: "osm", name: "OSM", kind: "xyz"}]});
        const previous = state.getBackgroundState(0);
        expect(() => service.execute("viewer_set_app_state", {target: {channel: "view.background", viewIndex: 0},
            value: {layerId: "unknown", opacity: 50}, viewLayoutRevision: 0})).toThrow(ViewerActionFailure);
        expect(state.getBackgroundState(0)).toEqual(previous);
    });

    it("guards focus and view creation/removal using the observed layout revision", () => {
        const {service, state, views} = fixture();
        expect(service.execute("viewer_set_app_state", {target: {channel: "app.focusedView"}, value: 1, viewLayoutRevision: views.viewLayoutRevision})).toMatchObject({changed: true});
        const revision = views.viewLayoutRevision;
        service.execute("viewer_manage_view", {operation: "remove", viewIndex: 0, viewLayoutRevision: revision});
        expect(state.numViews).toBe(1);
        expect(() => service.execute("viewer_manage_view", {operation: "create", viewIndex: 0, viewLayoutRevision: revision})).toThrow(ViewerActionFailure);
        service.execute("viewer_manage_view", {operation: "create", viewIndex: 0, viewLayoutRevision: views.viewLayoutRevision});
        expect(state.numViews).toBe(2);
        expect(() => service.execute("viewer_manage_view", {operation: "create", viewIndex: 0, viewLayoutRevision: views.viewLayoutRevision})).toThrow(ViewerActionFailure);
    });

    it.each(["isCameraInteractionActive", "isFirstPersonViewActive"] as const)("honors a synchronized sibling's %s before changing projection or focus", method => {
        const {service, state, views, renderers} = fixture();
        state.viewSyncState.next(["proj"]);
        renderers[0][method].mockReturnValue(true);
        const setter = vi.spyOn(state, "setProjectionMode");
        expect(() => service.execute("viewer_set_app_state", {target: {channel: "view.projection", viewIndex: 1},
            value: "2d", viewLayoutRevision: views.viewLayoutRevision})).toThrow(ViewerActionFailure);
        expect(setter).not.toHaveBeenCalled();
        expect(state.focusedView).toBe(0);
    });

    it("opens, updates and closes a real inspection shell without waiting for data", async () => {
        const {service, state, stream} = fixture();
        const feature = {mapTileKey: "Features:map:layer:1", featureId: "Road.1:attribute#2"};
        const result = viewerActions.viewer_inspect.outputSchema.parse(await service.execute("viewer_inspect", {features: [feature], lock: true}));
        expect(result).toMatchObject({complete: true, features: [feature], panelIds: [0]});
        expect(state.selection[0].locked).toBe(true);
        expect(stream.loadFeatures).not.toHaveBeenCalled();
        expect(service.execute("viewer_set_app_state", {target: {channel: "inspection.panel", panelId: 0},
            value: {locked: true, undocked: true, focused: true, color: "#123456"}})).toMatchObject({changed: true});
        expect(read(service, [{channel: "inspection.panel", panelId: 0}])).toMatchObject({values: [{value: {undocked: true, color: "#123456"}}]});
        expect(service.execute("viewer_close_inspection", {panelId: 0})).toMatchObject({status: "applied"});
        expect(state.selection).toHaveLength(0);
        expect(() => service.execute("viewer_close_inspection", {panelId: 0})).toThrow(ViewerActionFailure);
    });

    it("rejects ambiguous locations and preserves attribute suffixes after canonical locate", async () => {
        const {service, stream} = fixture();
        const feature = {mapTileKey: "Features:map:layer:1", featureId: "Road.9"};
        stream.locateFeature.mockResolvedValue([feature, feature]);
        await expect(service.execute("viewer_inspect", {features: [{mapId: "map", featureId: "Road.1"}]})).rejects.toThrow(ViewerActionFailure);
        stream.locateFeature.mockResolvedValue([feature]);
        expect(await service.execute("viewer_inspect", {features: [{mapId: "map", featureId: "Road.1:attribute#2:validity#0"}]}))
            .toMatchObject({features: [{...feature, featureId: "Road.9:attribute#2:validity#0"}]});
    });

    it("does not overwrite an in-place human selection change while locating", async () => {
        const {service, stream, state, inspections} = fixture();
        let resolve!: (value: Array<{mapTileKey: string; featureId: string}>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        const action = service.execute("viewer_inspect", {features: [{mapId: "map", featureId: "Road.1"}]});
        state.setSelection([{mapTileKey: "Features:map:layer:1", featureId: "Human.1"}]);
        resolve([{mapTileKey: "Features:map:layer:1", featureId: "Road.1"}]);
        await expect(action).rejects.toThrow(expect.objectContaining({detail: expect.objectContaining({code: "cancelled"})}));
        expect(inspections.inspectFeatureIds).not.toHaveBeenCalled();
        expect(state.selection[0].features[0].featureId).toBe("Human.1");
    });

    it.each(["cancel", "stop", "disconnect", "timeout"])("%s retires an async locate without a late inspection", async operation => {
        const {service, stream, inspections} = await activeFixture();
        let resolve!: (value: Array<{mapTileKey: string; featureId: string}>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        stream.actionControlReceived.next({payload: {type: "mapget.actions.invoke", version: 1, callId: "async", action: "viewer_inspect",
            arguments: {features: [{mapId: "map", featureId: "Road.1"}]}, timeoutMs: operation === "timeout" ? 10 : 30000}, receivedAt: performance.now()});
        await Promise.resolve();
        expect(stream.locateFeature).toHaveBeenCalled();
        if (operation === "cancel") stream.actionControlReceived.next({payload: {type: "mapget.actions.cancel", version: 1, callId: "async", reason: "cancelled"}, receivedAt: performance.now()});
        if (operation === "stop") service.stopCurrentAction();
        if (operation === "disconnect") stream.actionClientId$.next(null);
        if (operation === "timeout") await vi.waitFor(() => expect(service.hasPendingAction).toBe(false));
        resolve([{mapTileKey: "Features:map:layer:1", featureId: "Road.1"}]);
        await vi.waitFor(() => expect(service.hasPendingAction).toBe(false));
        expect(inspections.inspectFeatureIds).not.toHaveBeenCalled();
        expect(stream.sendActionControl).toHaveBeenCalledTimes(operation === "disconnect" ? 0 : 1);
    });

    it("navigates explicit bounds but cancels a pending fit on a human gesture", async () => {
        const {service, views, stream, inspections, renderers, viewDiagnostics} = fixture();
        const moved = vi.fn();
        views.moveToRectangleTopic.subscribe(moved);
        expect(await service.execute("viewer_navigate", {viewIndex: 0, viewLayoutRevision: views.viewLayoutRevision,
            target: {bounds: {west: 10, south: 40, east: 11, north: 41}}})).toMatchObject({status: "applied"});
        expect(moved).toHaveBeenCalledOnce();
        let resolve!: (value: Array<{mapTileKey: string; featureId: string}>) => void;
        stream.locateFeature.mockReturnValue(new Promise(done => { resolve = done; }));
        const pending = service.execute("viewer_navigate", {viewIndex: 1, viewLayoutRevision: views.viewLayoutRevision,
            target: {features: [{mapId: "map", featureId: "Road.1"}]}});
        renderers[1].isCameraInteractionActive.mockReturnValue(true);
        viewDiagnostics.cameraInteracting$.next(true);
        resolve([{mapTileKey: "Features:map:layer:1", featureId: "Road.1"}]);
        await expect(pending).rejects.toThrow(expect.objectContaining({detail: expect.objectContaining({code: "cancelled"})}));
        expect(inspections.featureSetZoomTarget).not.toHaveBeenCalled();
        expect(stream.loadFeatures).not.toHaveBeenCalled();
    });

    it("opens a source-data address losslessly through the ordinary panel state", () => {
        const {service, state} = fixture();
        expect(service.execute("viewer_open_source_data", {source: {mapTileKey: "SourceData:map:layer:1", address: "18446744073709551615"}}))
            .toMatchObject({panelId: 0, status: "applied"});
        expect(state.selection[0].sourceData?.address).toBe(18446744073709551615n);
        expect(() => service.execute("viewer_open_source_data", {source: {mapTileKey: "SourceData:map:layer:1", address: "18446744073709551616"}})).toThrow(ViewerActionFailure);
        expect(state.selection).toHaveLength(1);
    });

    it("reads bounded search slices, rejects stale runs and delegates lifecycle without touching sibling searches", () => {
        const {service, searches, state, views} = fixture();
        const definition = createFeatureSearchStateEntry({id: "s", query: "**.warningSign", selectedViewIndices: [0], selectedMapLayers: []});
        const result = {label: "sign", mapId: "m", layerId: "l", featureId: "Road.1", resultIndex: 0, resultKey: "r", mapTileKey: "Features:m:l:1",
            sourceTileKey: "Features:m:l:1", sourceMapId: "m", sourceLayerId: "l", sourceTileId: -2147483648, hoverFeatureId: "Road.1"};
        const session = {id: "s", definition, runId: "run-1", refresh: 2, complete: true, paused: false,
            searchResults: [result, {...result, resultKey: "r2"}], errors: new Set<string>(), progressDone: 2, progressTotal: 2} as FeatureSearchSession;
        searches.getSession.mockReturnValue(session);
        expect(viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", {searchId: "s"}))).toMatchObject({settings: {scope: "auto"}, status: {resultCount: 2}});
        const slice = viewerActions.viewer_get_search_results.outputSchema.parse(service.execute("viewer_get_search_results", {searchId: "s", limit: 1}));
        expect(slice).toMatchObject({complete: false, reason: "item_limit", results: [result]});
        expect(() => service.execute("viewer_get_search_results", {searchId: "s", runId: "older"})).toThrow(ViewerActionFailure);
        const exported = viewerActions.viewer_export_search.outputSchema.parse(service.execute("viewer_export_search", {searchId: "s", include: "both", offset: 1}));
        expect(JSON.parse(exported.content).results.results).toEqual([{...result, resultKey: "r2"}]);
        expect(exported.complete).toBe(true);
        for (const operation of ["pause", "stop", "close", "refresh", "rerun"]) service.execute("viewer_control_search", {searchId: "s", operation, ...(operation === "rerun" ? {query: "new"} : {})});
        expect(searches.pauseSearch).toHaveBeenCalledWith("s");
        expect(searches.stopSearch).toHaveBeenCalledWith("s");
        expect(searches.closeSearch).toHaveBeenCalledWith("s");
        expect(searches.updateSearchInArea).toHaveBeenCalledWith("s");
        expect(searches.rerunSearch).toHaveBeenCalledWith("s", "new");
        expect(service.execute("viewer_control_search", {searchId: "s", operation: "resume"})).toMatchObject({changed: false});
        session.paused = true;
        service.execute("viewer_control_search", {searchId: "s", operation: "resume"});
        expect(searches.resumeSearch).toHaveBeenCalledWith("s");
        session.definition.enabled = false;
        expect(() => service.execute("viewer_control_search", {searchId: "s", operation: "refresh"})).toThrow(ViewerActionFailure);
        state.featureSearchState.next([definition]);
        const settings = viewerActions.viewer_get_search.outputSchema.parse(service.execute("viewer_get_search", {searchId: "s"})).settings;
        expect(service.execute("viewer_set_search", {searchId: "s", settings: {...settings, showResultsOnMap: false}, viewLayoutRevision: views.viewLayoutRevision}))
            .toMatchObject({changed: true});
        expect(state.featureSearches[0].showResultsOnMap).toBe(false);
    });

    it("validates style drafts and delegates browser-local lifecycle operations without server writes", () => {
        const {service, styles} = fixture();
        styles.styles.set("style", {id: "style", source: "name: style", imported: false, modified: true, visible: true});
        expect(service.execute("viewer_get_style", {styleId: "style"})).toMatchObject({source: "name: style", modified: true});
        expect(service.execute("viewer_validate_style", {source: "name: draft"})).toMatchObject({valid: true, issues: [], complete: true});
        expect(service.execute("viewer_edit_style", {operation: "create", source: "name: new-style", visible: false})).toMatchObject({styleId: "new-style"});
        expect(styles.importStyleYamlSource).toHaveBeenCalledWith("name: new-style", false);
        service.execute("viewer_edit_style", {operation: "update", styleId: "style", source: "name: style"});
        expect(styles.setStyleSource).toHaveBeenCalledWith("style", "name: style");
        service.execute("viewer_edit_style", {operation: "reset", styleId: "style"});
        expect(styles.resetModifiedBuiltinStyle).toHaveBeenCalledWith("style");
        service.execute("viewer_edit_style", {operation: "visibility", styleId: "style", visible: false});
        expect(styles.toggleStyle).toHaveBeenCalledWith("style", false);
        expect(() => service.execute("viewer_edit_style", {operation: "delete", styleId: "style"})).toThrow(ViewerActionFailure);
        expect(styles.deleteStyle).not.toHaveBeenCalled();
        styles.styles.get("style").imported = true;
        service.execute("viewer_edit_style", {operation: "delete", styleId: "style"});
        expect(styles.deleteStyle).toHaveBeenCalledWith("style", true);
    });

    it("samples diagnostic counters/caches without scene traversal or treating missing GPU data as zero", () => {
        const {service, render, viewDiagnostics} = fixture();
        const result = viewerActions.viewer_get_diagnostics.outputSchema.parse(service.execute("viewer_get_diagnostics", {viewIndex: 0}));
        expect(result).toMatchObject({complete: true, errors: []});
        expect(result.metrics).toContainEqual(expect.objectContaining({name: "queued", value: 3}));
        expect(result.metrics).toContainEqual(expect.objectContaining({name: "frameTimeP90Ms", value: null, scope: "view", viewIndex: 0}));
        expect(result.unavailable.join(" ")).toContain("Scoped GPU allocation is unavailable");
        expect(render.debugSnapshot).not.toHaveBeenCalled();
        expect(viewDiagnostics.snapshot).not.toHaveBeenCalled();
    });
});
