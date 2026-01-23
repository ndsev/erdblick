import {Component, HostListener, OnDestroy, ViewChild} from "@angular/core";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {StyleService} from "./style.service";
import {ErdblickStyleGroup, ErdblickStyle} from "./style.service";
import {AppStateService} from "../shared/appstate.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {EditorService} from "../shared/editor.service";
import {filter} from "rxjs/operators";
import {removeGroupPrefix} from "../mapdata/map.tree.model"
import {DialogStackService} from "../shared/dialog-stack.service";


@Component({
    selector: 'style-panel',
    template: `
        <p-dialog class="styles-dialog" header="Style Sheets" [(visible)]="styleService.stylesDialogVisible"
                  [modal]="false" [style]="{ 'min-width': '30em', 'width': '30em' }" #styles [closeOnEscape]="false"
                  (onShow)="onStylesDialogShow()">
            @if (styleService.styleGroups | async; as styleGroups) {
                <ng-container>
                    @if (!styleService.builtinStylesCount && !styleService.importedStylesCount) {
                        <div>No styles loaded.</div>
                    }
                    <div class="styles-container">
                        <p-tree [value]="styleGroups">
                            <!-- Group Node Template -->
                            <ng-template let-node pTemplate="Group">
                            <span>
                                <p-checkbox [ngModel]="node.visible"
                                            (click)="$event.stopPropagation()"
                                            (ngModelChange)="toggleStyleGroup(0, node.id)"
                                            [binary]="true"
                                            [inputId]="node.id"
                                            [name]="node.id" tabindex="0"/>
                                <label [for]="node.id" style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                            </span>
                            </ng-template>
                            <!-- Style Node Template -->
                            <ng-template let-node pTemplate="Style">
                                <div class="flex-container">
                                    <div class="font-bold white-space-nowrap" style="display: flex; align-items: center;">
                                    <span onEnterClick class="material-symbols-outlined menu-toggler"
                                          (click)="showStylesToggleMenu($event, node.id)" tabindex="0">
                                        more_vert
                                    </span>
                                        <span>
                                        <p-checkbox [(ngModel)]="node.visible"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="applyStyleConfig(node.id)"
                                                    [binary]="true"
                                                    [inputId]="node.id"
                                                    [name]="node.id"/>
                                        <label [for]="node.id"
                                               style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                    </span>
                                    </div>
                                    <div class="tree-node-controls">
                                        @if (node.imported) {
                                            <p-button onEnterClick (click)="removeStyle(node.id)"
                                                      icon="pi pi-trash"
                                                      label="" pTooltip="Remove style"
                                                      tooltipPosition="bottom" tabindex="0">
                                            </p-button>
                                        } @else {
                                            <p-button onEnterClick (click)="resetStyle(node.id)"
                                                      icon="pi pi-refresh"
                                                      label="" pTooltip="Reload style from storage"
                                                      tooltipPosition="bottom" tabindex="0">
                                            </p-button>
                                        }
                                        <p-button onEnterClick (click)="showStyleEditor(node.id)"
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
                    </div>
                </ng-container>
            }
            @if (styleService.erroredStyleIds.size > 0) {
                <div class="styles-container">
                    <div *ngFor="let message of styleService.erroredStyleIds | keyvalue: unordered"
                         class="flex-container">
                <span class="font-bold white-space-nowrap" style="margin-left: 0.5em; color: red">
                    {{ message.key }}: {{ message.value }} (see console)
                </span>
                    </div>
                </div>
            }
            <div class="dialog-controls">
                <p-button (click)="styles.close($event)" label="Close" icon="pi pi-times"></p-button>
                <p-fileupload #styleUploader onEnterClick mode="basic" name="demo[]" chooseIcon="pi pi-upload"
                              accept=".yaml" maxFileSize="1048576" fileLimit="1" multiple="false"
                              customUpload="true" (uploadHandler)="importStyle($event)" [auto]="true"
                              class="import-dialog" pTooltip="Import style" tooltipPosition="bottom"
                              chooseLabel="Import Style" tabindex="0"/>
                
                <!--<div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!sourceWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)"
                              [label]='sourceWasModified ? "Discard" : "Cancel"'
                              icon="pi pi-times"></p-button>
                    <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; width: 18em; font-size: 1em;">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                        <div>Press <span style="color: grey">Esc</span> to quit without saving</div>
                    </div>
                </div>
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="exportStyle(styleService.selectedStyleIdForEditing)"
                              [disabled]="sourceWasModified" label="Export" icon="pi pi-file-export"
                              [style]="{margin: '0 0.5em'}">
                    </p-button>
                    <p-button (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
                </div>-->
            </div>
        </p-dialog>
        <p-menu #styleMenu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}" appendTo="body"></p-menu>
        <p-dialog header="Style Editor" [(visible)]="editorService.styleEditorVisible" [modal]="false" #editorDialog
                  class="editor-dialog" appendTo="body" (onShow)="onEditorDialogShow()">
            <editor></editor>
            <div style="margin-top: 0.5em; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!sourceWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)"
                              [label]='sourceWasModified ? "Discard" : "Cancel"'
                              icon="pi pi-times"></p-button>
                    <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; width: 18em; font-size: 1em;">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                        <div>Press <span style="color: grey">Esc</span> to quit</div>
                    </div>
                </div>
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="exportStyle(styleService.selectedStyleIdForEditing)"
                              [disabled]="sourceWasModified" label="Export" icon="pi pi-file-export"
                              [style]="{margin: '0 0.5em'}">
                    </p-button>
                    <p-button (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
                </div>
            </div>
        </p-dialog>
        <p-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog [closeOnEscape]="false">
            <p>You have already edited the style data. Do you want to save the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="applyEditedStyle()" label="Save"></p-button>
                <p-button (click)="warningDialog.close($event)" label="Cancel"></p-button>
                <p-button (click)="discardStyleEdits(); closeEditorDialog($event)" label="Discard"></p-button>
            </div>
        </p-dialog>
        <p-dialog header="Updated Modified Styles" [(visible)]="styleUpdateDialogVisible" [modal]="true"
                  (onHide)="resetUpdatedStyleIds()" #updatedStyleDialog appendTo="body">
            @if (getUpdatedModifiedStyleIds().length > 0) {
                <div class="updated-styles-container">
                    <p>The following styles were updated in the datasource while their modifications persist in local
                        memory:</p>
                    <p-chip *ngFor="let styleId of getUpdatedModifiedStyleIds()" [label]="styleId"/>
                </div>
            }
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="updatedStyleDialog.close($event)" label="Ok"></p-button>
            </div>
        </p-dialog>
    `,
    styles: [`
        .disabled {
            pointer-events: none;
            opacity: 0.5;
        }
    `],
    standalone: false
})
export class StyleComponent implements OnDestroy {
    warningDialogVisible: boolean = false;
    styleUpdateDialogVisible: boolean = false;
    editedStyleSourceSubscription: Subscription = new Subscription();
    savedStyleSourceSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;
    stylesCollapsed: boolean = false;

