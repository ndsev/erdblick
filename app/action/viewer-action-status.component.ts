import {Component} from "@angular/core";
import {WebMcpService} from "./web-mcp.service";
import {McpActionService, type ViewerMcpAvailability} from "./mcp-action.service";
import {Popover} from "primeng/popover";

/** MCP connection status, configuration shortcut and recent agent activity in a popover. */
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
                          [pTooltip]="availability.enabled ? (availability.detail ?? ('MCP tools ' + availability.message)) : web?.message" (onClick)="details.toggle($event)"
                          data-testid="viewer-action-status"/>
                <p-popover #details appendTo="body" (onShow)="alignDetailsArrow(details)">
                    <section class="action-details" data-testid="viewer-action-details">
                        <strong>Agent controls</strong>
                        @if (web && web.supported) { <p role="status">{{ web.message }} ({{ web.viewerTools }} viewer, {{ web.mapgetTools }} mapget tools)</p> }
                        <div class="mcp-connection">
                            <div class="mcp-connection-row" data-testid="mcp-controls-row">
                                <div class="mcp-connection-label" role="status" aria-live="polite" data-testid="viewer-action-connection">
                                    <span>MCP tools</span>
                                    @if (availability.enabled) {
                                        <p-tag [severity]="availabilitySeverity[availability.message]" data-testid="viewer-action-availability">{{ availability.message }}</p-tag>
                                    }
                                </div>
                                <p-button label="Configure" icon="pi pi-cog" size="small"
                                          (onClick)="details.hide(); configuration.open()" data-testid="mcp-configure"/>
                            </div>
                            @if (availability.enabled && availability.detail) { <small data-testid="viewer-action-connection-detail">{{ availability.detail }}</small> }
                        </div>
                        @if (availability.enabled) {
                            <p-iftalabel data-testid="viewer-action-tab-label">
                                <!-- HTML counts UTF-16 units; the service enforces the 120-code-point label limit. -->
                                <input pInputText id="viewer-action-label" #label [value]="actions.label" maxlength="240"
                                       (change)="actions.renameSession(label.value); label.value = actions.label"/>
                                <label for="viewer-action-label">Tab label</label>
                            </p-iftalabel>
                        }
                        <div class="action-stop-controls" data-testid="viewer-action-stop-controls">
                            <p-button label="Stop current action" severity="danger" size="small"
                                      [disabled]="!actions.hasPendingAction" (onClick)="actions.stopCurrentAction()"
                                      data-testid="viewer-action-stop"/>
                            <span class="material-symbols-outlined action-help" tabindex="0" role="img"
                                  [attr.aria-label]="stopHelp" data-testid="viewer-action-stop-help"
                                  [pTooltip]="stopHelp"
                                  tooltipPosition="top" tooltipEvent="both">help</span>
                        </div>
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
        <mcp-configuration-dialog #configuration/>
    `,
    styleUrls: ["../scss/viewer-action-status.component.scss"]
})
export class ViewerActionStatusComponent {
    readonly stopHelp = "Stop cancels only the currently pending queued actions. Your agent may still queue new actions";
    readonly availabilitySeverity: Record<ViewerMcpAvailability["message"], "warn" | "info" | "success"> = {
        waiting: "warn", connecting: "info", ready: "success"
    };

    constructor(readonly actions: McpActionService, readonly webMcp: WebMcpService) {}

    /**
     * Registration means available, not active; pending viewer calls own the green
     * state. Show danger for unavailable controls and secondary when idle.
     */
    get buttonSeverity(): "secondary" | "success" | "danger" {
        const availability = this.actions.availability$.value;
        if (availability.enabled ? availability.message !== "ready" : !this.webMcp.status$.value.viewerTools) return "danger";
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

}
