import {Component} from "@angular/core";
import {FormsModule} from "@angular/forms";
import {ButtonModule} from "primeng/button";
import {InputTextModule} from "primeng/inputtext";
import {SelectButtonModule} from "primeng/selectbutton";
import {TextareaModule} from "primeng/textarea";
import {AppUrlStateService} from "../appstate/appstate-url.service";
import {ClipboardService} from "../clipboard/clipboard.service";
import {AppDialogComponent} from "../layout/app-dialog.component";
import {McpActionService} from "./mcp-action.service";
import {buildMcpSetup, buildWebMcpSetup, isMcpBrowserAgent, mcpSetupAgents, mcpSetupConnections, mcpSetupPlatforms,
    type McpSetupAgent, type McpSetupConnection, type McpSetupPlatform, type McpSetupRecipe} from "./mcp-client-setup.presentation";

/** Presents setup one choice at a time without persisting onboarding choices as map state. */
@Component({
    selector: "mcp-configuration-dialog",
    standalone: true,
    imports: [AppDialogComponent, FormsModule, ButtonModule, InputTextModule, SelectButtonModule, TextareaModule],
    template: `
        <app-dialog header="MCP Configuration" [(visible)]="visible" [modal]="true" appendTo="body"
                    [resizable]="false" [draggable]="false" [persistLayout]="false"
                    [style]="{width: '36rem', maxWidth: 'calc(100vw - 2rem)', maxHeight: 'calc(100dvh - 2rem)'}"
                    data-testid="mcp-configuration-dialog">
            <section class="mcp-setup" aria-label="Agent setup" data-testid="mcp-setup">
                <span id="mcp-platform-label">Platform</span>
                <p-selectButton class="mcp-platform-selector" [options]="platformOptions"
                                [ngModel]="selectedPlatform" (ngModelChange)="selectPlatform($event)"
                                optionLabel="label" optionValue="value" [allowEmpty]="false" size="small"
                                ariaLabelledBy="mcp-platform-label" data-testid="mcp-platform-selector"/>
                <p>Choose where the agent runs. For WSL, select Linux.</p>
                @if (selectedPlatform) {
                    <span id="mcp-agent-label">Agent</span>
                    <p-selectButton class="mcp-agent-selector" [options]="agentOptions"
                                    [ngModel]="selectedAgent" (ngModelChange)="selectAgent($event)"
                                    optionLabel="label" optionValue="value" [allowEmpty]="false" size="small"
                                    ariaLabelledBy="mcp-agent-label" data-testid="mcp-agent-selector"/>
                    @if (needsConnectionChoice) {
                        <span id="mcp-connection-label">Connection</span>
                        <p-selectButton [options]="connectionOptions" [(ngModel)]="selectedConnection"
                                        optionLabel="label" optionValue="value" [allowEmpty]="false" size="small"
                                        ariaLabelledBy="mcp-connection-label" data-testid="mcp-connection-selector"/>
                    }
                    @if (setupRecipe; as setup) {
                        @if (setup.unavailable) { <p role="status">{{ setup.unavailable }}</p> }
                        @for (field of setup.fields; track field.id) {
                            <div class="mcp-setup-field" [attr.data-testid]="'mcp-setup-field-' + field.id">
                                <div class="mcp-field-heading">
                                    <label [for]="'mcp-setup-' + field.id">{{ field.label }}</label>
                                    <p-button label="Copy" icon="pi pi-copy" size="small" [text]="true"
                                              [ariaLabel]="'Copy ' + field.label" (onClick)="copyField(field.id)"/>
                                </div>
                                @if (field.multiline) {
                                    <textarea pTextarea [id]="'mcp-setup-' + field.id" [value]="field.value"
                                              [rows]="fieldRows(field.value)" readonly spellcheck="false"></textarea>
                                } @else {
                                    <input pInputText [id]="'mcp-setup-' + field.id" [value]="field.value" readonly spellcheck="false"/>
                                }
                            </div>
                        }
                        @if (selectedConnection === 'webmcp') {
                            <p>The URL follows the current route state. Browser-local styles and searches are not included.
                                Use a browser that can reach this address; WebMCP needs HTTPS or localhost.</p>
                        }
                        <ol aria-label="Finish setup">
                            @for (step of setup.steps; track $index) { <li>{{ step }}</li> }
                        </ol>
                        <a [href]="setup.docsUrl" target="_blank" rel="noopener noreferrer" data-testid="mcp-provider-docs">
                            Full configuration instructions <i class="pi pi-external-link" aria-hidden="true"></i>
                        </a>
                    }
                }
            </section>
        </app-dialog>
    `,
    styles: [`
        .mcp-setup {display:flex;flex-direction:column;gap:.6rem;min-width:0}
        .mcp-setup p {margin:0}
        .mcp-platform-selector {display:flex;flex-wrap:wrap}
        .mcp-agent-selector {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border:1px solid var(--p-togglebutton-border-color);border-radius:var(--p-selectbutton-border-radius);overflow:hidden;--p-togglebutton-content-sm-padding:.25rem}
        /* The dialog is appended to body. One outline joins all options into a single control. */
        ::ng-deep .mcp-setup .mcp-agent-selector.p-selectbutton > .p-togglebutton {width:100%;min-width:0;border:0;border-radius:0}
        ::ng-deep .mcp-setup .mcp-agent-selector .p-togglebutton:focus-visible {outline-offset:-2px}
        ::ng-deep .mcp-setup .mcp-agent-selector .p-togglebutton-label {white-space:normal;text-align:center}
        .mcp-field-heading {display:flex;align-items:center;justify-content:space-between;gap:.5rem;font-size:.875rem}
        .mcp-setup-field {min-width:0}
        .mcp-setup-field input,.mcp-setup-field textarea {width:100%;box-sizing:border-box;font-family:monospace;font-size:.8rem}
        .mcp-setup-field textarea {resize:vertical;min-height:3rem;max-height:12rem;white-space:pre;overflow:auto}
        .mcp-setup ol {margin:0;padding-left:1.25rem}
        .mcp-setup ol li {padding:.15rem 0;overflow-wrap:anywhere}
        .mcp-setup a {color:var(--p-primary-color);align-self:flex-start}
    `]
})
export class McpConfigurationDialogComponent {
    readonly platformOptions = mcpSetupPlatforms;
    readonly agentOptions = mcpSetupAgents;
    readonly connectionOptions = mcpSetupConnections;
    visible = false;
    selectedPlatform: McpSetupPlatform | null = null;
    selectedAgent: McpSetupAgent | null = null;
    selectedConnection: McpSetupConnection | null = null;

