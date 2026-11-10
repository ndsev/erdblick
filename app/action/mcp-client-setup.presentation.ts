import type {ViewerMcpInfo} from "./viewer-action-relay.contract";

export type McpSetupPlatform = "windows" | "macos" | "linux";
export type McpSetupConnection = "remote" | "webmcp";
export type McpSetupBrowserAgent = "chatgpt-desktop" | "claude-desktop";
export type McpSetupAgent = "codex-cli" | "chatgpt-desktop" | "claude-code" | "claude-desktop" |
    "cursor-cli" | "cursor-ide" | "copilot-cli" | "vscode-copilot" | "vibe-cli";

export const mcpSetupPlatforms: {label: string; value: McpSetupPlatform}[] = [
    {label: "Windows", value: "windows"}, {label: "macOS", value: "macos"}, {label: "Linux", value: "linux"}
];

// Keep the surface names explicit: a CLI pass does not qualify a desktop/cloud client.
export const mcpSetupAgents: {label: string; value: McpSetupAgent; docsUrl: string}[] = [
    {label: "Codex CLI", value: "codex-cli", docsUrl: "https://learn.chatgpt.com/docs/extend/mcp"},
    {label: "ChatGPT App", value: "chatgpt-desktop", docsUrl: "https://learn.chatgpt.com/docs/extend/mcp"},
    {label: "Claude Code", value: "claude-code", docsUrl: "https://code.claude.com/docs/en/mcp"},
    {label: "Claude App", value: "claude-desktop", docsUrl: "https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop"},
    {label: "Cursor CLI", value: "cursor-cli", docsUrl: "https://cursor.com/docs/cli/mcp"},
    {label: "Cursor IDE", value: "cursor-ide", docsUrl: "https://cursor.com/docs/mcp"},
    {label: "Copilot CLI", value: "copilot-cli", docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers"},
    {label: "VS Code", value: "vscode-copilot", docsUrl: "https://code.visualstudio.com/docs/agent-customization/mcp-servers"},
    {label: "Vibe CLI", value: "vibe-cli", docsUrl: "https://docs.mistral.ai/vibe/code/cli/mcp-servers"}
];

/** One copyable value; instructions never become part of a copied command or JSON document. */
export interface McpSetupField {
    id: string;
    label: string;
    value: string;
    multiline?: boolean;
}

/** Presentation-only recipe derived from public server metadata and the selected client surface. */
export interface McpSetupRecipe {
    fields: McpSetupField[];
    steps: string[];
    docsUrl: string;
    unavailable?: string;
}

export const mcpSetupConnections: {label: string; value: McpSetupConnection}[] = [
    {label: "Remote MCP", value: "remote"}, {label: "WebMCP", value: "webmcp"}
];

/** Only the two app surfaces offer browser setup alongside their existing remote connection. */
export function isMcpBrowserAgent(agent: McpSetupAgent | null): agent is McpSetupBrowserAgent {
    return agent === "chatgpt-desktop" || agent === "claude-desktop";
}

/** Uses the current shareable page address; WebMCP registration belongs to the destination browser. */
export function buildWebMcpSetup(platform: McpSetupPlatform, agent: McpSetupBrowserAgent, viewerUrl: string): McpSetupRecipe {
    const chatgpt = agent === "chatgpt-desktop";
    return {
        fields: [{id: "viewer-url", label: "Current viewer URL", value: viewerUrl}],
        steps: chatgpt ? [
            `In ChatGPT App, open New tab (${platform === "macos" ? "Cmd+T" : "Ctrl+T"}) and paste the viewer URL into the built-in browser.`,
            "In Settings → Browser → Permissions, enable Site tools and allow access for this viewer when prompted.",
            "Check Site tools → Available site tools in the browser address bar, then ask ChatGPT to use MapViewer. Keep the viewer tab open."
        ] : [
            `In Claude App, open a Code session. Press ${platform === "macos" ? "Cmd+Shift+B" : "Ctrl+Shift+B"} or click Browser in the session's title bar.`,
            "Paste the viewer URL into the Browser pane's address bar. Keep the app and viewer tab open.",
            "Check the viewer's MCP status for WebMCP ready. This requires WebMCP support in Claude's browser; if unavailable, choose Remote MCP."
        ],
        docsUrl: chatgpt ? "https://learn.chatgpt.com/docs/webmcp"
            : "https://code.claude.com/docs/en/desktop#browse-external-sites"
    };
}

/** Quotes a single argument as data for PowerShell or POSIX shells, never as shell syntax. */
function quoteArgument(value: string, platform: McpSetupPlatform): string {
    return `'${value.replaceAll("'", platform === "windows" ? "''" : "'\\''")}'`;
}

/** Builds only known client recipes; endpoint and public OAuth metadata are data, not templates. */
export function buildMcpSetup(info: ViewerMcpInfo, platform: McpSetupPlatform, agent: McpSetupAgent): McpSetupRecipe {
    const recipe: McpSetupRecipe = {fields: [], steps: [], docsUrl: mcpSetupAgents.find(item => item.value === agent)!.docsUrl};
    if (!info.enabled) return {...recipe, unavailable: "Enable the server's MCP endpoint to configure an agent."};
    let endpoint: URL;
    try { endpoint = new URL(info.endpoint); }
    catch { return {...recipe, unavailable: "The server did not provide a valid HTTP MCP URL."}; }
    const hasControlCharacter = [...info.endpoint].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || hasControlCharacter) {
        return {...recipe, unavailable: "The server did not provide a valid HTTP MCP URL."};
    }
    const url = endpoint.href;
    const quote = (value: string) => quoteArgument(value, platform);
    const shell = platform === "windows" ? "PowerShell" : "Terminal";
    const oauth = info.authentication === "oauth" ? info : undefined;
    recipe.fields.push({id: "url", label: "Server URL", value: url});

    /** Adds a command independently so failed setup cannot accidentally run a subsequent login. */
    const command = (id: string, label: string, value: string, multiline = true) => recipe.fields.push({id, label: `${label} · ${shell}`, value, multiline});
    /** Shows a mergeable JSON document and its destination rather than a destructive file-writing command. */
    const config = (file: string, value: unknown) => {
        recipe.fields.push({id: "path", label: "Configuration file", value: file},
            {id: "config", label: "JSON configuration", value: JSON.stringify(value, null, 2), multiline: true});
    };

    if (agent === "codex-cli") {
        command("add", "Add server", `codex mcp add mapviewer --url ${quote(url)}${oauth?.oauthClientId ? ` --oauth-client-id ${quote(oauth.oauthClientId)}` : ""}`);
        if (oauth) command("login", "Sign in after adding", `codex mcp login mapviewer${oauth.scopes.length ? ` --scopes ${quote(oauth.scopes.join(","))}` : ""}`);
        command("verify", "Verify", "codex mcp get mapviewer", false);
        recipe.steps = ["Run the add command once, then restart your Codex conversation.",
            "Use /mcp to check MapViewer. Leave this viewer tab open for map actions."];
    } else if (agent === "claude-code") {
        if (oauth) {
            const server = {type: "http", url, oauth: oauth.oauthClientId || oauth.scopes.length ? {
                clientId: oauth.oauthClientId, scopes: oauth.scopes.length ? oauth.scopes.join(" ") : undefined
            } : undefined};
            if (platform === "windows") {
                // Avoid PowerShell/native-executable JSON argument conversion. The scope is explicit.
                config(".mcp.json", {mcpServers: {mapviewer: server}});
                recipe.steps.push("Merge this entry into the project's .mcp.json, then approve that project server in Claude Code.");
            } else {
                command("add", "Add server", `claude mcp add-json --scope user mapviewer ${quote(JSON.stringify(server))}`);
            }
            command("login", "Sign in after setup", "claude mcp login mapviewer");
        } else command("add", "Add server", `claude mcp add --transport http --scope user mapviewer ${quote(url)}`);
        command("verify", "Verify", "claude mcp get mapviewer", false);
        recipe.steps.push("Restart the conversation and inspect /mcp. User scope applies across projects; file configuration applies to that project.",
            "Sign in to Claude if needed, and leave this viewer tab open.");
    } else if (agent === "copilot-cli") {
        if (oauth) {
            const servers = {mcpServers: {mapviewer: {type: "http", url, tools: ["*"],
                oauthClientId: oauth.oauthClientId,
                oauthScopes: oauth.oauthClientId && oauth.scopes.length ? oauth.scopes : undefined}}};
            if (platform === "windows") {
                config("mapviewer-mcp.json", servers);
                command("add", "Start this session", "copilot --additional-mcp-config '@mapviewer-mcp.json'");
            } else command("add", "Start this session", `copilot --additional-mcp-config ${quote(JSON.stringify(servers))}`);
            recipe.steps = [...(platform === "windows" ? ["Save this JSON as mapviewer-mcp.json in the session's working folder, then run the start command."] : []),
                "This OAuth setup applies to one Copilot session; it does not replace your saved MCP configuration.",
                "Run /mcp auth mapviewer inside Copilot, then check /mcp."];
        } else {
            command("add", "Add server", `copilot mcp add --transport http mapviewer ${quote(url)}`);
            command("verify", "Verify", "copilot mcp list", false);
            recipe.steps = ["Run the add command once and open a fresh Copilot conversation.",
                "Sign in if needed. Check MapViewer in /mcp and leave this viewer tab open."];
        }
    } else if (oauth) {
        // These surfaces were qualified against local mode only. Do not invent an OAuth bridge recipe.
        if (oauth.oauthClientId) recipe.fields.push({id: "client-id", label: "Public OAuth client ID", value: oauth.oauthClientId});
        if (oauth.scopes.length) recipe.fields.push({id: "scopes", label: "Required OAuth scopes", value: oauth.scopes.join(" ")});
        recipe.steps = ["This server requires OAuth. Follow the provider's full configuration instructions for this endpoint and sign in.",
            "The quick setup for this client was verified with local MCP; its OAuth setup needs separate verification."];
    } else if (agent === "vibe-cli") {
        command("add", "Add server", `vibe mcp add mapviewer --url ${quote(url)} --transport streamable-http --header ${quote("X-Client=Vibe")}`);
        recipe.fields.push({id: "verify", label: "Check tools inside Vibe", value: "/mcp mapviewer"});
        const file = platform === "windows" ? "%USERPROFILE%\\.vibe\\config.toml" : "~/.vibe/config.toml";
        recipe.steps = [`Run the add command once. It saves MapViewer in your user configuration (${file}).`,
            "This local setup needs no MCP credentials; keep the X-Client option.",
            "Start a fresh Vibe session, check /mcp mapviewer and approve tools when asked. Leave this viewer tab open."];
    } else if (agent === "chatgpt-desktop") {
        recipe.steps = [`Open Settings (${platform === "macos" ? "Cmd+," : "Ctrl+,"}) → MCP servers → Add server.`,
            "Name it mapviewer, choose Streamable HTTP and paste the server URL.",
            "Save, select Restart, then check /mcp in a fresh local chat."];
    } else if (agent === "claude-desktop") {
        const file = platform === "windows" ? "%APPDATA%\\Claude\\claude_desktop_config.json"
            : platform === "macos" ? "~/Library/Application Support/Claude/claude_desktop_config.json"
                : "~/.config/Claude/claude_desktop_config.json";
        config(file, {mcpServers: {mapviewer: {command: "npx",
            args: ["--yes", "mcp-remote@0.16.0", url, "--transport", "http-only"]}}});
        recipe.steps = ["Make Node.js and npx available to the desktop app. Merge this entry with existing mcpServers.",
            "Use the config location exposed by your installation if it differs; set an absolute command/PATH if npx cannot be found.",
            "Fully quit and reopen Claude Desktop, then enable MapViewer's tools in a fresh chat."];
    } else if (agent === "cursor-cli" || agent === "cursor-ide") {
        config(platform === "windows" ? "%USERPROFILE%\\.cursor\\mcp.json" : "~/.cursor/mcp.json",
            {mcpServers: {mapviewer: {url}}});
        recipe.steps = ["Merge this entry into your user config; keep other servers. For one project, use .cursor/mcp.json instead."];
        if (agent === "cursor-cli") {
            command("verify", "Verify", "agent mcp list-tools mapviewer", false);
            recipe.steps.push("Run agent mcp enable mapviewer, then start a fresh conversation. Some installations name the command cursor-agent.");
        } else recipe.steps.push("Open Customize → MCP, enable MapViewer and inspect its tools. Start a fresh local Agent chat.");
        recipe.steps.push("Approve the requested tools and leave this viewer tab open.");
    } else {
        const file = platform === "windows" ? "%APPDATA%\\Code\\User\\mcp.json"
            : platform === "macos" ? "~/Library/Application Support/Code/User/mcp.json"
                : "~/.config/Code/User/mcp.json";
        config(file, {servers: {mapviewer: {type: "http", url}}});
        recipe.steps = [`Use ${platform === "macos" ? "Cmd+Shift+P" : "Ctrl+Shift+P"} → MCP: Add Server → HTTP, name it mapviewer and choose the intended configuration scope.`,
            "Or merge this JSON into the default user-profile file shown above. Custom profiles may use another location.",
            "Select the Local or Copilot runtime on this computer and enable MapViewer's tools. Copilot's portable config uses mcpServers instead of servers."];
    }
    return recipe;
}
