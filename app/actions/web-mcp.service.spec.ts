import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {WebMcpService} from "./web-mcp.service";
import {viewerActions} from "./viewer-action.contract";
import {ViewerActionFailure} from "./viewer-action-relay.contract";

type Tool = {
    name: string; inputSchema: Record<string, unknown>;
    execute: (input: Record<string, unknown>, options: {signal: AbortSignal}) => Promise<unknown>;
};

/** Simulate registration ownership without replacing any viewer tool handler. */
function fixture(supported = true) {
    const tools = new Map<string, Tool>();
    const registerTool = vi.fn(async (tool: Tool, {signal}: {signal: AbortSignal}) => {
        signal.throwIfAborted();
        if (tools.has(tool.name)) throw new Error("Duplicate tool");
        tools.set(tool.name, tool);
        signal.addEventListener("abort", () => tools.delete(tool.name), {once: true});
    });
    Object.defineProperty(document, "modelContext", {value: supported ? {registerTool} : undefined, configurable: true});
    const actions = {invokeLocal: vi.fn().mockResolvedValue({status: "applied"})};
    const zone = {run: (fn: () => unknown) => fn(), runOutsideAngular: (fn: () => unknown) => fn()};
    const service = new WebMcpService(actions as never, zone as never);
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {tools: [{
            name: "mapget_list_sources", description: "List maps", inputSchema: {type: "object"}, annotations: {readOnlyHint: true}
        }]}}), {headers: {"Content-Type": "application/json"}});
    });
    vi.stubGlobal("fetch", fetchMock);
    return {service, tools, actions, registerTool, fetchMock};
}

describe("WebMcpService", () => {
    const services: WebMcpService[] = [];
    afterEach(() => {
        services.splice(0).forEach(service => service.ngOnDestroy());
        Reflect.deleteProperty(document, "modelContext");
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    /** Start a fresh document owner and ensure cleanup even when assertions fail. */
    function start(supported = true) {
        const value = fixture(supported);
        services.push(value.service);
        value.service.initialize();
        return value;
    }

    it("registers every current-tab action and native tool without session routing", async () => {
        const {service, tools, actions, fetchMock} = start();
        await vi.waitFor(() => expect(service.status$.value.mapgetTools).toBe(1));
        expect([...tools.keys()].sort()).toEqual([...Object.keys(viewerActions), "mapget_list_sources"].sort());
        expect(tools.has("viewer_list_sessions")).toBe(false);
        const input = {targets: []};
        await tools.get("viewer_get_app_state")!.execute(input, {signal: new AbortController().signal});
        expect(actions.invokeLocal).toHaveBeenCalledWith("viewer_get_app_state", input, expect.any(AbortSignal));
        const [url, request] = fetchMock.mock.calls[0];
        expect(url.pathname).toMatch(/\/mcp\/browser$/);
        expect(request.credentials).toBe("same-origin");
        expect(request.redirect).toBe("error");
        service.initialize();
        expect(tools.size).toBe(Object.keys(viewerActions).length + 1);
        service.ngOnDestroy();
        expect(tools.size).toBe(0);
    });

    it("leaves unsupported browsers unchanged", () => {
        const {tools, fetchMock} = start(false);
        expect(tools.size).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves current-tab tools when backend discovery is denied", async () => {
        const {service, fetchMock, tools} = fixture();
        services.push(service);
        fetchMock.mockResolvedValue(new Response("", {status: 403}));
        service.initialize();
        await vi.waitFor(() => expect(service.status$.value.message).toContain("login required"));
        expect(tools.size).toBe(Object.keys(viewerActions).length);
    });

    it("returns structured action failures without losing outcome semantics", async () => {
        const {service, tools, actions} = start();
        await vi.waitFor(() => expect(service.status$.value.mapgetTools).toBe(1));
        const detail = {code: "busy", message: "Human gesture", outcome: "not_applied"} as const;
        actions.invokeLocal.mockRejectedValue(new ViewerActionFailure(detail));
        expect(await tools.get("viewer_navigate")!.execute({}, {signal: new AbortController().signal}))
            .toEqual({isError: true, error: detail});
    });

    it("reads finite SSE native results and forwards browser cancellation", async () => {
        const {service, tools, fetchMock} = start();
        await vi.waitFor(() => expect(service.status$.value.mapgetTools).toBe(1));
        fetchMock.mockImplementation(async (_url, init) => {
            const request = JSON.parse(String(init.body));
            return new Response(`: heartbeat\r\n\r\nevent: message\r\ndata: ${JSON.stringify({jsonrpc: "2.0", id: request.id,
                result: {isError: false, structuredContent: {items: []}}})}\r\n\r\n`, {headers: {"Content-Type": "text/event-stream"}});
        });
        const controller = new AbortController();
        expect(await tools.get("mapget_list_sources")!.execute({}, {signal: controller.signal}))
            .toMatchObject({isError: false, structuredContent: {items: []}});
        const signal = fetchMock.mock.calls.at(-1)![1].signal!;
        controller.abort();
        expect(signal.aborted).toBe(true);
    });

    it("rejects mismatched replies, HTML login pages and oversized responses", async () => {
        const {service, tools, fetchMock} = start();
        await vi.waitFor(() => expect(service.status$.value.mapgetTools).toBe(1));
        for (const response of [
            new Response('{"jsonrpc":"2.0","id":-1,"result":{}}', {headers: {"Content-Type": "application/json"}}),
            new Response("login", {headers: {"Content-Type": "text/html"}}),
            new Response("x".repeat(4 * 1024 * 1024 + 1), {headers: {"Content-Type": "application/json"}})
        ]) {
            fetchMock.mockResolvedValueOnce(response);
            await expect(tools.get("mapget_list_sources")!.execute({}, {signal: new AbortController().signal})).rejects.toThrow();
        }
    });

    it("cleans up a partial registration failure without clearing another owner's tools", async () => {
        const {service, tools, registerTool} = fixture();
        services.push(service);
        tools.set("other_app_tool", {name: "other_app_tool", inputSchema: {}, execute: async () => 1});
        registerTool.mockRejectedValueOnce(new Error("Registration denied"));
        service.initialize();
        await vi.waitFor(() => expect(service.status$.value.message).toBe("WebMCP registration failed"));
        expect([...tools.keys()]).toEqual(["other_app_tool"]);
    });
});