    constructor(private readonly actions: McpActionService, private readonly clipboard: ClipboardService,
                private readonly urlState: AppUrlStateService) {}

    /** Each opening starts with an explicit platform choice. */
    open(): void {
        this.selectedPlatform = this.selectedAgent = this.selectedConnection = null;
        this.visible = true;
    }

    /** Refreshes platform-specific instructions while retaining the selected agent and connection. */
    selectPlatform(platform: McpSetupPlatform): void {
        if (platform === this.selectedPlatform) return;
        this.selectedPlatform = platform;
    }

    /** App choices require an explicit connection mode before showing instructions. */
    selectAgent(agent: McpSetupAgent): void {
        if (agent === this.selectedAgent) return;
        this.selectedAgent = agent;
        this.selectedConnection = null;
    }

    get needsConnectionChoice(): boolean {
        return isMcpBrowserAgent(this.selectedAgent);
    }

    get setupRecipe(): McpSetupRecipe | null {
        if (!this.selectedPlatform || !this.selectedAgent) return null;
        if (isMcpBrowserAgent(this.selectedAgent)) {
            if (!this.selectedConnection) return null;
            if (this.selectedConnection === "webmcp")
                return buildWebMcpSetup(this.selectedPlatform, this.selectedAgent, this.urlState.currentUrl);
        }
        return buildMcpSetup(this.actions.connectionInfo, this.selectedPlatform, this.selectedAgent);
    }

    /** Bounds tall JSON fields while the dialog itself sizes naturally to its content. */
    fieldRows(value: string): number {
        return Math.max(2, Math.min(8, value.split("\n").length));
    }

    /** Reads the current recipe and route at copy time, never a previously selected value. */
    copyField(id: string): void {
        const field = this.setupRecipe?.fields.find(item => item.id === id);
        if (field) this.clipboard.copyToClipboard(field.value);
    }
}
