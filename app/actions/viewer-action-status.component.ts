import {Component} from "@angular/core";
import {ViewerActionService} from "./viewer-action.service";
import {ClipboardService} from "../shared/clipboard.service";

/** Compact opt-out-free activity and connection details for the optional MCP adapter. */
@Component({
    selector: "viewer-action-status",
    standalone: false,
    template: `
        @if (actions.availability$ | async; as availability) {
            @if (availability.enabled) {
                <p-button label="MCP" size="small" [text]="true"
                          [severity]="availability.ready ? 'secondary' : 'warn'"
                          [pTooltip]="availability.message" (onClick)="details.toggle($event)"
                          data-testid="viewer-action-status"/>
                <p-popover #details appendTo="body">
                    <section class="action-details" data-testid="viewer-action-details">
                        <strong>Agent controls</strong>
                        <p role="status">{{ availability.message }}</p>
                        <label for="viewer-action-label">Tab label</label>
                        <!-- HTML counts UTF-16 units; the service enforces the 120-code-point label limit. -->
                        <input pInputText id="viewer-action-label" #label [value]="actions.label" maxlength="240"
                               (change)="actions.renameSession(label.value); label.value = actions.label"/>
                        <div class="action-buttons">
                            <p-button label="Copy MCP URL" size="small" (onClick)="copy('url')"/>
                            <p-button label="Copy Codex command" size="small" (onClick)="copy('codex')"/>
                            <p-button label="Copy Claude Code command" size="small" (onClick)="copy('claude')"/>
                        </div>
                        <small>Commands use POSIX-shell quoting. OAuth login happens in your client.</small>
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
    constructor(readonly actions: ViewerActionService, private readonly clipboard: ClipboardService) {}

    /** Builds commands from fixed syntax and quoted trusted metadata, never a server command template. */
    connectionText(kind: "url" | "codex" | "claude"): string {
        const info = this.actions.connectionInfo;
        if (!info.enabled) return "";
        let endpoint: URL;
        try { endpoint = new URL(info.endpoint); } catch { return ""; }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return "";
        if (kind === "url") return endpoint.href;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const publicClient = info.authentication === "oauth" ? info.oauthClientId : undefined;
        return kind === "codex"
            ? `codex mcp add mapviewer --url ${quote(endpoint.href)}${publicClient ? ` --oauth-client-id ${quote(publicClient)}` : ""}`
            : `claude mcp add --transport http${publicClient ? ` --client-id ${quote(publicClient)}` : ""} mapviewer ${quote(endpoint.href)}`;
    }

    /** Uses the existing clipboard/manual-copy fallback, without invoking any client command. */
    copy(kind: "url" | "codex" | "claude"): void {
        const text = this.connectionText(kind);
        if (text) this.clipboard.copyToClipboard(text);
    }
}
