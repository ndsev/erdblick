import {Component} from "@angular/core";
import {WebMcpService} from "./web-mcp.service";
import {ViewerActionService} from "./viewer-action.service";
import {ClipboardService} from "../shared/clipboard.service";
import {Popover} from "primeng/popover";

/** Compact opt-out-free activity and connection details for the optional MCP adapter. */
@Component({
    selector: "viewer-action-status",
    standalone: false,
    template: `
        @let web = webMcp.status$ | async;
        @let activity = actions.activity$ | async;
        @if (actions.availability$ | async; as availability) {
            @if (availability.enabled || web?.supported) {
                <p-button label="MCP" size="small" class="mcp-trigger"
                          [severity]="buttonSeverity"
                          [pTooltip]="availability.enabled ? availability.message : web?.message" (onClick)="details.toggle($event)"
                          data-testid="viewer-action-status"/>
                <p-popover #details appendTo="body" (onShow)="alignDetailsArrow(details)">
                    <section class="action-details" data-testid="viewer-action-details">
                        <strong>Agent controls</strong>
                        @if (web && web.supported) { <p role="status">{{ web.message }} ({{ web.viewerTools }} viewer, {{ web.mapgetTools }} mapget tools)</p> }
                        @if (availability.enabled) {
                        <p role="status">{{ availability.message }}</p>
                        <label for="viewer-action-label">Tab label</label>
                        <!-- HTML counts UTF-16 units; the service enforces the 120-code-point label limit. -->
                        <input pInputText id="viewer-action-label" #label [value]="actions.label" maxlength="240"
                               (change)="actions.renameSession(label.value); label.value = actions.label"/>
                        }
                        @if (availability.enabled) {
                        <div class="action-commands" role="group" aria-label="Copy Add-MCP-Command">
                            <span>Copy Add-MCP-Command:</span>
                            <div class="action-buttons">
                            <p-button label="Codex" ariaLabel="Copy Codex MCP-Add Command" size="small" (onClick)="copy('codex')"
                                      data-testid="viewer-action-copy-codex"/>
                            <p-button label="Claude" ariaLabel="Copy Claude MCP-Add Command" size="small" (onClick)="copy('claude')"
                                      data-testid="viewer-action-copy-claude"/>
                            <p-button label="Copilot" ariaLabel="Copy Copilot MCP-Add Command" size="small" (onClick)="copy('copilot')"
                                      data-testid="viewer-action-copy-copilot"/>
                            </div>
                        </div>
                        <small>Commands use POSIX-shell quoting. OAuth sign-in happens in your client.</small>
                        @let connection = actions.connectionInfo;
                        @if (connection.enabled && connection.authentication === 'oauth') {
                            <small>Copilot's OAuth command starts a session-only configuration.
                                Sign in with <code>/mcp auth mapviewer</code> inside Copilot.</small>
                        }
                        }
                        <p-button label="Stop current action" severity="danger" size="small"
                                  [disabled]="!actions.hasPendingAction" (onClick)="actions.stopCurrentAction()"
                                  data-testid="viewer-action-stop"/>
                        <small>Stop cancels pending work, not completed changes or human searches.</small>
                        @if (activity) {
                            <ul aria-label="Recent agent activity">
                                @for (entry of activity; track $index) {
                                    <li><span>{{ entry.action }}</span><span>{{ entry.status }}</span></li>
                                }
                            </ul>
                        }
                    </section>
                </p-popover>
            }
        }
    `,
    styles: [`
        .mcp-trigger {display:inline-flex;margin:.375rem .5rem;--p-button-sm-padding-y:.125rem}
        .action-details {display:flex;flex-direction:column;gap:.6rem;width:min(32rem,calc(100vw - 3rem))}
        .action-details p {margin:0}
        .action-commands {display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem}
        .action-commands > span {white-space:nowrap;font-size:.875rem}
        .action-buttons {display:flex;gap:.4rem}
        ul {list-style:none;padding:0;margin:0;max-height:15rem;overflow:auto}
        li {display:flex;justify-content:space-between;gap:1rem;font-size:.85rem;padding:.25rem 0}
        li span:first-child {overflow-wrap:anywhere}
    `]
})
export class ViewerActionStatusComponent {
    constructor(readonly actions: ViewerActionService, private readonly clipboard: ClipboardService, readonly webMcp: WebMcpService) {}