    @ViewChild('styleMenu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('styles') stylesDialog: Dialog | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    private detachStylesFocusListener?: () => void;
    private detachEditorFocusListener?: () => void;

    // Group visibility is derived from leaf styles; bind directly to node.visible.

    constructor(public mapService: MapDataService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public stateService: AppStateService,
                public editorService: EditorService,
                private dialogStack: DialogStackService) {

        // Group visibility is computed in the service; no local map needed.
        this.editorService.editedSaveTriggered.subscribe(_ => this.applyEditedStyle());
        this.stateService.ready.pipe(filter(state => state)).subscribe(_ => {
            this.styleUpdateDialogVisible = this.styleService.styleHashes.values().some(
                state => state.isUpdated && state.isModified);
        });
    }

    ngOnDestroy() {
        this.detachStylesFocusListener?.();
        this.detachEditorFocusListener?.();
    }

    onStylesDialogShow() {
        this.dialogStack.bringToFront(this.stylesDialog);
        this.bindDialogFocus(this.stylesDialog, 'styles');
    }

    onEditorDialogShow() {
        this.dialogStack.bringToFront(this.editorDialog);
        this.bindDialogFocus(this.editorDialog, 'editor');
    }

    private bindDialogFocus(dialog: Dialog | undefined, kind: 'styles' | 'editor') {
        if (!dialog?.container) {
            return;
        }
        if (kind === 'styles') {
            this.detachStylesFocusListener?.();
            const handler = () => this.dialogStack.bringToFront(dialog);
            dialog.container.addEventListener('mousedown', handler, true);
            this.detachStylesFocusListener = () => {
                dialog.container?.removeEventListener('mousedown', handler, true);
            };
        } else {
            this.detachEditorFocusListener?.();
            const handler = () => this.dialogStack.bringToFront(dialog);
            dialog.container.addEventListener('mousedown', handler, true);
            this.detachEditorFocusListener = () => {
                dialog.container?.removeEventListener('mousedown', handler, true);
            };
        }
    }

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

    resetStyle(styleId: string) {
        this.styleService.reloadStyle(styleId);
        this.styleService.toggleStyle(styleId, true);
    }

    exportStyle(styleId: string) {
        if(!this.styleService.exportStyleYamlFile(styleId)) {
            this.messageService.showError(`Error occurred while trying to export style: ${styleId}`);
        }
    }

    importStyle(event: any) {
        if (event.files && event.files.length > 0) {
            const file: File = event.files[0];
            let styleId = file.name;
            this.styleService.importStyleYamlFile(event, file, this.styleUploader)
                .then((ok) => {
                    if (!ok) {
                        this.messageService.showError(`Could not read empty data for: ${styleId}`);
                    }
                })
                .catch((error) => {
                    this.messageService.showError(`Error occurred while trying to import style: ${styleId}`);
                    console.error(error);
                });
        }
    }

    removeStyle(styleId: string) {
        this.styleService.deleteStyle(styleId);
    }

    showStyleEditor(styleId: string) {
        this.styleService.selectedStyleIdForEditing = styleId;
        this.editorService.datasourcesEditorVisible = false;
        this.editorService.editableData = `${this.styleService.styles.get(styleId)?.source!}\n\n\n\n\n`
        this.editorService.readOnly = false;
        this.editorService.updateEditorState.next(true);
        this.editorService.styleEditorVisible = true;
        this.editedStyleSourceSubscription = this.editorService.editedStateData.subscribe(editedStyleSource => {
            this.sourceWasModified = !(editedStyleSource.replace(/\n+$/, '') == this.editorService.editableData.replace(/\n+$/, ''));
        });
        this.savedStyleSourceSubscription = this.styleService.styleEditedSaveTriggered.subscribe(_ => {
            this.applyEditedStyle();
        });
    }

    applyEditedStyle() {
        const styleId = this.styleService.selectedStyleIdForEditing;
        const styleData = this.editorService.editedStateData.getValue().replace(/\n+$/, '');
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
        const newStyleId = this.styleService.setStyleSource(styleId, styleData);
        // If there is no style ID returned, then setStyleSource failed.
        if (newStyleId) {
            this.styleService.selectedStyleIdForEditing = newStyleId;
            this.sourceWasModified = false;
            this.editorService.editableData = this.editorService.editedStateData.getValue();
        }
    }

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
        this.editedStyleSourceSubscription.unsubscribe();
        this.savedStyleSourceSubscription.unsubscribe();
    }

