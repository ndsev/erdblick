import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {ViewerActionStatusComponent} from "./viewer-action-status.component";
import type {ViewerMcpInfo} from "./viewer-action-relay.contract";

/** Constructs only the fixed command formatter; never launches a client or changes its config. */
function component(info: ViewerMcpInfo) {
    return new ViewerActionStatusComponent({connectionInfo: info} as never, {copyToClipboard: vi.fn()} as never);
}

describe("MCP connection copy commands", () => {
    it("uses no OAuth flags for a local deployment", () => {
        const ui = component({enabled: true, endpoint: "http://localhost:8099/mcp", authentication: "local", scopes: []});
        expect(ui.connectionText("codex")).toBe("codex mcp add mapviewer --url 'http://localhost:8099/mcp'");
        expect(ui.connectionText("claude")).toBe("claude mcp add --transport http mapviewer 'http://localhost:8099/mcp'");
    });

    it("quotes a pre-registered public client as data, never shell syntax", () => {
        const ui = component({enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth", scopes: [], oauthClientId: "client'; echo unsafe; '"});
        expect(ui.connectionText("codex")).toBe("codex mcp add mapviewer --url 'https://example.com/mcp' --oauth-client-id 'client'\\''; echo unsafe; '\\''' ".trimEnd());
        expect(ui.connectionText("claude")).toContain("--client-id 'client'\\''; echo unsafe; '\\''' ");
    });

    it.each(["javascript:alert(1)", "https://user:secret@example.com/mcp", "not a URL"])("does not copy an unsafe endpoint: %s", endpoint => {
        const ui = component({enabled: true, endpoint, authentication: "local", scopes: []});
        expect(ui.connectionText("url")).toBe("");
        expect(ui.connectionText("codex")).toBe("");
    });
});
