import { testPersistence } from '../../test/state-owners';
import { stateOwners } from '../../test/state-owners';
import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import type { StyleService } from "../styledata/style.service";
import type { AppStateService } from "./appstate.service";
import type { MapViewService } from "../mapview/map-view.service";
import type { FeatureSearchService } from "../search/feature.search.service";
import {
    PRESENTATION_BRIDGE_APPLY,
    PRESENTATION_BRIDGE_APPLY_URL_STATE,
    PRESENTATION_BRIDGE_PROTOCOL_VERSION,
    PRESENTATION_BRIDGE_READY,
    PRESENTATION_BRIDGE_RESULT,
    PRESENTATION_BRIDGE_START_FLIGHT,
    PRESENTATION_BRIDGE_STOP_FLIGHT,
    PresentationStateBridgeService
} from "./presentation-state-bridge.service";

interface FramedWindowFixture {
    host: Window;
    parent: Window;
    parentPostMessage: ReturnType<typeof vi.fn>;
    dispatch(data: unknown, origin?: string, source?: MessageEventSource): void;
    removeEventListener: ReturnType<typeof vi.fn>;
}

/** Provides the style owner without loading WASM in bridge unit tests. */
function styleServiceFixture(): StyleService {
    return { reconcilePresentationStyles: vi.fn() } as unknown as StyleService;
}

function mapViewStateFixture(): MapViewService {
    return {
        presentationCameraViewStateTopic: { next: vi.fn() },
        waitForCurrentViewports: vi.fn().mockResolvedValue(undefined)
    } as unknown as MapViewService;
}

/** Creates the small Window surface used by the opt-in bridge. */
function framedWindow(search = "?embed=presentation"): FramedWindowFixture {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const parentPostMessage = vi.fn();
    const parent = { postMessage: parentPostMessage } as unknown as Window;
    const removeEventListener = vi.fn();
    const host = {
        parent,
        location: { search },
        document,
        addEventListener: vi.fn((type: string, callback: EventListener) => {
            if (type === "message") {
                listener = callback as (event: MessageEvent<unknown>) => void;
            }
        }),
        removeEventListener
    } as unknown as Window;
    return {
        host,
        parent,
        parentPostMessage,
        dispatch(data, origin = "http://deck.test", source = parent): void {
            listener?.({ data, origin, source } as MessageEvent<unknown>);
        },
        removeEventListener
    };
}

/** Creates one valid native-state request. */
function request(requestId: number, state: Record<string, unknown>): Record<string, unknown> {
    return {
        type: PRESENTATION_BRIDGE_APPLY,
        version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
        requestId,
        state
    };
}

