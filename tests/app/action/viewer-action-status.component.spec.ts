import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {BehaviorSubject} from "rxjs";
import {ViewerActionStatusComponent} from "../../../app/action/viewer-action-status.component";
import type {ViewerMcpInfo} from "../../../app/action/viewer-action-relay.contract";

/** Constructs only the fixed command formatter; never launches a client or changes its config. */
function component(info: ViewerMcpInfo, clipboard = {copyToClipboard: vi.fn()}) {
    return new ViewerActionStatusComponent({connectionInfo: info} as never, clipboard as never, {} as never);
}

describe("MCP activity indicator", () => {
    it.each([
        {enabled: true, ready: true, viewerTools: 0, active: false, severity: "secondary"},
        {enabled: true, ready: true, viewerTools: 0, active: true, severity: "success"},
        {enabled: true, ready: false, viewerTools: 0, active: false, severity: "danger"},
        {enabled: true, ready: false, viewerTools: 1, active: true, severity: "danger"},
        {enabled: false, ready: false, viewerTools: 1, active: false, severity: "secondary"},
        {enabled: false, ready: false, viewerTools: 1, active: true, severity: "success"},
        {enabled: false, ready: false, viewerTools: 0, active: false, severity: "danger"}
    ])("shows $severity for backend enabled=$enabled ready=$ready, WebMCP tools=$viewerTools, pending=$active", ({enabled, ready, viewerTools, active, severity}) => {
        const ui = new ViewerActionStatusComponent(
            {availability$: new BehaviorSubject({enabled, ready}), hasPendingAction: active} as never,
            {copyToClipboard: vi.fn()} as never,
            {status$: new BehaviorSubject({viewerTools})} as never
        );
        expect(ui.buttonSeverity).toBe(severity);
    });
});