    /** Registration means available, not active; pending viewer calls own the green state. */
    get buttonSeverity(): "secondary" | "success" | "danger" {
        const availability = this.actions.availability$.value;
        if (availability.enabled ? !availability.ready : !this.webMcp.status$.value.viewerTools) return "danger";
        return this.actions.hasPendingAction ? "success" : "secondary";
    }

    /** Centers PrimeNG's arrow on the trigger after the overlay is fitted to the viewport. */
    alignDetailsArrow(details: Popover): void {
        const target: HTMLElement | undefined = details.target;
        const container = details.container;
        if (!target || !container) return;
        const button = target.getBoundingClientRect();
        // appendTo="body": offsetLeft is the final document position, unaffected
        // by PrimeNG's opening scale animation at the time onShow fires.
        const center = button.left + button.width / 2 + window.scrollX - container.offsetLeft;
        container.style.setProperty('--p-popover-arrow-left', `calc(${center}px - var(--p-popover-arrow-offset))`);
    }

    /** Builds client setup commands from fixed syntax and quoted metadata, never a server command template. */
    connectionText(kind: "codex" | "claude" | "copilot"): string {
        const info = this.actions.connectionInfo;
        if (!info.enabled) return "";
        let endpoint: URL;
        try { endpoint = new URL(info.endpoint); } catch { return ""; }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return "";
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const serverName = "mapviewer";
        const oauth = info.authentication === "oauth" ? info : undefined;
        if (kind === "copilot") {
            if (!oauth) return `copilot mcp add --transport http ${serverName} ${quote(endpoint.href)}`;
            // Copilot's add subcommand has no OAuth options. Its session config supports
            // a public client ID; scopes require that ID (otherwise use server discovery).
            const config = {mcpServers: {[serverName]: {
                type: "http",
                url: endpoint.href,
                tools: ["*"],
                oauthClientId: oauth.oauthClientId,
                oauthScopes: oauth.oauthClientId && oauth.scopes.length ? oauth.scopes : undefined
            }}};
            return `# Session-only MCP setup; sign in with /mcp auth ${serverName} inside Copilot.\n` +
                `copilot --additional-mcp-config ${quote(JSON.stringify(config))}`;
        }
        let addCommand = kind === "codex"
            ? `codex mcp add ${serverName} --url ${quote(endpoint.href)}${oauth?.oauthClientId ? ` --oauth-client-id ${quote(oauth.oauthClientId)}` : ""}`
            : `claude mcp add --transport http ${serverName} ${quote(endpoint.href)}`;
        if (!oauth) return addCommand;
        if (kind === "claude") {
            // Claude's --scope selects config storage; OAuth scopes belong in its JSON config.
            const config = {
                type: "http",
                url: endpoint.href,
                oauth: oauth.oauthClientId || oauth.scopes.length ? {
                    clientId: oauth.oauthClientId,
                    scopes: oauth.scopes.length ? oauth.scopes.join(" ") : undefined
                } : undefined
            };
            addCommand = `claude mcp add-json ${serverName} ${quote(JSON.stringify(config))}`;
        }
        const scopes = kind === "codex" && oauth.scopes.length ? ` --scopes ${quote(oauth.scopes.join(","))}` : "";
        return `${addCommand} &&\n${kind} mcp login ${serverName}${scopes}`;
    }

    /** Uses the existing clipboard/manual-copy fallback, without invoking any client command. */
    copy(kind: "codex" | "claude" | "copilot"): void {
        const text = this.connectionText(kind);
        if (text) this.clipboard.copyToClipboard(text);
    }
}
