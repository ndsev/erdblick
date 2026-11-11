import {describe, expect, it} from "vitest";
import {buildMcpSetup, buildWebMcpSetup, mcpSetupAgents, mcpSetupPlatforms,
    type McpSetupAgent, type McpSetupPlatform} from "../../../app/action/mcp-client-setup.presentation";
import type {ViewerMcpInfo} from "../../../app/action/viewer-action-relay.contract";

const local: ViewerMcpInfo = {enabled: true, endpoint: "http://127.0.0.1:9017/mcp", authentication: "local", scopes: []};

/** Finds an independently inspectable piece of the recipe. */
function value(agent: McpSetupAgent, platform: McpSetupPlatform, id: string, info = local): string {
    return buildMcpSetup(info, platform, agent).fields.find(field => field.id === id)?.value ?? "";
}

describe("MCP client setup recipes", () => {
    it.each(mcpSetupPlatforms)("provides valid local setup for the tested surfaces on $label", ({value: platform}) => {
        expect(mcpSetupAgents.map(agent => agent.value)).toEqual([
            "codex-cli", "chatgpt-desktop", "claude-code", "claude-desktop",
            "cursor-cli", "cursor-ide", "copilot-cli", "vscode-copilot", "vibe-cli"
        ]);
        for (const agent of mcpSetupAgents) {
            const recipe = buildMcpSetup(local, platform, agent.value);
            expect(recipe.unavailable).toBeUndefined();
            expect(recipe.fields.find(field => field.id === "url")?.value).toBe(local.endpoint);
            expect(recipe.steps.length).toBeGreaterThan(0);
            expect(new URL(recipe.docsUrl).protocol).toBe("https:");
            if (agent.value === "vibe-cli") {
                expect(value(agent.value, platform, "add")).toBe(`vibe mcp add mapviewer --url '${local.endpoint}' --transport streamable-http --header 'X-Client=Vibe'`);
                expect(value(agent.value, platform, "verify")).toBe("/mcp mapviewer");
                expect(recipe.steps.join(" ")).toContain(platform === "windows" ? "%USERPROFILE%\\.vibe\\config.toml" : "~/.vibe/config.toml");
            }
            const json = recipe.fields.find(field => field.id === "config");
            if (json) {
                const config = JSON.parse(json.value);
                const server = (agent.value === "vscode-copilot" ? config.servers : config.mcpServers).mapviewer;
                if (agent.value === "claude-desktop") {
                    expect(server).toEqual({command: "npx", args: ["--yes", "mcp-remote@0.16.0", local.endpoint, "--transport", "http-only"]});
                } else {
                    expect(server.url).toBe(local.endpoint);
                    expect(server).not.toHaveProperty("oauth");
                }
            }
        }
    });

    it("uses configuration paths and shortcuts belonging to the selected platform", () => {
        expect(value("claude-desktop", "windows", "path")).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
        expect(value("claude-desktop", "macos", "path")).toBe("~/Library/Application Support/Claude/claude_desktop_config.json");
        expect(value("claude-desktop", "linux", "path")).toBe("~/.config/Claude/claude_desktop_config.json");
        expect(value("vscode-copilot", "windows", "path")).toBe("%APPDATA%\\Code\\User\\mcp.json");
        expect(value("vscode-copilot", "macos", "path")).toBe("~/Library/Application Support/Code/User/mcp.json");
        expect(value("vscode-copilot", "linux", "path")).toBe("~/.config/Code/User/mcp.json");
        expect(buildMcpSetup(local, "macos", "vscode-copilot").steps[0]).toContain("Cmd+Shift+P");
        expect(buildMcpSetup(local, "windows", "vscode-copilot").steps[0]).toContain("Ctrl+Shift+P");
        expect(value("claude-code", "linux", "add")).toContain("--transport http --scope user");
    });

    it.each(["javascript:alert(1)", "https://user:secret@example.com/mcp", "not a URL", "https://example.com/\nmcp"])("rejects unsafe endpoint %s", endpoint => {
        for (const agent of mcpSetupAgents) {
            const recipe = buildMcpSetup({...local, endpoint}, "linux", agent.value);
            expect(recipe.fields).toEqual([]);
            expect(recipe.unavailable).toBeTruthy();
        }
    });

    it("has no stale fields when the server is disabled", () => {
        expect(buildMcpSetup({enabled: false}, "linux", "codex-cli").fields).toEqual([]);
    });
});