describe("MCP connection copy commands", () => {
    it("uses no OAuth flags for a local deployment", () => {
        const ui = component({enabled: true, endpoint: "http://localhost:8099/mcp", authentication: "local", scopes: []});
        expect(ui.connectionText("codex")).toBe("codex mcp add mapviewer --url 'http://localhost:8099/mcp'");
        expect(ui.connectionText("claude")).toBe("claude mcp add --transport http mapviewer 'http://localhost:8099/mcp'");
        expect(ui.connectionText("copilot")).toBe("copilot mcp add --transport http mapviewer 'http://localhost:8099/mcp'");
    });

    it.each([
        {scopes: ["viewer"], codexScopes: "viewer", claudeScopes: "viewer"},
        {scopes: ["viewer", "tiles:read"], codexScopes: "viewer,tiles:read", claudeScopes: "viewer tiles:read"}
    ])("includes client-specific login with scopes $scopes", ({scopes, codexScopes, claudeScopes}) => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes, oauthClientId: "public-viewer-client"});
        expect(ui.connectionText("codex")).toBe(
            "codex mcp add mapviewer --url 'https://example.com/mcp' --oauth-client-id 'public-viewer-client' &&\n" +
            `codex mcp login mapviewer --scopes '${codexScopes}'`
        );
        expect(ui.connectionText("claude")).toBe(
            `claude mcp add-json mapviewer '{"type":"http","url":"https://example.com/mcp","oauth":{"clientId":"public-viewer-client","scopes":"${claudeScopes}"}}' &&\n` +
            "claude mcp login mapviewer"
        );
    });

    it("allows OAuth discovery without a pre-registered client", () => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: ["viewer"]});
        expect(ui.connectionText("codex")).toBe(
            "codex mcp add mapviewer --url 'https://example.com/mcp' &&\ncodex mcp login mapviewer --scopes 'viewer'"
        );
        expect(ui.connectionText("claude")).toBe(
            'claude mcp add-json mapviewer \'{"type":"http","url":"https://example.com/mcp","oauth":{"scopes":"viewer"}}\' &&\nclaude mcp login mapviewer'
        );
    });

    it("still logs in with OAuth when no scopes or public client are specified", () => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: []});
        expect(ui.connectionText("codex")).toBe("codex mcp add mapviewer --url 'https://example.com/mcp' &&\ncodex mcp login mapviewer");
        expect(ui.connectionText("claude")).toBe(
            'claude mcp add-json mapviewer \'{"type":"http","url":"https://example.com/mcp"}\' &&\nclaude mcp login mapviewer'
        );
    });

    it("omits empty scopes while retaining a pre-registered public client", () => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: [], oauthClientId: "public-viewer-client"});
        expect(ui.connectionText("codex")).toBe(
            "codex mcp add mapviewer --url 'https://example.com/mcp' --oauth-client-id 'public-viewer-client' &&\ncodex mcp login mapviewer"
        );
        expect(ui.connectionText("claude")).toBe(
            'claude mcp add-json mapviewer \'{"type":"http","url":"https://example.com/mcp","oauth":{"clientId":"public-viewer-client"}}\' &&\nclaude mcp login mapviewer'
        );
    });

    it("quotes public client IDs and scopes as data, never shell syntax", () => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: ["scope'quoted"], oauthClientId: "client'; echo unsafe; '"});
        expect(ui.connectionText("codex")).toBe(
            "codex mcp add mapviewer --url 'https://example.com/mcp' --oauth-client-id 'client'\\''; echo unsafe; '\\''' &&\n" +
            "codex mcp login mapviewer --scopes 'scope'\\''quoted'"
        );
        expect(ui.connectionText("claude")).toBe(
            "claude mcp add-json mapviewer '{\"type\":\"http\",\"url\":\"https://example.com/mcp\",\"oauth\":{\"clientId\":\"client'\\''; echo unsafe; '\\''\",\"scopes\":\"scope'\\''quoted\"}}' &&\n" +
            "claude mcp login mapviewer"
        );
        expect(ui.connectionText("copilot")).toBe(
            "# Session-only MCP setup; sign in with /mcp auth mapviewer inside Copilot.\n" +
            "copilot --additional-mcp-config '{\"mcpServers\":{\"mapviewer\":{\"type\":\"http\",\"url\":\"https://example.com/mcp\",\"tools\":[\"*\"],\"oauthClientId\":\"client'\\''; echo unsafe; '\\''\",\"oauthScopes\":[\"scope'\\''quoted\"]}}}'"
        );
    });

    it.each([
        {scopes: ["viewer", "tiles:read"], oauthClientId: "public-client", expected: {oauthClientId: "public-client", oauthScopes: ["viewer", "tiles:read"]}},
        {scopes: [], oauthClientId: "public-client", expected: {oauthClientId: "public-client"}},
        {scopes: ["viewer"], oauthClientId: undefined, expected: {}},
        {scopes: [], oauthClientId: undefined, expected: {}}
    ])("configures Copilot OAuth for one session with client $oauthClientId and scopes $scopes", ({scopes, oauthClientId, expected}) => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes, oauthClientId});
        const config = {mcpServers: {mapviewer: {type: "http", url: "https://example.com/mcp", tools: ["*"], ...expected}}};
        expect(ui.connectionText("copilot")).toBe(
            "# Session-only MCP setup; sign in with /mcp auth mapviewer inside Copilot.\n" +
            `copilot --additional-mcp-config '${JSON.stringify(config)}'`
        );
    });

    it.each(["codex", "claude", "copilot"] as const)("copies the complete %s setup snippet", kind => {
        const clipboard = {copyToClipboard: vi.fn()};
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: ["viewer"]}, clipboard);
        ui.copy(kind);
        expect(clipboard.copyToClipboard).toHaveBeenCalledExactlyOnceWith(ui.connectionText(kind));
    });

    it.each(["javascript:alert(1)", "https://user:secret@example.com/mcp", "not a URL"])("does not copy an unsafe endpoint: %s", endpoint => {
        const clipboard = {copyToClipboard: vi.fn()};
        const ui = component({enabled: true, endpoint, authentication: "oauth", scopes: ["viewer"]}, clipboard);
        expect(ui.connectionText("codex")).toBe("");
        expect(ui.connectionText("claude")).toBe("");
        expect(ui.connectionText("copilot")).toBe("");
        ui.copy("codex");
        ui.copy("claude");
        ui.copy("copilot");
        expect(clipboard.copyToClipboard).not.toHaveBeenCalled();
    });

    it("does not copy commands when MCP is disabled", () => {
        const clipboard = {copyToClipboard: vi.fn()};
        const ui = component({enabled: false}, clipboard);
        expect(ui.connectionText("codex")).toBe("");
        expect(ui.connectionText("claude")).toBe("");
        expect(ui.connectionText("copilot")).toBe("");
        ui.copy("codex");
        ui.copy("claude");
        ui.copy("copilot");
        expect(clipboard.copyToClipboard).not.toHaveBeenCalled();
    });
});
