import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {AppStateService} from "./appstate.service";
import type {MapViewStateService} from "../mapview/map-view-state.service";
import {
    PRESENTATION_BRIDGE_APPLY,
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

function mapViewStateFixture(): MapViewStateService {
    return {
        presentationCameraViewStateTopic: {next: vi.fn()}
    } as unknown as MapViewStateService;
}

/** Creates the small Window surface used by the opt-in bridge. */
function framedWindow(search = "?embed=presentation"): FramedWindowFixture {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const parentPostMessage = vi.fn();
    const parent = {postMessage: parentPostMessage} as unknown as Window;
    const removeEventListener = vi.fn();
    const host = {
        parent,
        location: {search},
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
            listener?.({data, origin, source} as MessageEvent<unknown>);
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
    it("activates only in a framed presentation document and announces readiness", () => {
        const stateService = {replaceSnapshotState: vi.fn()} as unknown as AppStateService;
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(stateService, mapViewStateFixture());

        expect(service.initialize(fixture.host)).toBe(true);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_READY,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION
        }, "*");

        service.ngOnDestroy();
        expect(fixture.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));

        const plainFrame = framedWindow("");
        expect(new PresentationStateBridgeService(stateService, mapViewStateFixture()).initialize(plainFrame.host)).toBe(false);

        const topLevel = framedWindow();
        Object.defineProperty(topLevel.host, "parent", {value: topLevel.host});
        expect(new PresentationStateBridgeService(stateService, mapViewStateFixture()).initialize(topLevel.host)).toBe(false);
    });

    it("applies native snapshot state and acknowledges completion", async () => {
        const replaceSnapshotState = vi.fn().mockReturnValue([]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            {replaceSnapshotState} as unknown as AppStateService,
            mapViewStateFixture()
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        const state = {numberOfViews: 2, mode2d: [true, false]};
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

    it("reports semantic rejection without exposing validation details", async () => {
        const replaceSnapshotState = vi.fn().mockReturnValue(["Invalid value for 'mode2d'."]);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(
            {replaceSnapshotState} as unknown as AppStateService,
            mapViewStateFixture()
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(4, {mode2d: "wrong"}));
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
            {replaceSnapshotState} as unknown as AppStateService,
            mapViewStateFixture()
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, {marker: true}), "http://deck.test", {} as Window);
        fixture.dispatch({...request(2, {marker: true}), state: []});
        fixture.dispatch(request(3, {marker: true}));
        await flushMicrotasks();
        fixture.dispatch(request(4, {marker: false}), "http://other.test");
        fixture.dispatch({...request(5, {marker: false}), version: 1});
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
            {replaceSnapshotState} as unknown as AppStateService,
            mapViewStateFixture()
        );
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, {marker: false}));
        fixture.dispatch(request(2, {marker: true}));
        fixture.dispatch(request(3, {marker: false, numberOfViews: 2}));
        expect(replaceSnapshotState).toHaveBeenCalledTimes(1);

        finishFirst?.([]);
        await flushMicrotasks();

        expect(replaceSnapshotState).toHaveBeenCalledTimes(2);
        expect(replaceSnapshotState).toHaveBeenLastCalledWith({marker: false, numberOfViews: 2});
        const resultIds = fixture.parentPostMessage.mock.calls
            .map(([message]) => message as {type?: string; requestId?: number})
            .filter(message => message.type === PRESENTATION_BRIDGE_RESULT)
            .map(message => message.requestId);
        expect(resultIds).toEqual([1, 3]);
    });

    it("runs and cancels a validated presentation camera flight", () => {
        let animationFrame: FrameRequestCallback | undefined;
        const fixture = framedWindow();
        Object.assign(fixture.host, {
            performance: {now: () => 0},
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                animationFrame = callback;
                return 19;
            }),
            cancelAnimationFrame: vi.fn()
        });
        const next = vi.fn();
        const mapViewState = {
            presentationCameraViewStateTopic: {next}
        } as unknown as MapViewStateService;
        const service = new PresentationStateBridgeService(
            {replaceSnapshotState: vi.fn()} as unknown as AppStateService,
            mapViewState
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
                    {lon: 0, lat: 0, alt: 20, heading: 0, pitch: -0.2, roll: 0},
                    {lon: 10, lat: 4, alt: 20, heading: 0.4, pitch: -0.2, roll: 0}
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
                orientation: {heading: expect.closeTo(0.026689), pitch: -0.2, roll: 0},
                position: [0, 0, 0]
            }
        });
        animationFrame?.(5_000);

        expect(next).toHaveBeenCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: {lon: 5, lat: 2, alt: 20},
                orientation: {heading: expect.closeTo(0.2), pitch: -0.2, roll: 0},
                position: [0, 0, 0]
            }
        });
        animationFrame?.(11_000);
        expect(next).toHaveBeenLastCalledWith({
            targetView: 0,
            cameraViewData: {
                destination: {lon: 10, lat: 4, alt: 20},
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
                destination: {lon: 10, lat: 4, alt: 20},
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
