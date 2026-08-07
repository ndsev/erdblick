import {Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild} from "@angular/core";
import {InfoMessageService} from "../shared/info.service";
import {MapViewStateService, ViewRecalculationReason} from "../mapview/map-view-state.service";
import {StyleService} from "./style.service";
import {ErdblickStyleGroup, ErdblickStyle, UpdatedModifiedStyleEntry} from "./style.service";
import {
    AppStateService,
    STYLE_EDITOR_DIALOG_LAYOUT_ID,
    STYLE_PRESET_EDITOR_DIALOG_LAYOUT_ID,
    STYLES_DIALOG_LAYOUT_ID
} from "../shared/appstate.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {KeyValue} from "@angular/common";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {EditorService} from "../shared/editor.service";
import {filter} from "rxjs/operators";
import {layerPresetNode, removeGroupPrefix} from "../mapdata/map.tree.model"
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
import {StyleEditorRequestService} from "./style-editor-request.service";
import {
    QuickStyleProjection,
    QuickStyleWarning,
    projectStyleSourceToQuick,
    updateStyleSourceFromQuick
} from "../search/search-style-sheet.converter";
import {
    FeatureSearchStyleRuleDraft,
    SearchStyleRuleDraftCodec
} from "../search/search-style-rule-editor.model";
import {MapPresetService} from "./map-preset.service";
import {MapPresetDefinition, MapPresetIssue} from "./map-preset.model";
import {MapInfoService} from "../mapdata/map-info.service";

interface QuickPresetOption {
    key: string;
    label: string;
    layerId: string;
    styleId: string;
    presetId: string;
}