describe("OAuth setup preserves public metadata as data", () => {
    const oauth: ViewerMcpInfo = {enabled: true, endpoint: "https://example.com/mcp", authentication: "oauth",
        oauthClientId: "client'; echo unsafe; '$(`literal`)", scopes: ["viewer", "scope'quoted"]};

    it("uses distinct shell quoting and separate login commands", () => {
        expect(value("codex-cli", "linux", "add", oauth)).toContain("'client'\\''; echo unsafe; '\\''$(`literal`)'");
        expect(value("codex-cli", "windows", "add", oauth)).toContain("'client''; echo unsafe; ''$(`literal`)'");
        expect(value("codex-cli", "windows", "login", oauth)).toBe("codex mcp login mapviewer --scopes 'viewer,scope''quoted'");
        expect(value("codex-cli", "linux", "login", oauth)).toBe("codex mcp login mapviewer --scopes 'viewer,scope'\\''quoted'");
        expect(value("codex-cli", "windows", "add", oauth)).not.toContain("&&");
    });

    it("keeps Windows JSON out of native command arguments and makes its scope explicit", () => {
        const claude = JSON.parse(value("claude-code", "windows", "config", oauth));
        expect(claude.mcpServers.mapviewer).toEqual({type: "http", url: oauth.endpoint,
            oauth: {clientId: oauth.oauthClientId, scopes: oauth.scopes.join(" ")}});
        expect(value("claude-code", "windows", "path", oauth)).toBe(".mcp.json");
        expect(buildMcpSetup(oauth, "windows", "claude-code").steps[0]).toContain("project's .mcp.json");
        expect(value("claude-code", "windows", "add", oauth)).toBe("");
        expect(value("copilot-cli", "windows", "add", oauth)).toBe("copilot --additional-mcp-config '@mapviewer-mcp.json'");
        const copilot = JSON.parse(value("copilot-cli", "windows", "config", oauth));
        expect(copilot.mcpServers.mapviewer).toEqual({type: "http", url: oauth.endpoint, tools: ["*"],
            oauthClientId: oauth.oauthClientId, oauthScopes: oauth.scopes});
        expect(value("copilot-cli", "windows", "path", oauth)).toBe("mapviewer-mcp.json");
        expect(buildMcpSetup(oauth, "windows", "copilot-cli").steps.join(" ")).toContain("one Copilot session");
    });

    it.each([
        {scopes: ["viewer"], oauthClientId: "public-client"},
        {scopes: [], oauthClientId: "public-client"},
        {scopes: ["viewer"], oauthClientId: undefined},
        {scopes: [], oauthClientId: undefined}
    ])("omits absent values without inventing OAuth credentials: %j", metadata => {
        const info: ViewerMcpInfo = {...oauth, ...metadata};
        const claude = JSON.parse(value("claude-code", "windows", "config", info)).mcpServers.mapviewer;
        expect(claude.oauth?.clientId).toBe(metadata.oauthClientId);
        expect(claude.oauth?.scopes).toBe(metadata.scopes.length ? metadata.scopes.join(" ") : undefined);
        const copilot = JSON.parse(value("copilot-cli", "windows", "config", info)).mcpServers.mapviewer;
        expect(copilot.oauthClientId).toBe(metadata.oauthClientId);
        expect(copilot.oauthScopes).toEqual(metadata.oauthClientId && metadata.scopes.length ? metadata.scopes : undefined);
        expect(value("codex-cli", "linux", "login", info).includes("--scopes")).toBe(metadata.scopes.length > 0);
        expect(value("claude-code", "linux", "add", info)).toContain("claude mcp add-json --scope user");
    });

    it("does not offer a local-only bridge as an OAuth-qualified desktop setup", () => {
        expect(value("claude-desktop", "windows", "config", oauth)).toBe("");
        expect(buildMcpSetup(oauth, "windows", "claude-desktop").steps.join(" ")).toContain("OAuth");
        expect(value("claude-desktop", "windows", "client-id", oauth)).toBe(oauth.oauthClientId);
    });

    it("does not reuse Vibe's local authentication options for an OAuth deployment", () => {
        expect(value("vibe-cli", "linux", "add", oauth)).toBe("");
        expect(value("vibe-cli", "linux", "client-id", oauth)).toBe(oauth.oauthClientId);
        expect(buildMcpSetup(oauth, "linux", "vibe-cli").steps.join(" ")).toContain("OAuth setup needs separate verification");
    });
});

describe("WebMCP browser setup", () => {
    it.each(mcpSetupPlatforms)("uses the selected platform's browser shortcut on $label", ({value: platform}) => {
        const url = "http://localhost:8089/viewer/?v2=1&vid=left,right&lon=10,20#map";
        const recipe = buildWebMcpSetup(platform, "chatgpt-desktop", url);
        expect(recipe.fields).toEqual([{id: "viewer-url", label: "Current viewer URL", value: url}]);
        expect(recipe.steps[0]).toContain(platform === "macos" ? "Cmd+T" : "Ctrl+T");
        expect(recipe.steps.join(" ")).toContain("Site tools");
        expect(recipe.docsUrl).toBe("https://learn.chatgpt.com/docs/webmcp");
    });

    it.each(mcpSetupPlatforms)("shows Claude's Code browser shortcut on $label without claiming native WebMCP support", ({value: platform}) => {
        const recipe = buildWebMcpSetup(platform, "claude-desktop", "http://localhost:8089/");
        expect(recipe.steps[0]).toContain("Code session");
        expect(recipe.steps[0]).toContain(platform === "macos" ? "Cmd+Shift+B" : "Ctrl+Shift+B");
        expect(recipe.steps[0]).toContain("click Browser");
        expect(recipe.steps.join(" ")).toContain("if unavailable, choose Remote MCP");
        expect(recipe.docsUrl).toBe("https://code.claude.com/docs/en/desktop#browse-external-sites");
    });
});
