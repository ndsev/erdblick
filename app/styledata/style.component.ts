import {Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild} from "@angular/core";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {StyleService} from "./style.service";
import {ErdblickStyleGroup, ErdblickStyle, UpdatedModifiedStyleEntry} from "./style.service";
import {AppStateService, STYLE_EDITOR_DIALOG_LAYOUT_ID, STYLES_DIALOG_LAYOUT_ID} from "../shared/appstate.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {KeyValue} from "@angular/common";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {EditorService} from "../shared/editor.service";
import {filter} from "rxjs/operators";
import {removeGroupPrefix} from "../mapdata/map.tree.model"
import {DialogStackService} from "../shared/dialog-stack.service";
import {basicSetup} from "codemirror";
import {Compartment, EditorState} from "@codemirror/state";
import {yaml} from "@codemirror/lang-yaml";
import {EditorView} from "@codemirror/view";
import {MergeView} from "@codemirror/merge";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {oneDark} from "@codemirror/theme-one-dark";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {StyleValidationReportService} from "./style-validation-report.service";
import {StyleValidationIssue, StyleValidationReport} from "./style-validation.model";


@Component({
    selector: 'style-panel',
    template: `
        <app-dialog class="styles-dialog" data-testid="styles-dialog" header="Style Sheets" [(visible)]="stylesDialogVisible"
                  [modal]="false" [style]="{ 'min-width': '30em', 'width': '30em' }" #styles [closeOnEscape]="false"
                  [persistLayout]="true" [layoutId]="stylesDialogLayoutId"
                  (onShow)="onStylesDialogShow()">
            <p-tabs [(value)]="stylesDialogTab" class="style-sheets-tabs" data-testid="style-sheets-tabs">
                <p-tablist>
                    <p-tab value="styles">Styles</p-tab>
                    <p-tab value="errors">
                        <span>Errors </span>
                        @if (styleValidationReportService.reports$ | async; as styleIssues) {
                            <p-badge [value]="styleIssueCount(styleIssues)"/>
                        }
                    </p-tab>
                </p-tablist>
                <p-tabpanels>
                    <p-tabpanel value="styles">
                        <div class="styles-container">
                            @if (styleService.styleGroups | async; as styleGroups) {
                                @if (!styleService.builtinStylesCount && !styleService.importedStylesCount) {
                                    <div class="styles-empty">No styles loaded.</div>
                                }
                                <p-tree [value]="styleGroups" data-testid="style-tree">
                                    <!-- Group Node Template -->
                                    <ng-template let-node pTemplate="Group">
                                    <span>
                                        <p-checkbox [ngModel]="node.visible"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="toggleStyleGroup(node.id, $event)"
                                                    [binary]="true"
                                                    [inputId]="node.id"
                                                    [name]="node.id" tabindex="0"/>
                                        <label [for]="node.id" style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                    </span>
                                    </ng-template>
                                    <!-- Style Node Template -->
                                    <ng-template let-node pTemplate="Style">
                                        <div class="flex-container" [attr.data-testid]="'style-row-' + styleTestIdSuffix(node.id)">
                                            <div class="font-bold white-space-nowrap" style="display: flex; align-items: center;">
                                            <span onEnterClick class="material-symbols-outlined menu-toggler"
                                                  [attr.data-testid]="'style-menu-button-' + styleTestIdSuffix(node.id)"
                                                  (click)="showStylesToggleMenu($event, node.id)" tabindex="0">
                                                more_vert
                                            </span>
                                                <span>
                                                <p-checkbox [(ngModel)]="node.visible"
                                                            [attr.data-testid]="'style-visibility-' + styleTestIdSuffix(node.id)"
                                                            (click)="$event.stopPropagation()"
                                                            (ngModelChange)="applyStyleConfig(node.id)"
                                                            [binary]="true"
                                                            [inputId]="node.id"
                                                            [name]="node.id"/>
                                                <label [for]="node.id"
                                                       style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                                @if (node.additional) {
                                                    <p-tag class="additional-style-tag"
                                                           [class.clickable-style-tag]="node.overridesBaseStyle"
                                                           severity="info" value="Additional" [rounded]="true"
                                                           (click)="openCompareFromAdditionalTag($event, node.id)"/>
                                                }
                                                @if (node.modified && !node.imported) {
                                                    <p-tag class="modified-style-tag"
                                                           severity="warn" value="Modified" [rounded]="true"
                                                           (click)="openCompareFromModifiedTag($event, node.id)"/>
                                                }
                                            </span>
                                            </div>
                                            <div class="tree-node-controls">
                                                @if (node.imported) {
                                                    <p-button onEnterClick (click)="removeStyle(node.id)"
                                                              [attr.data-testid]="'style-remove-button-' + styleTestIdSuffix(node.id)"
                                                              icon="pi pi-trash"
                                                              label="" pTooltip="Remove style"
                                                              tooltipPosition="bottom" tabindex="0">
                                                    </p-button>
                                                } @else {
                                                    <p-button onEnterClick (click)="resetStyle(node.id)"
                                                              [attr.data-testid]="'style-reset-button-' + styleTestIdSuffix(node.id)"
                                                              icon="pi pi-refresh"
                                                              label="" pTooltip="Reset style to server version"
                                                              tooltipPosition="bottom" tabindex="0">
                                                    </p-button>
                                                }
                                                <p-button onEnterClick (click)="showStyleEditor(node.id)"
                                                          [attr.data-testid]="'style-edit-button-' + styleTestIdSuffix(node.id)"
                                                          icon="pi pi-file-edit"
                                                          label="" pTooltip="Edit style"
                                                          tooltipPosition="bottom" tabindex="0">
                                                </p-button>
                                            </div>
                                        </div>
                                    </ng-template>
                                    <!-- Bool Node Template -->
                                    <ng-template let-node pTemplate="Bool">
                                        <div style="display: flex; align-items: center;">
                                        <span style="font-style: oblique">
                                            <label [for]="node.styleId + '_' + node.id"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.label }}</label>
                                        </span>
                                        </div>
                                    </ng-template>
                                    <ng-template let-node pTemplate="String">
                                    </ng-template>
                                </p-tree>
                            }
                            @if (styleService.erroredStyleIds.size > 0) {
                                <div class="styles-error-list">
                                    <div *ngFor="let message of styleService.erroredStyleIds | keyvalue: unordered"
                                         class="flex-container">
                                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em; color: red">
                                            {{ message.key }}: {{ message.value }}
                                        </span>
                                    </div>
                                </div>
                            }
                        </div>
                    </p-tabpanel>
                    <p-tabpanel value="errors">
                        @if (styleValidationReportService.reports$ | async; as styleIssues) {
                            <div class="style-errors-tab">
                                <div class="style-errors-toolbar">
                                    <p-iconfield iconPosition="left" class="style-errors-filter">
                                        <p-inputicon>
                                            <i class="pi pi-filter"></i>
                                        </p-inputicon>
                                        <input pInputText type="text"
                                               [ngModel]="styleIssueFilter"
                                               (ngModelChange)="styleIssueFilter = $event"
                                               placeholder="Filter">
                                    </p-iconfield>
                                    <p-checkbox inputId="style-errors-only"
                                                [(ngModel)]="styleErrorsOnly"
                                                [binary]="true"></p-checkbox>
                                    <label for="style-errors-only">Errors only</label>
                                    <p-button size="small" label="Clear duplicates"
                                              (click)="styleValidationReportService.clearRuntimeDuplicates()"/>
                                </div>
                                <p-table [value]="filteredStyleIssues(styleIssues)"
                                         [scrollable]="true"
                                         scrollHeight="flex"
                                         class="style-errors-table"
                                         styleClass="style-errors-table"
                                         data-testid="style-errors-table"
                                         [rowTrackBy]="trackByStyleIssue">
                                    <ng-template pTemplate="header">
                                        <tr>
                                            <th>Time</th>
                                            <th>Severity</th>
                                            <th>Impact</th>
                                            <th>Style</th>
                                            <th>Rule</th>
                                            <th>Property</th>
                                            <th>Location</th>
                                            <th>Message</th>
                                        </tr>
                                    </ng-template>
                                    <ng-template pTemplate="body" let-issue>
                                        <tr [ngClass]="'style-issue-' + issue.severity">
                                            <td>{{ formatIssueTime(issue) }}</td>
                                            <td>{{ issue.severity }}</td>
                                            <td>{{ issue.impact }}</td>
                                            <td [pTooltip]="issue.source.url || issue.source.configId || ''">
                                                {{ issue.source.styleName || issue.source.url || issue.source.configId || issue.source.sourceKind }}
                                            </td>
                                            <td>{{ issue.rulePath || (issue.ruleIndex !== undefined ? 'rules[' + issue.ruleIndex + ']' : '') }}</td>
                                            <td>{{ issue.property || '' }}</td>
                                            <td>{{ formatIssueLocation(issue) }}</td>
                                            <td [pTooltip]="issue.detail || issue.expression || ''">{{ issue.message }}</td>
                                        </tr>
                                    </ng-template>
                                    <ng-template pTemplate="emptymessage">
                                        <tr>
                                            <td colspan="8">
                                                <div class="styles-empty">No style validation issues.</div>
                                            </td>
                                        </tr>
                                    </ng-template>
                                </p-table>
                            </div>
                        }
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            <div class="dialog-controls">
                <p-button data-testid="styles-close-button" (click)="styles.close($event)" label="Close" icon="pi pi-times"></p-button>
                <p-fileupload #styleUploader onEnterClick mode="basic" name="demo[]" chooseIcon="pi pi-upload"
                              accept=".yaml" maxFileSize="1048576" fileLimit="1" multiple="false"
                              customUpload="true" (uploadHandler)="importStyle($event)" [auto]="true"
                              data-testid="style-import-button"
                              class="import-dialog" pTooltip="Import style" tooltipPosition="bottom"
                              chooseLabel="Import Style" tabindex="0"/>
            </div>
        </app-dialog>
        <p-menu #styleMenu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}" appendTo="body"></p-menu>
        <app-dialog header="Style Editor" [(visible)]="styleEditorVisible" [modal]="false" #editorDialog
                  data-testid="style-editor-dialog" class="editor-dialog"
                  [persistLayout]="true" [layoutId]="styleEditorDialogLayoutId"
                  (onShow)="onEditorDialogShow()" (onHide)="onEditorDialogHide()">
            <editor [sessionId]="styleEditorSessionId"></editor>
            <div class="editor-actions style-editor-actions">
                <div class="editor-actions-left">
                    <p-button data-testid="style-editor-apply-button" (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!sourceWasModified"></p-button>
                    <p-button data-testid="style-editor-close-button" (click)="closeEditorDialog($event)"
                              [label]='sourceWasModified ? "Discard" : "Close"'
                              icon="pi pi-times"></p-button>
                    <div class="editor-shortcuts">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                        <div>Press <span style="color: grey">Esc</span> to quit</div>
                    </div>
                </div>
                <div class="editor-actions-right">
                    <p-button data-testid="style-editor-export-button" (click)="exportStyle(stateService.styleEditorTargetId ?? '')"
                              [disabled]="sourceWasModified || !stateService.styleEditorTargetId" label="Export" icon="pi pi-file-export">
                    </p-button>
                    <p-button data-testid="style-editor-help-button" (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
                </div>
            </div>
        </app-dialog>
        <app-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog 
                  [closeOnEscape]="false" (onShow)="onWarningShow()">
            <p>You have already edited the style data. Do you want to save the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="applyEditedStyle(); warningDialog.close($event)" label="Save"></p-button>
                <p-button (click)="warningDialog.close($event)" label="Cancel"></p-button>
                <p-button (click)="discardStyleEdits(); closeEditorDialog($event)" label="Discard"></p-button>
            </div>
        </app-dialog>
        <app-dialog header="Style Validation Failed" [(visible)]="styleValidationDialogVisible" [modal]="true"
                  #styleValidationDialog data-testid="style-validation-failed-dialog">
            @if (lastEditorValidationReport) {
                <div class="style-validation-summary">
                    {{ lastEditorValidationReport.source.styleName || lastEditorValidationReport.source.url || 'Style' }}
                    has {{ validationErrorCount(lastEditorValidationReport) }} validation error(s).
                </div>
                <div class="style-validation-details">
                    @for (issue of firstValidationErrors(lastEditorValidationReport); track issue.id) {
                        <div class="style-validation-issue">
                            <span class="style-validation-location">{{ formatIssueLocation(issue) }}</span>
                            <span class="style-validation-path">{{ issue.rulePath || issue.property || issue.impact }}</span>
                            <span>{{ issue.message }}</span>
                        </div>
                    }
                </div>
            }
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="styleValidationDialog.close($event)" label="Ok"></p-button>
                <p-button (click)="openStyleErrorsTab(); styleValidationDialog.close($event)" label="Open Errors"></p-button>
            </div>
        </app-dialog>
        <app-dialog header="Updated Modified Styles" [(visible)]="styleUpdateDialogVisible" [modal]="true"
                  (onHide)="resetUpdatedStyleIds()" #updatedStyleDialog appendTo="body">
            @if (getUpdatedModifiedStyles().length > 0) {
                <div class="updated-styles-container">
                    <p>The following styles were updated in the datasource while their modifications persist in local
                        memory:</p>
                    @for (entry of getUpdatedModifiedStyles(); track entry.url) {
                        <p-chip class="updated-modified-style-chip"
                                [label]="entry.id"
                                [pTooltip]="entry.url"
                                tooltipPosition="bottom"
                                (click)="openCompareFromUpdatedChip($event, entry.url)"/>
                    }
                </div>
            }
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="updatedStyleDialog.close($event)" label="Ok"></p-button>
            </div>
        </app-dialog>
        <app-dialog header="Style Comparison" [(visible)]="styleCompareDialogVisible" [modal]="true"
                  class="style-compare-dialog" #styleCompareDialog (onShow)="onStyleCompareDialogShow()" 
                  (onHide)="onStyleCompareDialogHide()">
            @if (styleCompareStyleId) {
                <div class="style-compare-labels">
                    <div>{{ styleCompareLeftLabel }}</div>
                    <div>{{ styleCompareRightLabel }}</div>
                </div>
                <div #styleCompareHost class="style-compare-host"></div>
            }
            <div class="style-compare-actions">
                <p-button label="Apply" icon="pi pi-check"
                          pTooltip="Apply the current left-side style source"
                          tooltipPosition="bottom"
                          [disabled]="styleCompareReadOnly || !styleCompareLeftModified"
                          (click)="applyComparedStyle()"/>
                <p-button [label]="styleCompareReadOnly ? 'Close' : (styleCompareLeftModified ? 'Discard' : 'Close')" icon="pi pi-times"
                          pTooltip="Close compare or discard unsaved left-side edits"
                          tooltipPosition="bottom"
                          (click)="closeOrDiscardComparedStyle($event)"/>
                <p-button label="Export" icon="pi pi-file-export"
                          pTooltip="Export the modified style source"
                          tooltipPosition="bottom"
                          [disabled]="styleCompareReadOnly"
                          (click)="exportComparedStyle()"/>
                <p-button label="Reset" icon="pi pi-refresh"
                          pTooltip="Reset this modified builtin style to the server version"
                          tooltipPosition="bottom"
                          [disabled]="styleCompareReadOnly"
                          (click)="resetComparedStyle()"/>
            </div>
        </app-dialog>
    `,
    styles: [`
        .disabled {
            pointer-events: none;
            opacity: 0.5;
        }

        .additional-style-tag,
        .modified-style-tag {
            margin-left: 0.5em;
        }

        .additional-style-tag.clickable-style-tag,
        .modified-style-tag {
            cursor: pointer;
        }

        .updated-modified-style-chip {
            cursor: pointer;
        }

        .style-errors-toolbar {
            display: flex;
            align-items: center;
            gap: 0.5em;
        }

        .style-errors-filter {
            flex: 1;
        }

        .style-errors-filter input {
            width: 100%;
        }

        .style-issue-error {
            color: var(--p-message-error-color, var(--p-button-danger-background));
        }

        .style-issue-warning {
            color: var(--yellow-300, #fde68a);
        }

        .style-validation-details {
            display: flex;
            flex-direction: column;
            gap: 0.35em;
            margin-top: 0.75em;
        }

        .style-validation-issue {
            display: grid;
            grid-template-columns: 4em minmax(6em, 1fr) 2fr;
            gap: 0.5em;
        }

        .style-validation-location,
        .style-validation-path {
            color: silver;
        }
    `],
    standalone: false
})
/**
 * Styles dialog, editor, and comparison workflow.
 *
 * This component keeps UI state for editing, importing, exporting, and comparing
 * styles while delegating actual style parsing and lifecycle tracking to `StyleService`.
 */
