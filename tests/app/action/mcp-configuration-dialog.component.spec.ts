import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {McpConfigurationDialogComponent} from "../../../app/action/mcp-configuration-dialog.component";
import type {ViewerMcpInfo} from "../../../app/action/viewer-action-relay.contract";

/** Keeps presentation tests independent of the remote action transport. */
function setup() {
    const clipboard = {copyToClipboard: vi.fn()};
    const actions: {connectionInfo: ViewerMcpInfo} = {connectionInfo: {
        enabled: true, endpoint: "http://localhost:8099/mcp", authentication: "local", scopes: []
    }};
    const urlState = {currentUrl: "http://localhost:8099/viewer/?v2=1&vid=left,right&lon=10,20#map"};
    const ui = new McpConfigurationDialogComponent(actions as never, clipboard as never, urlState as never);
    ui.open();
    return {ui, clipboard, actions, urlState};
}

describe("MCP configuration progression", () => {
    it("reveals stages, retains choices across platforms and resets them on reopening", () => {
        const {ui} = setup();
        expect(ui.visible).toBe(true);
        expect(ui.selectedPlatform).toBeNull();
        expect(ui.setupRecipe).toBeNull();
        ui.selectPlatform("linux");
        expect(ui.selectedAgent).toBeNull();
        ui.selectAgent("claude-desktop");
        expect(ui.needsConnectionChoice).toBe(true);
        expect(ui.setupRecipe).toBeNull();
        ui.selectedConnection = "remote";
        expect(ui.setupRecipe?.fields.some(field => field.id === "config")).toBe(true);
        ui.selectPlatform("windows");
        expect(ui.selectedAgent).toBe("claude-desktop");
        expect(ui.selectedConnection).toBe("remote");
        expect(ui.setupRecipe?.fields.find(field => field.id === "path")?.value).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
        ui.selectPlatform("windows");
        expect(ui.selectedAgent).toBe("claude-desktop");
        expect(ui.selectedConnection).toBe("remote");
        ui.selectAgent("chatgpt-desktop");
        expect(ui.selectedConnection).toBeNull();
        expect(ui.setupRecipe).toBeNull();
        ui.selectAgent("codex-cli");
        expect(ui.needsConnectionChoice).toBe(false);
        expect(ui.setupRecipe?.fields.some(field => field.id === "add")).toBe(true);
        ui.selectPlatform("linux");
        expect(ui.selectedAgent).toBe("codex-cli");
        expect(ui.setupRecipe?.fields.find(field => field.id === "verify")?.label).toBe("Verify · Terminal");
        ui.selectAgent("cursor-ide");
        ui.open();
        expect(ui.selectedPlatform).toBeNull();
        expect(ui.selectedAgent).toBeNull();
        expect(ui.selectedConnection).toBeNull();
    });

    it("copies only the selected field with current connection metadata", () => {
        const {ui, clipboard, actions} = setup();
        ui.selectPlatform("linux");
        ui.selectAgent("codex-cli");
        ui.copyField("add");
        expect(clipboard.copyToClipboard).toHaveBeenLastCalledWith("codex mcp add mapviewer --url 'http://localhost:8099/mcp'");
        actions.connectionInfo = {enabled: true, endpoint: "http://127.0.0.1:9017/mcp", authentication: "local", scopes: []};
        ui.selectAgent("cursor-ide");
        ui.selectPlatform("windows");
        ui.copyField("config");
        expect(JSON.parse(clipboard.copyToClipboard.mock.lastCall![0])).toEqual({
            mcpServers: {mapviewer: {url: "http://127.0.0.1:9017/mcp"}}
        });
        expect(ui.setupRecipe?.fields.find(field => field.id === "path")?.value).toContain("%USERPROFILE%");
        ui.copyField("add");
        expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(2);
    });

    it("does not copy a disabled or invalid remote endpoint", () => {
        const {ui, clipboard, actions} = setup();
        ui.selectPlatform("linux");
        ui.selectAgent("codex-cli");
        actions.connectionInfo = {enabled: false};
        ui.copyField("url");
        actions.connectionInfo = {enabled: true, endpoint: "javascript:alert(1)", authentication: "local", scopes: []};
        ui.copyField("add");
        expect(ui.setupRecipe?.unavailable).toBeTruthy();
        expect(clipboard.copyToClipboard).not.toHaveBeenCalled();
    });

    it("copies the latest route verbatim even without remote MCP, and retires it when switching mode", () => {
        const {ui, clipboard, actions, urlState} = setup();
        actions.connectionInfo = {enabled: false};
        ui.selectPlatform("macos");
        ui.selectAgent("chatgpt-desktop");
        ui.selectedConnection = "webmcp";
        ui.copyField("viewer-url");
        expect(clipboard.copyToClipboard).toHaveBeenLastCalledWith(urlState.currentUrl);
        ui.selectPlatform("windows");
        expect(ui.selectedAgent).toBe("chatgpt-desktop");
        expect(ui.selectedConnection).toBe("webmcp");
        expect(ui.setupRecipe?.steps[0]).toContain("Ctrl+T");
        urlState.currentUrl = "https://example.com/maps/?v2=1&vid=left,right&lon=30,40&custom=kept#selection";
        ui.copyField("viewer-url");
        expect(clipboard.copyToClipboard).toHaveBeenLastCalledWith(urlState.currentUrl);
        ui.selectedConnection = "remote";
        ui.copyField("viewer-url");
        expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(2);
        expect(ui.setupRecipe?.unavailable).toBeTruthy();
    });
});