    discardStyleEdits() {
        this.editorService.updateEditorState.next(false);
        this.sourceWasModified = false;
        this.warningDialogVisible = false;
    }

    @HostListener('window:keydown', ['$event'])
    onWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.editorService.styleEditorVisible) {
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

    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    toggleStyleGroup(viewIndex: number, id: string) {
        if (!id || id === 'ungrouped') {
            return;
        }
        const rootGroups = this.styleService.styleGroups.getValue();
        const group = this.findStyleGroupById(rootGroups, id);
        if (!group || !this.checkIsStyleGroup(group)) {
            return;
        }
        const target = !group.visible;
        const styleIds = this.collectStyleIds(group);
        for (const id of styleIds) {
            this.styleService.toggleStyle(id, target, true);
        }
        this.styleService.reapplyAllStyles();
        this.mapService.scheduleUpdate();
    }

    private checkIsStyleGroup (e: any): e is ErdblickStyleGroup {
        return e.type === "Group";
    }

    private findStyleGroupById(elements: (ErdblickStyleGroup | ErdblickStyle)[], id: string): ErdblickStyleGroup | ErdblickStyle | undefined {
        for (const elem of elements) {
            if (elem.id === id) {
                return elem;
            }
            if (this.checkIsStyleGroup(elem)) {
                const found = this.findStyleGroupById(elem.children, id);
                if (found) return found;
            }
        }
        return undefined;
    }

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

    toggleOption(styleId: string) {
        this.applyStyleConfig(styleId);
    }

    resetUpdatedStyleIds() {
        this.styleService.updateStyleHashes();
        this.warningDialogVisible = false;
    }

    getUpdatedModifiedStyleIds() {
        return [...this.styleService.styleHashes]
            .filter(([_, state] ) => state.isUpdated && state.isModified)
            .map(([url, state]) => `${state.id} (${url})`);
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;
}