@Component({
    selector: 'style-panel',
    template: `
        <app-dialog class="styles-dialog" data-testid="styles-dialog" header="Style Sheets" [(visible)]="stylesDialogVisible"
                  [modal]="false" [style]="{ 'min-width': 'min(38em, calc(100vw - 1em))', 'width': 'min(72em, 92vw)' }"
                  #styles [closeOnEscape]="false"
                  [persistLayout]="true" [layoutId]="stylesDialogLayoutId"
                  (onShow)="onStylesDialogShow()">
            <p-tabs [(value)]="stylesDialogTab" class="style-sheets-tabs" data-testid="style-sheets-tabs">
                <p-tablist>
                    <p-tab value="styles">Styles</p-tab>
                    <p-tab value="presets" data-testid="style-presets-tab">
                        <span>Map Presets </span>
                        @if (presetService.issues$ | async; as presetIssues) {
                            @if (presetIssues.length) {
                                <p-badge [value]="presetIssues.length"/>
                            }
                        }
                    </p-tab>
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
                                                @if (node.category === 'search') {
                                                    <p-tag class="search-style-tag"
                                                           severity="danger" value="Search" [rounded]="true"/>
                                                }
                                                @if (node.modified && !node.imported) {
                                                    <p-tag class="modified-style-tag"
                                                           severity="warn" value="Modified" [rounded]="true"
                                                           (click)="openCompareFromModifiedTag($event, node.id)"/>
                                                }
                                                @if (styleErrorCount(node) > 0) {
                                                    <span onEnterClick
                                                          class="material-symbols-outlined style-validation-error-icon"
                                                          [attr.data-testid]="'style-validation-error-button-' + styleTestIdSuffix(node.id)"
                                                          pTooltip="Open style validation errors"
                                                          tooltipPosition="bottom"
                                                          tabindex="0" style="font-size: 1.5em"
                                                          (click)="openStyleErrorsForStyle($event, node)">
                                                        error
                                                    </span>
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
                    <p-tabpanel value="presets">
                        <div class="style-presets-tab" data-testid="style-presets-panel">
                            <div class="style-presets-toolbar">
                                <p-button label="Add" icon="pi pi-plus"
                                          data-testid="style-preset-add-button"
                                          [disabled]="presetEditorSourceModified"
                                          (click)="toggleQuickPresetForm()"/>
                                <p-button label="Edit raw map presets" icon="pi pi-file-edit"
                                          data-testid="style-preset-raw-edit-button"
                                          (click)="openPresetEditor()"/>
                                @if (presetService.hasLocalOverride) {
                                    <p-tag severity="info" value="Local override" [rounded]="true"/>
                                }
                            </div>

                            @if (quickPresetFormVisible) {
                                <div class="quick-preset-form" data-testid="style-preset-add-form">
                                    <p-iftalabel>
                                        <input id="quick-preset-name" pInputText
                                               data-testid="style-preset-name"
                                               [(ngModel)]="quickPresetName"/>
                                        <label for="quick-preset-name">Preset name</label>
                                    </p-iftalabel>
                                    <p-iftalabel class="quick-preset-options-select">
                                        <p-multiSelect inputId="quick-preset-options"
                                                       data-testid="style-preset-options"
                                                       [options]="quickPresetOptionChoices"
                                                       [(ngModel)]="quickPresetSelectedOptionKeys"
                                                       optionLabel="label"
                                                       optionValue="key"
                                                       [filter]="true"
                                                       [showToggleAll]="true"
                                                       [maxSelectedLabels]="2"
                                                       selectedItemsLabel="{0} layer presets"
                                                       placeholder="Select layer presets"
                                                       appendTo="body"/>
                                        <label for="quick-preset-options">Layer presets</label>
                                    </p-iftalabel>
                                    <div class="quick-preset-actions">
                                        <p-button label="Save" icon="pi pi-check"
                                                  data-testid="style-preset-save-button"
                                                  [disabled]="!canSaveQuickPreset()"
                                                  (click)="saveQuickPreset()"/>
                                        <p-button label="Cancel" icon="pi pi-times"
                                                  severity="secondary"
                                                  (click)="closeQuickPresetForm()"/>
                                    </div>
                                </div>
                            }

                            @if (presetService.issues$ | async; as presetIssues) {
                                @if (presetIssues.length) {
                                    <div class="style-preset-issues" data-testid="style-preset-issues">
                                        @for (issue of presetIssues; track $index) {
                                            <p-message severity="error"
                                                       [text]="presetIssueText(issue)"/>
                                        }
                                    </div>
                                }
                            }

                            <div class="style-preset-list">
                                @for (preset of presetService.presets$ | async; track preset.id) {
                                    <div class="style-preset-list-row"
                                         [attr.data-testid]="'style-preset-definition-' + preset.id">
                                        <p-toggleswitch
                                            [inputId]="'style-preset-enabled-' + preset.id"
                                            [ngModel]="presetService.isAvailable(preset)"
                                            [disabled]="presetEditorSourceModified"
                                            (ngModelChange)="setPresetAvailability(preset.id, $event)"/>
                                        <label [for]="'style-preset-enabled-' + preset.id">
                                            <strong>{{ preset.name }}</strong>
                                            <span>{{ mapPresetLayersLabel(preset) }}</span>
                                        </label>
                                        <p-tag severity="secondary"
                                               [value]="preset.layerPresets.length + ' layer presets'"
                                               [rounded]="true"/>
                                    </div>
                                } @empty {
                                    <div class="styles-empty">No map presets configured.</div>
                                }
                            </div>
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
                                        <tr onEnterClick tabindex="0" class="style-error-row"
                                            [ngClass]="'style-issue-' + issue.severity"
                                            (click)="openStyleIssue(issue)">
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
            <p-tabs [(value)]="styleEditorTab" class="style-editor-tabs" data-testid="style-editor-tabs">
                <p-tablist>
                    @if (styleEditorQuickAvailable) {
                        <p-tab value="quick">Quick</p-tab>
                    }
                    <p-tab value="advanced">Advanced</p-tab>
                </p-tablist>
                <p-tabpanels>
                    @if (styleEditorQuickAvailable) {
                        <p-tabpanel value="quick" class="style-editor-quick-panel">
                            <div class="style-editor-quick-content"
                                 [class.read-only]="quickProjectionStale">
                                @if (quickProjectionStale) {
                                    <div class="style-editor-quick-stale">
                                        Quick is read-only until Advanced contains valid YAML: {{ quickProjectionError }}
                                    </div>
                                }
                                <search-style-rule-editor
                                    [drafts]="quickRuleDrafts"
                                    (draftsChange)="onQuickRuleDraftsChange($event)"
                                    [fieldOptions]="[]"
                                    [completionOwnerPrefix]="'style-editor-quick'"
                                    [completionZIndex]="31050"
                                    [showRuleNames]="false"
                                    [sourceRuleIndices]="quickRuleSourceIndicesByDraftId"
                                    [readOnlyRuleIndices]="quickReadOnlyRuleIndices"
                                    [canRefreshValueSummaries]="false">
                                </search-style-rule-editor>
                                @if (quickWarnings.length) {
                                    <div class="style-editor-quick-warnings">
                                        <h3>Quick editing notes</h3>
                                        <ul>
                                            @for (warning of quickWarnings; track warning.path + ':' + warning.code) {
                                                <li><code>{{ warning.path }}</code> — {{ warning.message }}</li>
                                            }
                                        </ul>
                                    </div>
                                }
                            </div>
                        </p-tabpanel>
                    }
                    <p-tabpanel value="advanced" class="style-editor-advanced-panel">
                        <editor [sessionId]="styleEditorSessionId"></editor>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            <div class="editor-actions style-editor-actions">
                <div class="editor-actions-left">
                    <p-button
                        [attr.data-testid]="canSaveCurrentStyleToSource() ? 'style-editor-save-source-button' : 'style-editor-apply-button'"
                        (click)="saveOrApplyEditedStyle()"
                        [label]="canSaveCurrentStyleToSource() ? 'Save to Source' : 'Apply'"
                        [icon]="canSaveCurrentStyleToSource() ? 'pi pi-save' : 'pi pi-check'"
                        [disabled]="canSaveCurrentStyleToSource() ? !currentStyleHasSourceChanges() : !sourceWasModified"
                        [pTooltip]="canSaveCurrentStyleToSource() ? styleSourceSaveTooltip() : ''"></p-button>
                    <p-button data-testid="style-editor-close-button" (click)="closeEditorDialog($event)"
                              [label]='sourceWasModified ? "Discard" : "Close"'
                              icon="pi pi-times"></p-button>
                    <div class="editor-shortcuts">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to {{ canSaveCurrentStyleToSource() ? 'save to source' : 'apply changes' }}</div>
                        <div>Press <span style="color: grey">Esc</span> to quit</div>
                    </div>
                </div>
                <div class="editor-actions-right">
                    <p-button data-testid="style-editor-export-button" (click)="exportStyle(stateService.styleEditorTargetId ?? '')"
                              [disabled]="sourceWasModified || !stateService.styleEditorTargetId"
                              label="Export" icon="pi pi-file-export">
                    </p-button>
                    <p-button data-testid="style-editor-help-button" (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
                </div>
            </div>
        </app-dialog>
        <app-dialog header="Map Presets" [(visible)]="presetEditorVisible" [modal]="false"
                    #presetEditorDialog data-testid="style-preset-editor-dialog"
                    class="editor-dialog style-preset-editor-dialog"
                    [closable]="false" [closeOnEscape]="false"
                    [persistLayout]="true" [layoutId]="stylePresetEditorDialogLayoutId"
                    (onShow)="onPresetEditorDialogShow()">
            <editor [sessionId]="presetEditorSessionId"></editor>
            <div class="editor-actions style-editor-actions">
                <div class="editor-actions-left">
                    <p-button data-testid="style-preset-editor-apply-button"
                              label="Apply" icon="pi pi-check"
                              [disabled]="!presetEditorSourceModified"
                              (click)="applyPresetEditorSource()"/>
                    <p-button data-testid="style-preset-editor-close-button"
                              [label]="presetEditorSourceModified ? 'Discard' : 'Close'"
                              icon="pi pi-times"
                              (click)="closePresetEditor($event)"/>
                </div>
                <div class="editor-actions-right">
                    <p-button data-testid="style-preset-editor-reset-button"
                              label="Reset to Configured" icon="pi pi-refresh"
                              [disabled]="!presetService.hasLocalOverride && !presetEditorSourceModified"
                              (click)="resetPresetEditorToConfigured()"/>
                </div>
            </div>
        </app-dialog>
        <app-dialog header="Discard preset edits?" [(visible)]="presetEditorDiscardDialogVisible"
                    [modal]="true" [closeOnEscape]="false" #presetEditorDiscardDialog>
            <p>The raw preset source contains unapplied changes.</p>
            <div class="dialog-controls">
                <p-button label="Discard" severity="danger"
                          (click)="discardPresetEditorChanges($event)"/>
                <p-button label="Cancel"
                          (click)="presetEditorDiscardDialog.close($event)"/>
            </div>
        </app-dialog>
        <app-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog 
                  [closeOnEscape]="false" (onShow)="onWarningShow()">
            <p>You have already edited the style data. Do you want to save the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="saveOrApplyEditedStyle(); warningDialog.close($event)" label="Save"></p-button>
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
    readonly stylePresetEditorDialogLayoutId = STYLE_PRESET_EDITOR_DIALOG_LAYOUT_ID;
    readonly styleEditorSessionId = 'style-editor';
    readonly presetEditorSessionId = 'map-presets-editor';
    warningDialogVisible: boolean = false;
    styleUpdateDialogVisible: boolean = false;
    styleEditorSourceSubscription: Subscription = new Subscription();
    styleEditorSaveSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;
    private styleEditorOriginalSource: string = '';
    styleEditorTab: "quick" | "advanced" = "quick";
    styleEditorQuickAvailable = false;
    quickRuleDrafts: FeatureSearchStyleRuleDraft[] = [];
    quickWarnings: QuickStyleWarning[] = [];
    quickReadOnlyRuleIndices: number[] = [];
    quickProjectionStale = false;
    quickProjectionError = "";
    private quickProjection?: QuickStyleProjection;
    private quickRuleSourceIndices = new Map<number, number>();
    quickRuleSourceIndicesByDraftId: Record<number, number> = {};
    private readonly quickRuleDraftCodec = new SearchStyleRuleDraftCodec();
    private quickProjectionRefreshTimer?: ReturnType<typeof setTimeout>;
    private updatingSourceFromQuick = false;
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
    private readonly styleEditorRequestSubscription: Subscription;
    stylesDialogTab: 'styles' | 'presets' | 'errors' = 'styles';
    styleIssueFilter: string = '';
    styleErrorsOnly: boolean = false;
    styleValidationDialogVisible: boolean = false;
    lastEditorValidationReport?: StyleValidationReport;
    quickPresetFormVisible = false;
    quickPresetName = "";
    quickPresetSelectedOptionKeys: string[] = [];
    quickPresetOptionChoices: QuickPresetOption[] = [];
    presetEditorVisible = false;
    presetEditorDiscardDialogVisible = false;
    presetEditorSourceModified = false;
    private presetEditorOriginalSource = "";
    private presetEditorSourceSubscription = new Subscription();
    private presetEditorSaveSubscription = new Subscription();
    private readonly presetMapSubscription: Subscription;

    @ViewChild('styleMenu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('styles') stylesDialog: AppDialogComponent | undefined;
    @ViewChild('editorDialog') editorDialog: AppDialogComponent | undefined;
    @ViewChild('warningDialog') warningDialog: AppDialogComponent | undefined;
    @ViewChild('styleValidationDialog') styleValidationDialog: AppDialogComponent | undefined;
    @ViewChild('styleCompareDialog') styleCompareDialog: AppDialogComponent | undefined;
    @ViewChild('styleCompareHost') styleCompareHost?: ElementRef<HTMLDivElement>;
    @ViewChild('presetEditorDialog') presetEditorDialog: AppDialogComponent | undefined;
    @ViewChild('presetEditorDiscardDialog') presetEditorDiscardDialog: AppDialogComponent | undefined;

    // Group visibility is derived from leaf styles; bind directly to node.visible.

    constructor(public mapService: MapViewStateService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public styleValidationReportService: StyleValidationReportService,
                public stateService: AppStateService,
                public editorService: EditorService,
                public presetService: MapPresetService,
                private readonly mapInfoService: MapInfoService,
                private dialogStack: DialogStackService,
                private ngZone: NgZone,
                styleEditorRequestService: StyleEditorRequestService) {
        this.stateService.ready.pipe(filter(state => state)).subscribe(_ => {
            this.refreshUpdatedStylesDialogVisibility();
        });
        this.styleEditorRequestSubscription = styleEditorRequestService.requests.subscribe(styleId => {
            this.showStyleEditor(styleId);
        });
        this.presetMapSubscription = this.mapInfoService.maps$.subscribe(() => {
            if (this.quickPresetFormVisible) {
                this.refreshQuickPresetOptions();
            }
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
        this.styleEditorRequestSubscription.unsubscribe();
        if (this.quickProjectionRefreshTimer) {
            clearTimeout(this.quickProjectionRefreshTimer);
        }
        this.presetEditorSourceSubscription.unsubscribe();
        this.presetEditorSaveSubscription.unsubscribe();
        this.presetMapSubscription.unsubscribe();
        this.editorService.closeSession(this.styleEditorSessionId);
        this.editorService.closeSession(this.presetEditorSessionId);
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

    /** Promotes the raw preset editor above the styles dialog when shown. */
    onPresetEditorDialogShow(): void {
        this.dialogStack.bringToFront(this.presetEditorDialog);
    }

    /** Opens or closes the compact GUI form used to append one local preset. */
    toggleQuickPresetForm(): void {
        if (this.quickPresetFormVisible) {
            this.closeQuickPresetForm();
            return;
        }
        this.quickPresetFormVisible = true;
        this.refreshQuickPresetOptions();
    }

    /** Clears and hides the quick preset form. */
    closeQuickPresetForm(): void {
        this.quickPresetFormVisible = false;
        this.quickPresetName = "";
        this.quickPresetSelectedOptionKeys = [];
        this.refreshQuickPresetOptions();
    }

    /** Rebuilds map-agnostic component choices from embedded presets visible in the catalog. */
    refreshQuickPresetOptions(): void {
        const choices = new Map<string, QuickPresetOption>();
        for (const layer of this.mapInfoService.maps.allFeatureLayers()) {
            for (const preset of layerPresetNode(layer)?.presets ?? []) {
                const key = JSON.stringify([layer.id, preset.styleId, preset.id]);
                if (!choices.has(key)) {
                    choices.set(key, {
                        key,
                        label: `${layer.id} — ${preset.styleId} — ${preset.name}`,
                        layerId: layer.id,
                        styleId: preset.styleId,
                        presetId: preset.id
                    });
                }
            }
        }
        this.quickPresetOptionChoices = [...choices.values()].sort((lhs, rhs) => lhs.label.localeCompare(rhs.label));
        const validKeys = new Set(this.quickPresetOptionChoices.map(option => option.key));
        this.quickPresetSelectedOptionKeys = this.quickPresetSelectedOptionKeys.filter(key => validKeys.has(key));
    }

    /** Returns selected quick-form options in their stable stylesheet order. */
    quickPresetSelectedOptions(): QuickPresetOption[] {
        const selectedKeys = new Set(this.quickPresetSelectedOptionKeys);
        return this.quickPresetOptionChoices.filter(option => selectedKeys.has(option.key));
    }

    /** Returns whether the quick form is complete and assigns each layer at most once. */
    canSaveQuickPreset(): boolean {
        const name = this.quickPresetName.trim();
        const selectedOptions = this.quickPresetSelectedOptions();
        if (this.presetEditorSourceModified
            || !name
            || !selectedOptions.length
            || this.presetService.presets.some(preset =>
                preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            return false;
        }
        return new Set(selectedOptions.map(option => option.layerId)).size === selectedOptions.length;
    }

    /** Validates and appends the quick-form definition to the normalized map-preset catalog. */
    saveQuickPreset(): void {
        if (!this.canSaveQuickPreset()) {
            return;
        }
        const selectedOptions = this.quickPresetSelectedOptions();
        const preset: MapPresetDefinition = {
            id: this.nextPresetId(this.quickPresetName),
            name: this.quickPresetName.trim(),
            enabled: true,
            layerPresets: selectedOptions.map(option => ({
                layerId: option.layerId,
                styleId: option.styleId,
                presetId: option.presetId
            }))
        };
        if (this.presetService.addPreset(preset)) {
            this.messageService.showInfo(`Added map preset '${preset.name}'.`);
            this.closeQuickPresetForm();
        } else {
            this.messageService.showError(`Could not add map preset '${preset.name}'.`);
        }
    }

    /** Updates one preset's enabled flag in the combined map-preset AppState. */
    setPresetAvailability(presetId: string, available: boolean): void {
        this.presetService.setAvailable(presetId, available);
    }

    /** Formats the exact schema-level layer targets composed by one map preset. */
    mapPresetLayersLabel(preset: MapPresetDefinition): string {
        return preset.layerPresets.map(component => component.layerId).join(", ");
    }

    /** Formats one preset validation issue with its most specific available identity. */
    presetIssueText(issue: MapPresetIssue): string {
        const prefix = issue.presetId ? `${issue.presetId}: ` : "";
        const suffix = issue.componentIndex === undefined ? "" : ` (component ${issue.componentIndex + 1})`;
        return `${prefix}${issue.message}${suffix}`;
    }

    /** Opens a dedicated raw YAML editor session for the current effective preset source. */
    openPresetEditor(): void {
        this.closeQuickPresetForm();
        this.presetEditorSourceSubscription.unsubscribe();
        this.presetEditorSaveSubscription.unsubscribe();
        this.editorService.createSession({
            id: this.presetEditorSessionId,
            source: this.presetService.source,
            language: "yaml"
        });
        this.presetEditorOriginalSource = this.presetService.source.replace(/\n+$/, "");
        this.presetEditorSourceSubscription = this.editorService
            .getSession(this.presetEditorSessionId)!.source$
            .subscribe(source => {
                this.presetEditorSourceModified =
                    source.replace(/\n+$/, "") !== this.presetEditorOriginalSource;
            });
        this.presetEditorSaveSubscription = this.editorService
            .onSaveRequested(this.presetEditorSessionId)!
            .subscribe(() => this.applyPresetEditorSource());
        this.presetEditorSourceModified = false;
        this.presetEditorVisible = true;
    }

    /** Validates and atomically activates the current raw preset source. */
    applyPresetEditorSource(): void {
        const source = this.editorService.getSessionSource(this.presetEditorSessionId);
        if (!this.presetService.applyOverrideSource(source)) {
            this.messageService.showError("The preset source is invalid. The previous presets remain active.");
            return;
        }
        this.presetEditorOriginalSource = source.replace(/\n+$/, "");
        this.presetEditorSourceModified = false;
        this.messageService.showInfo("Applied map presets.");
    }

    /** Restores the configured baseline in both the effective service and raw editor. */
    resetPresetEditorToConfigured(): void {
        this.presetService.resetToConfigured();
        this.presetEditorOriginalSource = this.presetService.source.replace(/\n+$/, "");
        this.editorService.updateSessionSource(this.presetEditorSessionId, this.presetService.source);
        this.presetEditorSourceModified = false;
        this.messageService.showInfo("Restored configured map presets.");
    }

    /** Closes the raw editor or asks for confirmation before discarding unsaved changes. */
    closePresetEditor(event: Event): void {
        event.stopPropagation();
        if (this.presetEditorSourceModified) {
            this.presetEditorDiscardDialogVisible = true;
            return;
        }
        this.closePresetEditorSession(event);
    }

    /** Discards the raw buffer and closes both the warning and editor dialogs. */
    discardPresetEditorChanges(event: Event): void {
        event.stopPropagation();
        this.presetEditorSourceModified = false;
        this.presetEditorDiscardDialog?.close(event);
        this.closePresetEditorSession(event);
    }

    /** Releases the raw editor session after a confirmed close. */
    private closePresetEditorSession(event: Event): void {
        this.presetEditorDialog?.close(event);
        this.presetEditorSourceSubscription.unsubscribe();
        this.presetEditorSaveSubscription.unsubscribe();
        this.editorService.closeSession(this.presetEditorSessionId);
        this.presetService.restoreEffectiveIssues();
    }

    /** Derives a unique stable ID from a user-visible preset name. */
    private nextPresetId(name: string): string {
        const base = name.trim().toLocaleLowerCase()
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "preset";
        const ids = new Set(this.presetService.presets.map(preset => preset.id));
        let candidate = base;
        let suffix = 2;
        while (ids.has(candidate)) {
            candidate = `${base}-${suffix++}`;
        }
        return candidate;
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
                    this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId != id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, false, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, true, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
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
            this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
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
            event.xhr = new XMLHttpRequest();
            this.styleService.importStyleYamlFile(file)
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
                })
                .finally(() => {
                    this.styleUploader?.clear();
                });
        }
    }

    /** Removes an imported style. */
    removeStyle(styleId: string) {
        this.styleService.deleteStyle(styleId);
    }

    /** Opens the style editor for one style and tracks dirty-state changes. */
    showStyleEditor(styleId: string) {
        this.openStyleEditor(styleId);
    }

    /** Opens or reuses an editor session while preserving unsaved edits in another style. */
    private openStyleEditor(styleId: string): boolean {
        const currentTargetId = this.stateService.styleEditorTargetId;
        const sameEditorSession = this.styleEditorVisible
            && currentTargetId === styleId
            && this.editorService.hasSession(this.styleEditorSessionId);
        if (sameEditorSession) {
            return true;
        }
        if (this.styleEditorVisible
            && this.sourceWasModified
            && currentTargetId !== styleId) {
            this.messageService.showWarning('Discard or apply the current style edits before opening another style.');
            return false;
        }
        if (!this.prepareStyleEditorSession(styleId)) {
            this.messageService.showError(`Could not load style source for ${styleId}.`);
            return false;
        }
        this.styleEditorVisible = true;
        return true;
    }

    /** Applies the current editor contents to the selected style. */
    applyEditedStyle(): string | undefined {
        const styleId = this.stateService.styleEditorTargetId;
        const styleData = this.editorService.getSessionSource(this.styleEditorSessionId).replace(/\n+$/, '');
        if (!styleId) {
            this.messageService.showError(`No cached style ID found!`);
            return undefined;
        }
        if (!styleData) {
            this.messageService.showError(`Cannot apply an empty style definition.`);
            return undefined;
        }
        if (!this.styleService.styles.has(styleId)) {
            this.messageService.showError(`Could not apply changes to style: ${styleId}. Failed to access!`)
            return undefined;
        }
        const report = this.styleService.validateStyleSource(
            styleData,
            this.styleService.createEditorSourceRef(styleId, styleData));
        if (!report.valid) {
            this.showValidationFailure(report);
            return undefined;
        }
        const newStyleId = this.styleService.setStyleSource(styleId, styleData);
        // If there is no style ID returned, then setStyleSource failed.
        if (newStyleId) {
            this.stateService.styleEditorTargetId = newStyleId;
            this.sourceWasModified = false;
            this.styleEditorOriginalSource = styleData;
            this.editorService.updateSessionSource(this.styleEditorSessionId, styleData);
            this.refreshUpdatedStylesDialogVisibility();
            return newStyleId;
        }
        return undefined;
    }

    /** Applies pending editor text and persists the resulting style through the writable source mount. */
    async saveEditedStyleToSource(): Promise<void> {
        let styleId = this.stateService.styleEditorTargetId ?? undefined;
        if (this.sourceWasModified) {
            const appliedStyleId = this.applyEditedStyle();
            if (!appliedStyleId) {
                return;
            }
            styleId = appliedStyleId;
        }
        if (!styleId || !this.styleService.canSaveStyleToSource(styleId)) {
            this.messageService.showError("The selected style is not backed by an editable source file.");
            return;
        }
        if (!await this.styleService.saveStyleToSource(styleId)) {
            this.messageService.showError(`Could not save style ${styleId} to its source file.`);
            return;
        }

        const source = this.styleService.styles.get(styleId)?.source;
        if (source !== undefined) {
            this.styleEditorOriginalSource = source.replace(/\n+$/, "");
            this.editorService.updateSessionSource(this.styleEditorSessionId, `${source}\n\n\n\n\n`);
        }
        this.sourceWasModified = false;
        this.refreshUpdatedStylesDialogVisibility();
        this.messageService.showSuccess(`Saved ${styleId} to the mapviewer source configuration.`);
    }

    /** Applies editor changes locally or writes them to source when source editing is enabled. */
    saveOrApplyEditedStyle(): void {
        if (this.canSaveCurrentStyleToSource()) {
            void this.saveEditedStyleToSource();
        } else {
            this.applyEditedStyle();
        }
    }

    /** Returns whether the current style URL belongs to the writable source-style mount. */
    canSaveCurrentStyleToSource(): boolean {
        const styleId = this.stateService.styleEditorTargetId;
        return !!styleId && this.styleService.canSaveStyleToSource(styleId);
    }

    /** Returns whether the editor or applied style differs from its source-file baseline. */
    currentStyleHasSourceChanges(): boolean {
        const styleId = this.stateService.styleEditorTargetId;
        return this.sourceWasModified || (!!styleId && this.styleService.styles.get(styleId)?.modified === true);
    }

    /** Describes the filesystem destination used by the source-save action. */
    styleSourceSaveTooltip(): string {
        const directory = this.styleService.getStyleEditingDirectory();
        return directory ? `Overwrite the YAML file below ${directory}` : "Overwrite the source YAML file";
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
        this.styleEditorQuickAvailable = false;
        this.quickProjection = undefined;
        this.quickRuleDrafts = [];
        this.quickWarnings = [];
        this.quickReadOnlyRuleIndices = [];
        this.quickRuleSourceIndices.clear();
        this.quickRuleSourceIndicesByDraftId = {};
        this.styleEditorSourceSubscription.unsubscribe();
        this.styleEditorSaveSubscription.unsubscribe();
        this.editorService.closeSession(this.styleEditorSessionId);
    }

    /** Recreates the editor session when a persisted style-editor dialog is restored on startup/import. */
    private ensureStyleEditorSession(): void {
        const targetStyleId = this.stateService.styleEditorTargetId;
        if (this.editorService.hasSession(this.styleEditorSessionId)) {
            return;
        }
        if (!targetStyleId) {
            this.styleEditorVisible = false;
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
        return this.prepareStyleEditorSource(source);
    }

    /** Creates a fresh editor session and installs common dirty/save tracking. */
    private prepareStyleEditorSource(source: string): boolean {
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
                if (this.updatingSourceFromQuick) {
                    return;
                }
                if (this.quickProjectionRefreshTimer) {
                    clearTimeout(this.quickProjectionRefreshTimer);
                }
                this.quickProjectionRefreshTimer = setTimeout(() => {
                    this.quickProjectionRefreshTimer = undefined;
                    this.refreshQuickProjection(editedStyleSource);
                }, 150);
            }
        );
        this.styleEditorSaveSubscription.unsubscribe();
        this.styleEditorSaveSubscription = this.editorService.onSaveRequested(this.styleEditorSessionId)?.subscribe(() => {
            this.saveOrApplyEditedStyle();
        }) ?? new Subscription();
        this.sourceWasModified = false;
        this.styleEditorQuickAvailable = !!this.stateService.styleEditorTargetId;
        this.styleEditorTab = this.styleEditorQuickAvailable ? "quick" : "advanced";
        this.refreshQuickProjection(source);
        return true;
    }

    /** Reprojects the authoritative Advanced YAML without replacing the last good view on parse errors. */
    private refreshQuickProjection(source: string): void {
        if (!this.styleEditorQuickAvailable) {
            return;
        }
        try {
            const projection = projectStyleSourceToQuick(source.replace(/\n+$/, ""));
            const drafts = this.quickRuleDraftCodec.toDrafts(
                projection.editableRules.map(projected => projected.rule));
            this.quickRuleSourceIndices.clear();
            drafts.forEach((draft, index) => {
                this.quickRuleSourceIndices.set(draft.id, projection.editableRules[index].sourceIndex);
            });
            this.quickRuleSourceIndicesByDraftId = Object.fromEntries(this.quickRuleSourceIndices);
            this.quickProjection = projection;
            this.quickRuleDrafts = drafts;
            this.quickWarnings = projection.warnings;
            this.quickReadOnlyRuleIndices = projection.readOnlyRuleIndices;
            this.quickProjectionStale = false;
            this.quickProjectionError = "";
        } catch (error) {
            this.quickProjectionStale = true;
            this.quickProjectionError = error instanceof Error ? error.message : String(error);
        }
    }

    /** Patches Quick edits into the YAML AST immediately while retaining unsupported document content. */
    protected onQuickRuleDraftsChange(drafts: FeatureSearchStyleRuleDraft[]): void {
        const projection = this.quickProjection;
        if (!projection || this.quickProjectionStale) {
            return;
        }
        const retainedDraftIds = new Set(drafts.map(draft => draft.id));
        const deletedPartialRules = [...this.quickRuleSourceIndices]
            .filter(([draftId]) => !retainedDraftIds.has(draftId))
            .map(([, sourceIndex]) => projection.editableRules.find(rule => rule.sourceIndex === sourceIndex))
            .filter(rule => rule?.support === "partial");
        if (deletedPartialRules.length > 0) {
            const indices = deletedPartialRules.map(rule => (rule!.sourceIndex + 1)).join(", ");
            if (!window.confirm(
                `Delete YAML rule${deletedPartialRules.length === 1 ? "" : "s"} ${indices}? `
                + "Unsupported properties on the whole rule will also be removed."
            )) {
                this.refreshQuickProjection(this.editorService.getSessionSource(this.styleEditorSessionId));
                return;
            }
        }
        try {
            const semanticRules = this.quickRuleDraftCodec.fromDrafts(drafts);
            const updates = semanticRules.map((rule, index) => ({
                sourceIndex: this.quickRuleSourceIndices.get(drafts[index].id),
                rule
            }));
            const currentSource = this.editorService.getSessionSource(this.styleEditorSessionId).replace(/\n+$/, "");
            const updatedSource = updateStyleSourceFromQuick(currentSource, projection, updates);
            this.updatingSourceFromQuick = true;
            this.editorService.updateSessionSource(this.styleEditorSessionId, updatedSource);
            this.updatingSourceFromQuick = false;
            this.refreshQuickProjection(updatedSource);
        } catch (error) {
            this.updatingSourceFromQuick = false;
            this.messageService.showError(
                `Could not apply the Quick style change: ${error instanceof Error ? error.message : String(error)}`);
            this.refreshQuickProjection(this.editorService.getSessionSource(this.styleEditorSessionId));
        }
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
        this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
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
        this.mapService.requestViewRecalculation(ViewRecalculationReason.StyleChange);
    }

    /** Returns the number of issues associated with a style. */
    styleIssueCount(issues: StyleValidationIssue[]): number {
        return issues.filter(issue => issue.severity === 'error').length;
    }

    /** Returns validation issues that match the active style filters. */
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

    /** Returns the number of error-level issues for a style. */
    styleErrorCount(style: ErdblickStyle): number {
        let count = 0;
        for (const issue of this.styleValidationReportService.reports$.getValue()) {
            if (issue.severity === 'error'
                && issue.phase !== 'runtime'
                && this.issueMatchesStyle(issue, style, true)) {
                ++count;
            }
        }
        return count;
    }

    /** Formats a validation issue timestamp for display. */
    formatIssueTime(issue: StyleValidationIssue): string {
        return new Date(issue.at).toLocaleTimeString();
    }

    /** Formats a validation issue source location for display. */
    formatIssueLocation(issue: StyleValidationIssue): string {
        if (!issue.location?.line) {
            return '';
        }
        return issue.location.column ? `${issue.location.line}:${issue.location.column}` : `${issue.location.line}`;
    }

    /** Returns the number of visible validation errors. */
    validationErrorCount(report: StyleValidationReport): number {
        return report.issues.filter(issue => issue.severity === 'error').length;
    }

    /** Returns the first visible validation errors for the dialog footer. */
    firstValidationErrors(report: StyleValidationReport): StyleValidationIssue[] {
        return report.issues.filter(issue => issue.severity === 'error').slice(0, 6);
    }

    /** Opens the styles dialog on the validation errors tab. */
    openStyleErrorsTab(): void {
        this.stylesDialogTab = 'errors';
        this.stylesDialogVisible = true;
    }

    /** Opens validation errors filtered to a specific style. */
    openStyleErrorsForStyle(event: MouseEvent, style: ErdblickStyle): void {
        event.stopPropagation();
        this.styleIssueFilter = style.id;
        this.styleErrorsOnly = true;
        this.openStyleErrorsTab();
    }

    /** Opens the editor at the location of a validation issue. */
    openStyleIssue(issue: StyleValidationIssue): void {
        const style = this.resolveStyleForIssue(issue);
        if (!style) {
            this.messageService.showError(`Could not find loaded style for ${this.issueSourceLabel(issue)}.`);
            return;
        }

        if (!this.openStyleEditor(style.id)) {
            return;
        }
        this.revealStyleIssueLocation(issue);
    }

    /** Shows the most relevant validation failure to the user. */
    private showValidationFailure(report: StyleValidationReport): void {
        this.lastEditorValidationReport = report;
        this.styleValidationDialogVisible = true;
        this.sourceWasModified = true;
    }

    /** Reveals a validation issue location after the editor is ready. */
    private revealStyleIssueLocation(issue: StyleValidationIssue): void {
        if (!issue.location?.line) {
            this.messageService.showInfo('This style issue has no source location.');
            return;
        }
        /** Moves the editor cursor to the requested validation issue. */
        const reveal = () => this.editorService.revealLocation(this.styleEditorSessionId, {
            line: issue.location!.line!,
            column: issue.location!.column,
            length: issue.location!.length
        });
        window.requestAnimationFrame(reveal);
    }

    /** Finds the style entry associated with a validation issue. */
    private resolveStyleForIssue(issue: StyleValidationIssue): ErdblickStyle | undefined {
        for (const style of this.styleService.styles.values()) {
            if (this.issueMatchesStyle(issue, style, false)) {
                return style;
            }
        }
        return undefined;
    }

    /** Checks whether a validation issue belongs to a style. */
    private issueMatchesStyle(issue: StyleValidationIssue, style: ErdblickStyle, currentSourceOnly: boolean): boolean {
        const source = issue.source;
        const sameHash = !!source.sourceHash && source.sourceHash === style.sourceRef?.sourceHash;
        const sameName = !!source.styleName && source.styleName === style.id;
        const sameUrl = !!source.url && !!style.url && source.url === style.url;
        const sameConfig = !!source.configId
            && (source.configId === style.sourceRef?.configId || source.configId === style.id);

        if (!currentSourceOnly) {
            return sameHash || sameName || sameUrl || sameConfig;
        }
        if (source.sourceKind === 'editor') {
            return sameName && this.stateService.styleEditorTargetId === style.id && this.sourceWasModified;
        }
        if (source.sourceHash && style.sourceRef?.sourceHash) {
            return sameHash;
        }
        return sameName || sameUrl || sameConfig;
    }

    /** Returns the display label for a validation issue source. */
    private issueSourceLabel(issue: StyleValidationIssue): string {
        return issue.source.styleName
            || issue.source.url
            || issue.source.configId
            || issue.source.sourceKind
            || 'style issue';
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;

    /** Builds a stable test id suffix for a style entry. */
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