/** Lets an async request loop advance through resolved promises. */
async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe("PresentationStateBridgeService", () => {
    it("starts authored search exports after applying scene state and dismissing previous searches", async () => {
        const fixture = framedWindow();
        const calls: string[] = [];
        const replaceUrlState = vi.fn(async () => { calls.push("state"); });
        const searchService = {
            dismissForPresentation: vi.fn(() => calls.push("dismiss")),
            importSearchJsonPayload: vi.fn(() => { calls.push("import"); return { id: "scene-search" }; }),
            closeSearch: vi.fn()
        };
        const view = mapViewStateFixture();
        let ready!: () => void;
        vi.mocked(view.waitForCurrentViewports).mockImplementation(() => new Promise<void>(resolve => {
            ready = resolve;
        }));
        const bridge = new PresentationStateBridgeService(
            { replaceUrlState } as unknown as AppStateService,
            view, styleServiceFixture(), searchService as unknown as FeatureSearchService, Object.assign({ replaceUrlState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceUrlState } as unknown as AppStateService as never, { replaceUrlState } as unknown as AppStateService as never
        );
        bridge.initialize(fixture.host);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_READY, version: 2, capabilities: { searches: true }
        }, "*");
        const payload = {
            configuration: {
                query: "**.speedLimitKmh >= 80", scope: "attribute",
                selectedMapLayers: [{ mapId: "Map", layerId: "Lane" }], selectedMapLayersManual: true,
                selectedViewIndices: [0], renderStrategy: { showLowFiDots: false },
                searchStyleRules: [{ geometry: ["line"], color: { mode: "solid", color: "#008800" } }]
            }
        };
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 1, search: "?embed=presentation&v2=1", searches: [payload]
        });
        await flushMicrotasks();
        expect(calls).toEqual(["state", "dismiss"]);
        ready();
        await flushMicrotasks();
        expect(calls).toEqual(["state", "dismiss", "import"]);
        expect(searchService.importSearchJsonPayload).toHaveBeenCalledWith(payload);
        expect(fixture.parentPostMessage).toHaveBeenLastCalledWith({
            type: PRESENTATION_BRIDGE_RESULT, version: 2, requestId: 1, ok: true
        }, "http://deck.test");

        // Camera-only keyframes preserve the live search; an explicit empty list clears it.
        calls.length = 0;
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 2, search: "?embed=presentation&v2=1&alt=1000", reset: false
        });
        await flushMicrotasks();
        expect(calls).toEqual(["state"]);
        expect(searchService.closeSearch).not.toHaveBeenCalled();

        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 3, search: "?embed=presentation&v2=1", reset: false, searches: []
        });
        await flushMicrotasks();
        expect(searchService.closeSearch).toHaveBeenCalledExactlyOnceWith("scene-search");
        expect(searchService.dismissForPresentation).toHaveBeenCalledTimes(2);
        expect(searchService.importSearchJsonPayload).toHaveBeenCalledTimes(1);
        bridge.ngOnDestroy();
    });

    it("does not start a superseded scene's searches after slow state hydration", async () => {
        const fixture = framedWindow();
        let hydrated!: () => void;
        const replaceUrlState = vi.fn().mockResolvedValue(undefined);
        replaceUrlState.mockImplementationOnce(() => new Promise<void>(resolve => { hydrated = resolve; }));
        const view = mapViewStateFixture();
        const searchService = { dismissForPresentation: vi.fn(), importSearchJsonPayload: vi.fn() };
        const bridge = new PresentationStateBridgeService(
            { replaceUrlState } as unknown as AppStateService, view, styleServiceFixture(),
            searchService as unknown as FeatureSearchService, Object.assign({ replaceUrlState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceUrlState } as unknown as AppStateService as never, { replaceUrlState } as unknown as AppStateService as never
        );
        bridge.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 1, search: "?embed=presentation&v2=1", searches: [{ query: "true" }]
        });
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 2, search: "?embed=presentation&v2=1", searches: []
        });
        hydrated();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(view.waitForCurrentViewports).not.toHaveBeenCalled();
        expect(searchService.importSearchJsonPayload).not.toHaveBeenCalled();
        expect(fixture.parentPostMessage).toHaveBeenLastCalledWith({
            type: PRESENTATION_BRIDGE_RESULT, version: 2, requestId: 2, ok: true
        }, "http://deck.test");
        bridge.ngOnDestroy();
    });

    it("rejects a malformed search list before changing state or dismissing searches", async () => {
        const fixture = framedWindow();
        const state = { replaceUrlState: vi.fn() };
        const searchService = { dismissForPresentation: vi.fn(), importSearchJsonPayload: vi.fn() };
        const bridge = new PresentationStateBridgeService(
            state as unknown as AppStateService, mapViewStateFixture(), styleServiceFixture(),
            searchService as unknown as FeatureSearchService, Object.assign(state as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, state as unknown as AppStateService as never, state as unknown as AppStateService as never
        );
        bridge.initialize(fixture.host);
        for (const searches of [null, {}, Array(1), [{ query: "valid" }, { tree: [] }], Array(51).fill({ query: "valid" })]) {
            fixture.dispatch({
                type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
                requestId: 1, search: "?embed=presentation&v2=1", searches
            });
            await flushMicrotasks();
            expect(fixture.parentPostMessage).toHaveBeenLastCalledWith({
                type: PRESENTATION_BRIDGE_RESULT, version: 2, requestId: 1, ok: false, error: "invalid-searches"
            }, "http://deck.test");
        }
        expect(state.replaceUrlState).not.toHaveBeenCalled();
        expect(searchService.dismissForPresentation).not.toHaveBeenCalled();
        expect(searchService.importSearchJsonPayload).not.toHaveBeenCalled();
        bridge.ngOnDestroy();
    });

    it("does not silently acknowledge searches when no search owner is available", async () => {
        const fixture = framedWindow();
        const state = { replaceUrlState: vi.fn() };
        const bridge = new PresentationStateBridgeService(
            state as unknown as AppStateService, mapViewStateFixture(), styleServiceFixture(), null, Object.assign(state as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, state as unknown as AppStateService as never, state as unknown as AppStateService as never
        );
        bridge.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2,
            requestId: 1, search: "?embed=presentation&v2=1", searches: [{ query: "**.warningSign" }]
        });
        await flushMicrotasks();
        expect(state.replaceUrlState).not.toHaveBeenCalled();
        expect(fixture.parentPostMessage).toHaveBeenLastCalledWith({
            type: PRESENTATION_BRIDGE_RESULT, version: 2, requestId: 1, ok: false, error: "invalid-searches"
        }, "http://deck.test");
        bridge.ngOnDestroy();
    });

    it("honors false reset policy and rejects a malformed reset flag", async () => {
        const fixture = framedWindow();
        const replaceUrlState = vi.fn().mockResolvedValue(undefined);
        const service = new PresentationStateBridgeService(
            { replaceUrlState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceUrlState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceUrlState } as unknown as AppStateService as never, { replaceUrlState } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 20, search: "?embed=presentation&v2=1", reset: false
        });
        await flushMicrotasks();
        expect(replaceUrlState).toHaveBeenCalledWith(expect.anything(), false);
        replaceUrlState.mockClear();
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 21, search: "?embed=presentation&v2=1", reset: "false"
        });
        await flushMicrotasks();
        expect(replaceUrlState).not.toHaveBeenCalled();
        service.ngOnDestroy();
    });
    it("does not start delayed motion after the parent has left the scene", async () => {
        const fixture = framedWindow();
        const camera = { destination: { lon: 11, lat: 48, alt: 100 }, orientation: { heading: 0, pitch: -1, roll: 0 } };
        let complete!: () => void;
        const state = {
            cameraViewDataState: { getValue: () => camera },
            replaceUrlState: () => new Promise<void>(resolve => { complete = resolve; })
        } as unknown as AppStateService;
        const view = mapViewStateFixture();
        const bridge = new PresentationStateBridgeService(state, view, styleServiceFixture(), null, state as never, state as never, state as never);
        bridge.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2, requestId: 1,
            search: '?embed=presentation&v2=1', transitionMs: 2000
        });
        fixture.dispatch({ type: PRESENTATION_BRIDGE_STOP_FLIGHT, version: 2 });
        complete();
        await flushMicrotasks();
        expect(view.presentationCameraViewStateTopic.next).not.toHaveBeenCalled();
        bridge.ngOnDestroy();
    });
    it("opens an authored docked selection even alongside a floating source-data panel", async () => {
        const fixture = framedWindow();
        const state = {
            replaceUrlState: vi.fn(async () => { }), isDockOpen: false, dockActiveTab: 'search', selection: [
                { undocked: false, features: [{ featureId: 'Road.1' }] },
                { undocked: true, features: [], sourceData: { mapTileKey: 'SourceData:map:layer:1' } }
            ]
        } as unknown as AppStateService;
        const bridge = new PresentationStateBridgeService(state, mapViewStateFixture(), styleServiceFixture(), null, state as never, state as never, state as never);
        bridge.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2, requestId: 1,
            search: '?embed=presentation&v2=1&sel=fixture'
        });
        await flushMicrotasks();
        expect((state as unknown as { isDockOpen: boolean }).isDockOpen).toBe(true);
        expect((state as unknown as { dockActiveTab: string }).dockActiveTab).toBe('inspection');
        bridge.ngOnDestroy();
    });
    it("interpolates a keyframe once, takes the short heading route, and keeps the authored destination", async () => {
        const fixture = framedWindow();
        let frame: FrameRequestCallback | undefined;
        Object.assign(fixture.host, {
            requestAnimationFrame: vi.fn(callback => { frame = callback; return 1; }),
            cancelAnimationFrame: vi.fn(), matchMedia: () => ({ matches: false })
        });
        const from = { destination: { lon: 11, lat: 48, alt: 100 }, orientation: { heading: 6.2, pitch: -1, roll: 0 } };
        const to = { destination: { lon: 12, lat: 49, alt: 10000 }, orientation: { heading: 0.1, pitch: -0.5, roll: 0 } };
        let camera = from;
        const state = {
            cameraViewDataState: { getValue: () => camera },
            replaceUrlState: vi.fn(async () => { camera = to; })
        } as unknown as AppStateService;
        const view = mapViewStateFixture();
        const next = vi.mocked(view.presentationCameraViewStateTopic.next);
        const bridge = new PresentationStateBridgeService(state, view, styleServiceFixture(), null, state as never, state as never, state as never);
        bridge.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2, requestId: 1,
            search: '?embed=presentation&v2=1&alt=10000', transitionMs: 2000
        });
        await flushMicrotasks();
        expect(next).toHaveBeenLastCalledWith({ targetView: 0, cameraViewData: from });
        frame!(0); frame!(1000);
        const middle = next.mock.lastCall![0].cameraViewData;
        expect(middle.destination.alt).toBeCloseTo(1000);
        expect(middle.orientation.heading).toBeGreaterThan(6.2);
        frame!(2000);
        expect(next).toHaveBeenLastCalledWith({ targetView: 0, cameraViewData: to });
        expect(camera).toBe(to);
        expect(fixture.host.requestAnimationFrame).toHaveBeenCalledTimes(3);
        bridge.ngOnDestroy();
    });

    it("rejects unbounded camera transition durations", async () => {
        const fixture = framedWindow();
        const state = { replaceUrlState: vi.fn() } as unknown as AppStateService;
        const bridge = new PresentationStateBridgeService(state, mapViewStateFixture(), styleServiceFixture(), null, state as never, state as never, state as never);
        bridge.initialize(fixture.host);
        for (const transitionMs of [-1, 10001, NaN, '2000']) {
            fixture.dispatch({
                type: PRESENTATION_BRIDGE_APPLY_URL_STATE, version: 2, requestId: 1,
                search: '?embed=presentation&v2=1&alt=100', transitionMs
            });
        }
        expect(state.replaceUrlState).not.toHaveBeenCalled();
        bridge.ngOnDestroy();
    });
    it("orbits a geographic target continuously and stops when the scene leaves", () => {
        let frame: FrameRequestCallback | undefined;
        const fixture = framedWindow();
        Object.assign(fixture.host, {
            performance: { now: () => 0 },
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }),
            cancelAnimationFrame: vi.fn()
        });
        const view = mapViewStateFixture();
        const next = vi.mocked(view.presentationCameraViewStateTopic.next);
        const service = new PresentationStateBridgeService({} as AppStateService, view, styleServiceFixture(), null, Object.assign({} as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, {} as AppStateService as never, {} as AppStateService as never);
        service.initialize(fixture.host);
        fixture.dispatch({
            type: PRESENTATION_BRIDGE_START_FLIGHT, version: 2, flight: {
                durationMs: 120_000, pingPong: false, canvasOnly: true,
                orbit: { center: [11.5755, 48.1372, 520], radius: 1100, height: 700 }
            }
        });
        frame?.(0);
        const first = next.mock.calls.at(-1)![0]!.cameraViewData;
        expect(first.destination.lat).toBeGreaterThan(48.1372);
        expect(first.destination.alt).toBeCloseTo(1220);
        frame?.(30_000);
        expect(next.mock.calls.at(-1)![0]!.cameraViewData.destination.lon).toBeGreaterThan(11.5755);
        frame?.(120_000);
        expect(next.mock.calls.at(-1)![0]!.cameraViewData).toEqual(first);
        fixture.dispatch({ type: PRESENTATION_BRIDGE_STOP_FLIGHT, version: 2 });
        expect(fixture.host.cancelAnimationFrame).toHaveBeenCalled();
        expect(document.body.classList.contains('presentation-canvas-only')).toBe(false);
        service.ngOnDestroy();
    });
    it("activates only in a framed presentation document and announces readiness", () => {
        const stateService = testPersistence();
        vi.spyOn(stateService, "replaceSnapshotState").mockReturnValue([]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(stateService, mapViewStateFixture(), styleServiceFixture(), null, stateOwners(stateService).viewSettings, stateOwners(stateService).inspectionState, stateOwners(stateService).layout);

        expect(service.initialize(fixture.host)).toBe(true);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_READY,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            capabilities: { searches: false }
        }, "*");

        service.ngOnDestroy();
        expect(fixture.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));

        const plainFrame = framedWindow("");
        expect(new PresentationStateBridgeService(stateService, mapViewStateFixture(), styleServiceFixture(), null, stateOwners(stateService).viewSettings, stateOwners(stateService).inspectionState, stateOwners(stateService).layout).initialize(plainFrame.host)).toBe(false);

        const topLevel = framedWindow();
        Object.defineProperty(topLevel.host, "parent", { value: topLevel.host });
        expect(new PresentationStateBridgeService(stateService, mapViewStateFixture(), styleServiceFixture(), null, stateOwners(stateService).viewSettings, stateOwners(stateService).inspectionState, stateOwners(stateService).layout).initialize(topLevel.host)).toBe(false);
    });

    it("applies native snapshot state and acknowledges completion", async () => {
        const replaceSnapshotState = vi.fn().mockReturnValue([]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            { replaceSnapshotState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceSnapshotState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceSnapshotState } as unknown as AppStateService as never, { replaceSnapshotState } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        const state = { numberOfViews: 2, mode2d: [true, false] };
        fixture.dispatch(request(7, state));
        await flushMicrotasks();

        expect(replaceSnapshotState).toHaveBeenCalledWith(state);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 7,
            ok: true
        }, "http://deck.test");
    });

    it("also applies query-authored presentation state through protocol v2", async () => {
        const replaceUrlState = vi.fn().mockResolvedValue(undefined);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            { replaceUrlState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceUrlState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceUrlState } as unknown as AppStateService as never, { replaceUrlState } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch({
            type: PRESENTATION_BRIDGE_APPLY_URL_STATE,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 8,
            search: "?v2=1&embed=presentation&map=Provider%2FSample%20San%20Francisco"
        });
        await flushMicrotasks();

        expect(replaceUrlState).toHaveBeenCalledWith(expect.objectContaining({
            embed: "presentation",
            map: "Provider/Sample San Francisco",
            v2: "1"
        }), true);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 8,
            ok: true
        }, "http://deck.test");
    });

    it("reports semantic rejection without exposing validation details", async () => {
        const replaceSnapshotState = vi.fn().mockReturnValue(["Invalid value for 'mode2d'."]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            { replaceSnapshotState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceSnapshotState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceSnapshotState } as unknown as AppStateService as never, { replaceSnapshotState } as unknown as AppStateService as never
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(4, { mode2d: "wrong" }));
        await flushMicrotasks();

        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 4,
            ok: false,
            error: "invalid-state"
        }, "http://deck.test");
        expect(fixture.parentPostMessage.mock.calls.flat().join(" ")).not.toContain("mode2d");
        warning.mockRestore();
    });

    it("rejects malformed envelopes and ignores foreign sources or a changed parent origin", async () => {
        const replaceSnapshotState = vi.fn().mockReturnValue([]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            { replaceSnapshotState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceSnapshotState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceSnapshotState } as unknown as AppStateService as never, { replaceSnapshotState } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, { marker: true }), "http://deck.test", {} as Window);
        fixture.dispatch({ ...request(2, { marker: true }), state: [] });
        fixture.dispatch(request(3, { marker: true }));
        await flushMicrotasks();
        fixture.dispatch(request(4, { marker: false }), "http://other.test");
        fixture.dispatch({ ...request(5, { marker: false }), version: 1 });
        await flushMicrotasks();

        expect(replaceSnapshotState).toHaveBeenCalledTimes(1);
        expect(fixture.parentPostMessage.mock.calls).toContainEqual([{
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 2,
            ok: false,
            error: "invalid-message"
        }, "http://deck.test"]);
        expect(fixture.parentPostMessage.mock.calls).toContainEqual([{
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 5,
            ok: false,
            error: "invalid-message"
        }, "http://deck.test"]);
        expect(fixture.parentPostMessage.mock.calls.flat()).not.toContain(4);
    });

    it("serializes applications and retains only the latest waiting request", async () => {
        let finishFirst: ((errors: string[]) => void) | undefined;
        const first = new Promise<string[]>(resolve => {
            finishFirst = resolve;
        });
        const replaceSnapshotState = vi.fn()
            .mockImplementationOnce(() => first)
            .mockReturnValue([]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            { replaceSnapshotState } as unknown as AppStateService,
            mapViewStateFixture(), styleServiceFixture(), null, Object.assign({ replaceSnapshotState } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceSnapshotState } as unknown as AppStateService as never, { replaceSnapshotState } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, { marker: false }));
        fixture.dispatch(request(2, { marker: true }));
        fixture.dispatch(request(3, { marker: false, numberOfViews: 2 }));
        expect(replaceSnapshotState).toHaveBeenCalledTimes(1);

        finishFirst?.([]);
        await flushMicrotasks();

        expect(replaceSnapshotState).toHaveBeenCalledTimes(2);
        expect(replaceSnapshotState).toHaveBeenLastCalledWith({ marker: false, numberOfViews: 2 });
        const resultIds = fixture.parentPostMessage.mock.calls
            .map(([message]) => message as { type?: string; requestId?: number })
            .filter(message => message.type === PRESENTATION_BRIDGE_RESULT)
            .map(message => message.requestId);
        expect(resultIds).toEqual([1, 3]);
    });

    it("runs and cancels a validated presentation camera flight", () => {
        let animationFrame: FrameRequestCallback | undefined;
        const fixture = framedWindow();
        Object.assign(fixture.host, {
            performance: { now: () => 0 },
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                animationFrame = callback;
                return 19;
            }),
            cancelAnimationFrame: vi.fn()
        });
        const next = vi.fn();
        const mapViewState = {
            presentationCameraViewStateTopic: { next }
        } as unknown as MapViewService;
        const service = new PresentationStateBridgeService(
            { replaceSnapshotState: vi.fn() } as unknown as AppStateService,
            mapViewState, styleServiceFixture(), null, Object.assign({ replaceSnapshotState: vi.fn() } as unknown as AppStateService, { viewIdAt: (index: number) => String(index) }) as never, { replaceSnapshotState: vi.fn() } as unknown as AppStateService as never, { replaceSnapshotState: vi.fn() } as unknown as AppStateService as never
        );
        service.initialize(fixture.host);

        fixture.dispatch({
            type: PRESENTATION_BRIDGE_START_FLIGHT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            flight: {
                durationMs: 10_000,
                turnDurationMs: 2_000,
                pingPong: true,
                canvasOnly: true,
                waypoints: [
                    { lon: 0, lat: 0, alt: 20, heading: 0, pitch: -0.2, roll: 0 },
                    { lon: 10, lat: 4, alt: 20, heading: 0.4, pitch: -0.2, roll: 0 }
                ]
            }
        });
        expect(document.body.classList.contains("presentation-canvas-only")).toBe(true);
        animationFrame?.(2_500);

        expect(next).toHaveBeenLastCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: {
                    lon: expect.closeTo(0.667218),
                    lat: expect.closeTo(0.266887),
                    alt: 20
                },
                orientation: { heading: expect.closeTo(0.026689), pitch: -0.2, roll: 0 },
                position: [0, 0, 0]
            }
        });
        animationFrame?.(5_000);

        expect(next).toHaveBeenCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: { lon: 5, lat: 2, alt: 20 },
                orientation: { heading: expect.closeTo(0.2), pitch: -0.2, roll: 0 },
                position: [0, 0, 0]
            }
        });
        animationFrame?.(11_000);
        expect(next).toHaveBeenLastCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: { lon: 10, lat: 4, alt: 20 },
                orientation: {
                    heading: expect.closeTo(0.4 + Math.PI / 2),
                    pitch: expect.closeTo(-0.2),
                    roll: 0
                },
                position: [0, 0, 0]
            }
        });
        animationFrame?.(12_000);
        expect(next).toHaveBeenLastCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: { lon: 10, lat: 4, alt: 20 },
                orientation: {
                    heading: expect.closeTo(0.4 + Math.PI),
                    pitch: expect.closeTo(-0.2),
                    roll: 0
                },
                position: [0, 0, 0]
            }
        });

        fixture.dispatch({
            type: PRESENTATION_BRIDGE_STOP_FLIGHT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION
        });
        expect(fixture.host.cancelAnimationFrame).toHaveBeenCalledWith(19);
        expect(document.body.classList.contains("presentation-canvas-only")).toBe(false);
    });
});
