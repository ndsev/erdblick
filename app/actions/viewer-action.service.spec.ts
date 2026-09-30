import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {BehaviorSubject, Subject} from "rxjs";
import {AppStateService, type CameraViewState, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../shared/appstate.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {createFeatureSearchStateEntry} from "../shared/feature-search-state";
import {ViewerActionFailure, ViewerActionService} from "./viewer-action.service";
import {viewerActions, type ViewerActionOutput} from "./viewer-action.contract";
import {VIEWER_ACTION_CATALOG_ID} from "./generated/catalog-id";

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
        isFirstPersonViewActive: vi.fn(() => false), isCameraInteractionActive: vi.fn(() => false)
    }));
    renderers.forEach(renderer => views.registerRenderView(renderer as never));
    const searches = {getSession: vi.fn(() => undefined)};
    const inspections = {selectionTopic: {getValue: () => []}};
    const zone = {run: vi.fn((callback: () => unknown) => callback()), runOutsideAngular: (callback: () => unknown) => callback()};
    const stream = {
        actionClientId$: new BehaviorSubject<string | null>(null),
        actionControlReceived: new Subject<{payload: unknown; receivedAt: number}>(),
        sendActionControl: vi.fn(() => true)
    };
    const service = new ViewerActionService(state, views, maps as never, searches as never, inspections as never, zone as never, stream as never);
    return {state, views, maps, renderers, searches, zone, service, stream};
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
});