export class StyleComponent implements OnDestroy {
    readonly stylesDialogLayoutId = STYLES_DIALOG_LAYOUT_ID;
    readonly styleEditorDialogLayoutId = STYLE_EDITOR_DIALOG_LAYOUT_ID;
    readonly styleEditorSessionId = 'style-editor';
    warningDialogVisible: boolean = false;
    styleUpdateDialogVisible: boolean = false;
    styleEditorSourceSubscription: Subscription = new Subscription();
    styleEditorSaveSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;
    private styleEditorOriginalSource: string = '';
    stylesCollapsed: boolean = false;
    styleCompareDialogVisible: boolean = false;
    styleCompareLeftModified: boolean = false;
    styleCompareLeftLabel: string = "Original Style";
    styleCompareRightLabel: string = "Modified Style";
    styleCompareReadOnly: boolean = false;
    styleCompareStyleId: string = "";
    private styleCompareLeftSource: string = "";
    private styleCompareRightSource: string = "";
    private styleCompareView?: MergeView;
    private readonly compareThemeCompartmentA = new Compartment();
    private readonly compareThemeCompartmentB = new Compartment();
    private compareModeObserver?: MutationObserver;
    private readonly DARK_MODE_CLASS = 'erdblick-dark';
    stylesDialogTab: 'styles' | 'errors' = 'styles';
    styleIssueFilter: string = '';
    styleErrorsOnly: boolean = false;
    styleValidationDialogVisible: boolean = false;
    lastEditorValidationReport?: StyleValidationReport;

