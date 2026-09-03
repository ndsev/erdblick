import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {AppStateService} from "./appstate.service";
import {
    PRESENTATION_BRIDGE_APPLY,
    PRESENTATION_BRIDGE_PROTOCOL_VERSION,
    PRESENTATION_BRIDGE_READY,
    PRESENTATION_BRIDGE_RESULT,
    PresentationStateBridgeService
} from "./presentation-state-bridge.service";

interface FramedWindowFixture {
    host: Window;
    parent: Window;
    parentPostMessage: ReturnType<typeof vi.fn>;
    dispatch(data: unknown, origin?: string, source?: MessageEventSource): void;
    removeEventListener: ReturnType<typeof vi.fn>;
}

/** Creates the small Window surface used by the opt-in bridge. */
function framedWindow(search = "?embed=presentation&v2=1"): FramedWindowFixture {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const parentPostMessage = vi.fn();
    const parent = {postMessage: parentPostMessage} as unknown as Window;
    const removeEventListener = vi.fn();
    const host = {
        parent,
        location: {search},
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

/** Creates one valid URL-state request. */
function request(requestId: number, search: string): Record<string, unknown> {
    return {
        type: PRESENTATION_BRIDGE_APPLY,
        version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
        requestId,
        search
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
        const stateService = {replaceUrlState: vi.fn()} as unknown as AppStateService;
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService(stateService);

        expect(service.initialize(fixture.host)).toBe(true);
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_READY,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION
        }, "*");

        service.ngOnDestroy();
        expect(fixture.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));

        const plainFrame = framedWindow("?v2=1");
        expect(new PresentationStateBridgeService(stateService).initialize(plainFrame.host)).toBe(false);

        const topLevel = framedWindow();
        Object.defineProperty(topLevel.host, "parent", {value: topLevel.host});
        expect(new PresentationStateBridgeService(stateService).initialize(topLevel.host)).toBe(false);
    });

    it("applies a valid opaque query and acknowledges the completed state", async () => {
        const replaceUrlState = vi.fn().mockResolvedValue(undefined);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService({replaceUrlState} as unknown as AppStateService);
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(
            7,
            "?embed=presentation&v2=1&n=2&m2d=1%2C0&l=&tag=one&tag=two"
        ));
        await flushMicrotasks();

        expect(replaceUrlState).toHaveBeenCalledWith({
            embed: "presentation",
            v2: "1",
            n: "2",
            m2d: "1,0",
            l: "",
            tag: ["one", "two"]
        });
        expect(fixture.parentPostMessage).toHaveBeenCalledWith({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 7,
            ok: true
        }, "http://deck.test");
    });

    it("rejects malformed input and ignores foreign sources or a changed parent origin", async () => {
        const replaceUrlState = vi.fn().mockResolvedValue(undefined);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService({replaceUrlState} as unknown as AppStateService);
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, "?embed=presentation&v2=1"), "http://deck.test", {} as Window);
        fixture.dispatch(request(2, "?embed=presentation&v2=0"));
        fixture.dispatch(request(3, "?embed=presentation&v2=1"));
        await flushMicrotasks();
        fixture.dispatch(request(4, "?embed=presentation&v2=1"), "http://other.test");
        fixture.dispatch({...request(5, "?embed=presentation&v2=1"), version: 2});
        await flushMicrotasks();

        expect(replaceUrlState).toHaveBeenCalledTimes(1);
        expect(fixture.parentPostMessage.mock.calls).toContainEqual([{
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId: 2,
            ok: false,
            error: "invalid-search"
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
        let finishFirst: (() => void) | undefined;
        const first = new Promise<void>(resolve => {
            finishFirst = resolve;
        });
        const replaceUrlState = vi.fn()
            .mockImplementationOnce(() => first)
            .mockResolvedValue(undefined);
        const fixture = framedWindow();
        const service = new PresentationStateBridgeService({replaceUrlState} as unknown as AppStateService);
        service.initialize(fixture.host);
        fixture.parentPostMessage.mockClear();

        fixture.dispatch(request(1, "?embed=presentation&v2=1&n=1"));
        fixture.dispatch(request(2, "?embed=presentation&v2=1&n=2"));
        fixture.dispatch(request(3, "?embed=presentation&v2=1&n=3"));
        expect(replaceUrlState).toHaveBeenCalledTimes(1);

        finishFirst?.();
        await flushMicrotasks();

        expect(replaceUrlState).toHaveBeenCalledTimes(2);
        expect(replaceUrlState).toHaveBeenLastCalledWith(expect.objectContaining({n: "3"}));
        const resultIds = fixture.parentPostMessage.mock.calls
            .map(([message]) => message as {type?: string; requestId?: number})
            .filter(message => message.type === PRESENTATION_BRIDGE_RESULT)
            .map(message => message.requestId);
        expect(resultIds).toEqual([1, 3]);
    });
});
