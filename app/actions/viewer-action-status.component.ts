import {Component} from "@angular/core";
import {WebMcpService} from "./web-mcp.service";
import {ViewerActionService} from "./viewer-action.service";
import {ClipboardService} from "../shared/clipboard.service";

/** Compact opt-out-free activity and connection details for the optional MCP adapter. */
@Component({
    selector: "viewer-action-status",
    standalone: false,
    template: `
        @if (actions.availability$ | async; as availability) {
            @if (availability.enabled || webMcp.status$.value.supported) {
                <p-button label="MCP" size="small" [text]="true"
                          [severity]="availability.ready || webMcp.status$.value.viewerTools > 0 ? 'secondary' : 'warn'"
                          [pTooltip]="availability.enabled ? availability.message : webMcp.status$.value.message" (onClick)="details.toggle($event)"
                          data-testid="viewer-action-status"/>
                <p-popover #details appendTo="body">
                    <section class="action-details" data-testid="viewer-action-details">
                        <strong>Agent controls</strong>
                        @if (webMcp.status$ | async; as web) {
                            @if (web.supported) { <p role="status">{{ web.message }} ({{ web.viewerTools }} viewer, {{ web.mapgetTools }} mapget tools)</p> }
                        }
                        @if (availability.enabled) {
                        <p role="status">{{ availability.message }}</p>
                        <label for="viewer-action-label">Tab label</label>
                        <!-- HTML counts UTF-16 units; the service enforces the 120-code-point label limit. -->
                        <input pInputText id="viewer-action-label" #label [value]="actions.label" maxlength="240"
                               (change)="actions.renameSession(label.value); label.value = actions.label"/>
                        }
                        @if (availability.enabled) {
                        <div class="action-buttons">
                            <p-button label="Copy Codex MCP-Add Command" size="small" (onClick)="copy('codex')"
                                      data-testid="viewer-action-copy-codex"/>
                            <p-button label="Copy Claude MCP-Add Command" size="small" (onClick)="copy('claude')"
                                      data-testid="viewer-action-copy-claude"/>
                        </div>
                        <small>Commands use POSIX-shell quoting and include client-side OAuth login when required.</small>
                        }
                        <p-button label="Stop current action" severity="danger" size="small"
                                  [disabled]="!actions.hasPendingAction" (onClick)="actions.stopCurrentAction()"
                                  data-testid="viewer-action-stop"/>
                        <small>Stop cancels pending work, not completed changes or human searches.</small>
                        @if (actions.activity$ | async; as activity) {
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
        .action-details {display:flex;flex-direction:column;gap:.6rem;width:min(29rem,80vw)}
        .action-details p {margin:0}
        .action-buttons {display:flex;flex-wrap:wrap;gap:.4rem}
        ul {list-style:none;padding:0;margin:0;max-height:15rem;overflow:auto}
        li {display:flex;justify-content:space-between;gap:1rem;font-size:.85rem;padding:.25rem 0}
        li span:first-child {overflow-wrap:anywhere}
    `]
})
export class ViewerActionStatusComponent {
    constructor(readonly actions: ViewerActionService, private readonly clipboard: ClipboardService, readonly webMcp: WebMcpService) {}

    /** Builds add/login commands from fixed syntax and quoted metadata, never a server command template. */
    connectionText(kind: "codex" | "claude"): string {
        const info = this.actions.connectionInfo;
        if (!info.enabled) return "";
        let endpoint: URL;
        try { endpoint = new URL(info.endpoint); } catch { return ""; }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return "";
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const serverName = "mapviewer";
        const oauth = info.authentication === "oauth" ? info : undefined;
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
    copy(kind: "codex" | "claude"): void {
        const text = this.connectionText(kind);
        if (text) this.clipboard.copyToClipboard(text);
    }
}