    @ViewChild('styleMenu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('styles') stylesDialog: AppDialogComponent | undefined;
    @ViewChild('editorDialog') editorDialog: AppDialogComponent | undefined;
    @ViewChild('warningDialog') warningDialog: AppDialogComponent | undefined;
    @ViewChild('styleValidationDialog') styleValidationDialog: AppDialogComponent | undefined;
    @ViewChild('styleCompareDialog') styleCompareDialog: AppDialogComponent | undefined;
    @ViewChild('styleCompareHost') styleCompareHost?: ElementRef<HTMLDivElement>;

    // Group visibility is derived from leaf styles; bind directly to node.visible.

    constructor(public mapService: MapDataService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public styleValidationReportService: StyleValidationReportService,
                public stateService: AppStateService,
                public editorService: EditorService,
                private dialogStack: DialogStackService,
                private ngZone: NgZone) {
        this.stateService.ready.pipe(filter(state => state)).subscribe(_ => {
            this.refreshUpdatedStylesDialogVisibility();
        });
    }

    get stylesDialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.stylesDialogLayoutId);
    }

    set stylesDialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.stylesDialogLayoutId, visible);
    }

    get styleEditorVisible(): boolean {
        return this.stateService.isDialogOpen(this.styleEditorDialogLayoutId);
    }

    set styleEditorVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.styleEditorDialogLayoutId, visible);
    }

    /** Releases the compare view and its theme observer. */
    ngOnDestroy() {
        this.compareModeObserver?.disconnect();
        this.styleCompareView?.destroy();
        this.styleEditorSourceSubscription.unsubscribe();
        this.styleEditorSaveSubscription.unsubscribe();
        this.editorService.closeSession(this.styleEditorSessionId);
    }

    /** Promotes the styles dialog above other overlays. */
    onStylesDialogShow() {
        this.dialogStack.bringToFront(this.stylesDialog);
    }

    /** Promotes the style editor dialog above other overlays. */
    onEditorDialogShow() {
        this.ensureStyleEditorSession();
        this.dialogStack.bringToFront(this.editorDialog);
    }

    /** Brings the compare dialog to the front and creates the merge view. */
    onStyleCompareDialogShow() {
        this.dialogStack.bringToFront(this.styleCompareDialog);
        this.setupCompareView();
    }

    /** Tears down compare-view resources when the compare dialog closes. */
    onStyleCompareDialogHide() {
        this.compareModeObserver?.disconnect();
        this.compareModeObserver = undefined;
        this.styleCompareView?.destroy();
        this.styleCompareView = undefined;
        this.styleCompareLeftModified = false;
        this.styleCompareReadOnly = false;
        this.styleCompareLeftLabel = "Original Style";
        this.styleCompareRightLabel = "Modified Style";
    }

    /** Opens the bulk-toggle menu for one style entry. */
    showStylesToggleMenu(event: MouseEvent, styleId: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId == id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.scheduleUpdate();
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId != id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.scheduleUpdate();
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, false, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.scheduleUpdate();
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, true, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.scheduleUpdate();
                }
            }
        ];
    }

    /** Persists visibility changes for one style and optionally triggers a redraw. */
    applyStyleConfig(styleId: string, redraw: boolean=true) {
        const style = this.styleService.styles.get(styleId);
        if (style === undefined || style === null) {
            return;
        }
        this.stateService.setStyleVisibility(styleId, style.visible);
        if (redraw) {
            this.styleService.reapplyStyle(styleId);
        }
    }

    /** Resets a builtin style to its baseline or reloads it from the server. */
    resetStyle(styleId: string) {
        const restoredStyleId = this.styleService.resetModifiedBuiltinStyle(styleId);
        if (restoredStyleId) {
            this.styleService.toggleStyle(restoredStyleId, true);
            this.mapService.scheduleUpdate();
            this.refreshUpdatedStylesDialogVisibility();
            return;
        }
        this.styleService.reloadStyle(styleId);
        this.styleService.toggleStyle(styleId, true);
        this.refreshUpdatedStylesDialogVisibility();
    }

    /** Exports one style as YAML. */
    exportStyle(styleId: string) {
        if(!this.styleService.exportStyleYamlFile(styleId)) {
            this.messageService.showError(`Error occurred while trying to export style: ${styleId}`);
        }
    }

    /** Imports a user-provided YAML style file. */
    importStyle(event: any) {
        if (event.files && event.files.length > 0) {
            const file: File = event.files[0];
            let styleId = file.name;
            this.styleService.importStyleYamlFile(event, file, this.styleUploader)
                .then((ok) => {
                    if (!ok) {
                        if (this.styleService.lastValidationReport && !this.styleService.lastValidationReport.valid) {
                            this.showValidationFailure(this.styleService.lastValidationReport);
                        } else {
                            this.messageService.showError(`Could not read empty data for: ${styleId}`);
                        }
                    }
                })
                .catch((error) => {
                    this.messageService.showError(`Error occurred while trying to import style: ${styleId}`);
                    console.error(error);
                });
        }
    }

    /** Removes an imported style. */
    removeStyle(styleId: string) {
        this.styleService.deleteStyle(styleId);
    }

    /** Opens the style editor for one style and tracks dirty-state changes. */
    showStyleEditor(styleId: string) {
        if (!this.prepareStyleEditorSession(styleId)) {
            this.messageService.showError(`Could not load style source for ${styleId}.`);
            return;
        }
        this.styleEditorVisible = true;
    }

    /** Applies the current editor contents to the selected style. */
    applyEditedStyle() {
        const styleId = this.stateService.styleEditorTargetId;
        const styleData = this.editorService.getSessionSource(this.styleEditorSessionId).replace(/\n+$/, '');
        if (!styleId) {
            this.messageService.showError(`No cached style ID found!`);
            return;
        }
        if (!styleData) {
            this.messageService.showError(`Cannot apply an empty style definition to style: ${styleId}!`);
            return;
        }
        if (!this.styleService.styles.has(styleId)) {
            this.messageService.showError(`Could not apply changes to style: ${styleId}. Failed to access!`)
            return;
        }
        const report = this.styleService.validateStyleSource(
            styleData,
            this.styleService.createEditorSourceRef(styleId, styleData));
        if (!report.valid) {
            this.showValidationFailure(report);
            return;
        }
        const newStyleId = this.styleService.setStyleSource(styleId, styleData);
        // If there is no style ID returned, then setStyleSource failed.
        if (newStyleId) {
            this.stateService.styleEditorTargetId = newStyleId;
            this.sourceWasModified = false;
            this.styleEditorOriginalSource = styleData;
            this.editorService.updateSessionSource(this.styleEditorSessionId, styleData);
            this.refreshUpdatedStylesDialogVisibility();
        }
    }

    /** Closes the editor or opens the discard-warning dialog when unsaved edits exist. */
    closeEditorDialog(event: any) {
        event.stopPropagation();
        if (this.sourceWasModified) {
            this.warningDialogVisible = true;
            return;
        }
        if (this.editorDialog !== undefined) {
            this.warningDialogVisible = false;
            this.editorDialog.close(event);
        }
    }

    /** Discards pending edits in the style editor. */
    discardStyleEdits() {
        this.editorService.updateSessionSource(this.styleEditorSessionId, this.styleEditorOriginalSource);
        this.sourceWasModified = false;
        this.warningDialogVisible = false;
    }

    /** Uses Escape to close the warning or editor dialog while the style editor is active. */
    @HostListener('window:keydown', ['$event'])
    onWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.styleEditorVisible) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.warningDialogVisible) {
            this.warningDialogVisible = false;
            return;
        }
        this.closeEditorDialog(event);
    }

    onEditorDialogHide() {
        this.styleEditorVisible = false;
        this.warningDialogVisible = false;
        this.sourceWasModified = false;
        this.stateService.styleEditorTargetId = null;
        this.styleEditorSourceSubscription.unsubscribe();
        this.styleEditorSaveSubscription.unsubscribe();
        this.editorService.closeSession(this.styleEditorSessionId);
    }

    /** Recreates the editor session when a persisted style-editor dialog is restored on startup/import. */
    private ensureStyleEditorSession(): void {
        const targetStyleId = this.stateService.styleEditorTargetId;
        if (!targetStyleId || this.editorService.hasSession(this.styleEditorSessionId)) {
            return;
        }
        if (!this.prepareStyleEditorSession(targetStyleId)) {
            this.messageService.showError(`Could not restore style editor for ${targetStyleId}.`);
            this.styleEditorVisible = false;
            this.stateService.styleEditorTargetId = null;
        }
    }

    /** Opens a fresh editor session for the given style and subscribes dirty/save handling to it. */
    private prepareStyleEditorSession(styleId: string): boolean {
        const source = this.styleService.styles.get(styleId)?.source;
        if (source === undefined) {
            return false;
        }
        this.stateService.styleEditorTargetId = styleId;
        this.styleEditorOriginalSource = source.replace(/\n+$/, '');
        this.editorService.createSession({
            id: this.styleEditorSessionId,
            source: `${source}\n\n\n\n\n`,
            language: 'yaml',
            readOnly: false
        });
        this.styleEditorSourceSubscription.unsubscribe();
        this.styleEditorSourceSubscription = this.editorService.getSession(this.styleEditorSessionId)!.source$.subscribe(
            editedStyleSource => {
                this.sourceWasModified = editedStyleSource.replace(/\n+$/, '') !== this.styleEditorOriginalSource;
            }
        );
        this.styleEditorSaveSubscription.unsubscribe();
        this.styleEditorSaveSubscription = this.editorService.onSaveRequested(this.styleEditorSessionId)?.subscribe(() => {
            this.applyEditedStyle();
        }) ?? new Subscription();
        this.sourceWasModified = false;
        return true;
    }

    /** Opens the style-definition documentation in a new browser tab. */
    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

    /** Keeps PrimeNG keyvalue iteration in insertion order. */
    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    /** Toggles visibility for every style nested under one style group. */
    toggleStyleGroup(id: string, enabled: boolean) {
        if (!id || id === 'ungrouped') {
            return;
        }
        const rootGroups = this.styleService.styleGroups.getValue();
        const group = this.findStyleGroupById(rootGroups, id);
        if (!group) {
            return;
        }
        const styleIds = this.collectStyleIds(group);
        for (const id of styleIds) {
            this.styleService.toggleStyle(id, enabled, true);
        }
        this.styleService.reapplyAllStyles();
        this.mapService.scheduleUpdate();
    }

    /** Narrows a tree node to a style-group node. */
    private checkIsStyleGroup (e: any): e is ErdblickStyleGroup {
        return e.type === "Group";
    }

    /** Finds a style group by id inside the nested style-group tree. */
    private findStyleGroupById(elements: (ErdblickStyleGroup | ErdblickStyle)[], id: string): ErdblickStyleGroup | undefined {
        for (const elem of elements) {
            if (!this.checkIsStyleGroup(elem)) {
                continue;
            }
            if (elem.id === id) {
                return elem;
            }
            const found = this.findStyleGroupById(elem.children, id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /** Collects every leaf style id reachable from a style group. */
    private collectStyleIds(group: ErdblickStyleGroup): string[] {
        const ids: string[] = [];
        for (const child of group.children) {
            if ((child as any).type === 'Group') {
                ids.push(...this.collectStyleIds(child as ErdblickStyleGroup));
            } else {
                ids.push((child as ErdblickStyle).id);
            }
        }
        return ids;
    }

    /** Reapplies a style after one of its option controls changed. */
    toggleOption(styleId: string) {
        this.applyStyleConfig(styleId);
    }

    /** Clears the updated-style flags after the user acknowledged them. */
    resetUpdatedStyleIds() {
        this.styleService.updateStyleHashes();
        this.warningDialogVisible = false;
        this.refreshUpdatedStylesDialogVisibility();
    }

    /** Returns builtin styles that were modified locally and updated on the server. */
    getUpdatedModifiedStyles(): UpdatedModifiedStyleEntry[] {
        return this.styleService.getUpdatedModifiedStyles();
    }

    /** Opens style comparison for the "Modified" tag next to a builtin style. */
    openCompareFromModifiedTag(event: MouseEvent, styleId: string) {
        event.stopPropagation();
        this.openStyleCompareDialog(styleId, false);
    }

    /** Opens read-only comparison between an overriding additional style and its base style. */
    openCompareFromAdditionalTag(event: MouseEvent, styleId: string) {
        event.stopPropagation();
        const style = this.styleService.styles.get(styleId);
        const baseSource = this.styleService.getOverriddenBaseStyleSource(styleId);
        if (!style || !baseSource) {
            return;
        }
        this.styleCompareStyleId = style.id;
        this.styleCompareLeftLabel = "Base Style";
        this.styleCompareRightLabel = "Additional Style";
        this.styleCompareLeftSource = baseSource;
        this.styleCompareRightSource = style.source;
        this.styleCompareLeftModified = false;
        this.styleCompareReadOnly = true;
        this.styleCompareDialogVisible = true;
    }

    /** Opens style comparison for an entry in the updated-styles dialog. */
    openCompareFromUpdatedChip(event: Event, styleIdOrUrl: string) {
        event.stopPropagation();
        this.openStyleCompareDialog(styleIdOrUrl, true);
    }

    /** Applies edits from the compare dialog back into the selected builtin style. */
    applyComparedStyle() {
        if (this.styleCompareReadOnly || !this.styleCompareLeftModified || !this.styleCompareStyleId) {
            return;
        }
        const leftSource = this.getComparedLeftSource();
        if (!leftSource) {
            this.messageService.showError("Cannot apply an empty style definition.");
            return;
        }
        const report = this.styleService.validateStyleSource(
            leftSource,
            this.styleService.createEditorSourceRef(this.styleCompareStyleId, leftSource));
        if (!report.valid) {
            this.showValidationFailure(report);
            return;
        }
        const newStyleId = this.styleService.setStyleSource(this.styleCompareStyleId, leftSource, true);
        if (!newStyleId) {
            this.messageService.showError(`Could not apply compared style changes to ${this.styleCompareStyleId}.`);
            return;
        }
        this.styleCompareStyleId = newStyleId;
        this.styleCompareLeftSource = leftSource;
        this.styleCompareRightSource = this.styleService.styles.get(newStyleId)?.source ?? leftSource;
        this.styleCompareLeftModified = false;
        this.refreshUpdatedStylesDialogVisibility();
        this.setupCompareView();
    }

    /** Closes the compare dialog or discards unsaved left-side edits first. */
    closeOrDiscardComparedStyle(event: MouseEvent) {
        event.stopPropagation();
        if (this.styleCompareReadOnly) {
            this.styleCompareDialog?.close(event);
            return;
        }
        if (this.styleCompareLeftModified) {
            this.discardComparedStyleEdits();
            return;
        }
        this.styleCompareDialog?.close(event);
    }

    /** Exports the style currently shown in the compare dialog. */
    exportComparedStyle() {
        if (this.styleCompareReadOnly || !this.styleCompareStyleId) {
            return;
        }
        this.exportStyle(this.styleCompareStyleId);
    }

    /** Resets the builtin style currently shown in the compare dialog. */
    resetComparedStyle() {
        if (this.styleCompareReadOnly || !this.styleCompareStyleId) {
            return;
        }
        const restoredStyleId = this.styleService.resetModifiedBuiltinStyle(this.styleCompareStyleId);
        if (!restoredStyleId) {
            this.messageService.showError(`Could not reset style ${this.styleCompareStyleId}.`);
            return;
        }
        this.styleCompareStyleId = restoredStyleId;
        this.styleCompareDialogVisible = false;
        this.refreshUpdatedStylesDialogVisibility();
        this.mapService.scheduleUpdate();
    }

    styleIssueCount(issues: StyleValidationIssue[]): number {
        return issues.filter(issue => issue.severity === 'error').length;
    }

    filteredStyleIssues(issues: StyleValidationIssue[]): StyleValidationIssue[] {
        const filterText = this.styleIssueFilter.trim().toLowerCase();
        return issues.filter(issue => {
            if (this.styleErrorsOnly && issue.severity !== 'error') {
                return false;
            }
            if (!filterText) {
                return true;
            }
            const haystack = [
                issue.severity,
                issue.impact,
                issue.source.styleName,
                issue.source.url,
                issue.source.configId,
                issue.rulePath,
                issue.property,
                issue.message,
                issue.detail,
                issue.expression
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(filterText);
        });
    }

    trackByStyleIssue = (index: number, issue: StyleValidationIssue): string => {
        return `${issue.id}:${index}`;
    };

    formatIssueTime(issue: StyleValidationIssue): string {
        return new Date(issue.at).toLocaleTimeString();
    }

    formatIssueLocation(issue: StyleValidationIssue): string {
        if (!issue.location?.line) {
            return '';
        }
        return issue.location.column ? `${issue.location.line}:${issue.location.column}` : `${issue.location.line}`;
    }

    validationErrorCount(report: StyleValidationReport): number {
        return report.issues.filter(issue => issue.severity === 'error').length;
    }

    firstValidationErrors(report: StyleValidationReport): StyleValidationIssue[] {
        return report.issues.filter(issue => issue.severity === 'error').slice(0, 6);
    }

    openStyleErrorsTab(): void {
        this.stylesDialogTab = 'errors';
        this.stylesDialogVisible = true;
    }

    private showValidationFailure(report: StyleValidationReport): void {
        this.lastEditorValidationReport = report;
        this.styleValidationDialogVisible = true;
        this.sourceWasModified = true;
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;

    styleTestIdSuffix(styleId: string): string {
        return styleId
            .trim()
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'unknown';
    }

    /** Promotes the editor discard-warning dialog above other overlays. */
    protected onWarningShow() {
        this.dialogStack.bringToFront(this.warningDialog);
    }

    /** Initializes compare-dialog state from a builtin style id or builtin style URL. */
    private openStyleCompareDialog(styleIdOrUrl: string, fromUpdatedModifiedDialog: boolean) {
        const style = this.styleService.styles.get(styleIdOrUrl)
            ?? Array.from(this.styleService.styles.values()).find(
                s => !s.imported && s.url === styleIdOrUrl
            );
        if (!style || style.imported) {
            this.messageService.showError(`Style comparison is only available for builtin styles.`);
            return;
        }
        const baselineSource = this.styleService.getBuiltinBaselineSource(style.id);
        if (!baselineSource) {
            this.messageService.showError(`Could not find original source for style ${style.id}.`);
            return;
        }
        this.styleCompareStyleId = style.id;
        this.styleCompareLeftLabel = fromUpdatedModifiedDialog ? "Updated Style" : "Original Style";
        this.styleCompareRightLabel = "Modified Style";
        this.styleCompareLeftSource = baselineSource;
        this.styleCompareRightSource = style.source;
        this.styleCompareLeftModified = false;
        this.styleCompareReadOnly = false;
        this.styleCompareDialogVisible = true;
    }

    /** Creates or recreates the CodeMirror merge view used by the compare dialog. */
    private setupCompareView() {
        const host = this.styleCompareHost?.nativeElement;
        if (!host || !this.styleCompareStyleId || !this.styleCompareDialogVisible) {
            return;
        }
        const compareTheme = this.currentCodeMirrorTheme();
        this.styleCompareView?.destroy();
        this.styleCompareView = undefined;
        host.innerHTML = "";

        const leftEditorExtensions = [
            basicSetup,
            yaml(),
            this.compareThemeCompartmentA.of(compareTheme),
        ];
        if (this.styleCompareReadOnly) {
            leftEditorExtensions.push(EditorState.readOnly.of(true));
        } else {
            leftEditorExtensions.push(EditorView.updateListener.of(update => {
                if (!update.docChanged) {
                    return;
                }
                this.ngZone.run(() => {
                    this.styleCompareLeftModified = this.getComparedLeftSource() !== this.styleCompareLeftSource;
                });
            }));
        }

        this.styleCompareView = new MergeView({
            parent: host,
            gutter: true,
            ...(this.styleCompareReadOnly ? {} : {revertControls: "b-to-a" as const}),
            a: {
                doc: this.styleCompareLeftSource,
                extensions: leftEditorExtensions
            },
            b: {
                doc: this.styleCompareRightSource,
                extensions: [
                    basicSetup,
                    yaml(),
                    this.compareThemeCompartmentB.of(compareTheme),
                    EditorState.readOnly.of(true)
                ]
            }
        });
        this.observeCompareTheme();
    }

    /** Restores the original left-side compare source after discard. */
    private discardComparedStyleEdits() {
        if (!this.styleCompareView) {
            this.styleCompareLeftModified = false;
            return;
        }
        const leftEditor = this.styleCompareView.a;
        leftEditor.dispatch({
            changes: {
                from: 0,
                to: leftEditor.state.doc.length,
                insert: this.styleCompareLeftSource
            }
        });
        this.styleCompareLeftModified = false;
    }

    /** Returns the trimmed left-side source currently shown in the compare view. */
    private getComparedLeftSource(): string {
        return this.styleCompareView?.a.state.doc.toString().replace(/\n+$/, '')
            ?? this.styleCompareLeftSource.replace(/\n+$/, '');
    }

    /** Shows or hides the updated-styles dialog depending on current lifecycle state. */
    private refreshUpdatedStylesDialogVisibility() {
        this.styleUpdateDialogVisible = this.styleService.getUpdatedModifiedStyles().length > 0;
    }

    /** Tracks dark-mode changes so the compare editors stay aligned with the app theme. */
    private observeCompareTheme() {
        const root = document.documentElement;
        this.compareModeObserver?.disconnect();
        this.compareModeObserver = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type !== 'attributes' || record.attributeName !== 'class') {
                    continue;
                }
                const theme = this.currentCodeMirrorTheme();
                this.styleCompareView?.a.dispatch({
                    effects: this.compareThemeCompartmentA.reconfigure(theme)
                });
                this.styleCompareView?.b.dispatch({
                    effects: this.compareThemeCompartmentB.reconfigure(theme)
                });
            }
        });
        this.compareModeObserver.observe(root, {attributes: true, attributeFilter: ['class']});
    }

    /** Returns the CodeMirror theme extension matching the current app theme. */
    private currentCodeMirrorTheme() {
        const isDark = document.documentElement.classList.contains(this.DARK_MODE_CLASS);
        const lightTheme = EditorView.theme({}, {dark: false});
        return isDark ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)];
    }
}
