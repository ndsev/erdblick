import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MapService, removeGroupPrefix} from "./map.service";
import {StyleService} from "./style.service";
import {ErdblickStyleGroup, ErdblickStyle} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {EditorService} from "./editor.service";


@Component({
    selector: 'style-panel',
    template: `
        <p-fieldset class="map-tab" legend="Styles" [toggleable]="true" [(collapsed)]="stylesCollapsed">
            <ng-container *ngIf="styleService.styleGroups | async as styleGroups">
                <div *ngIf="!styleService.builtinStylesCount && !styleService.importedStylesCount">
                    No styles loaded.
                </div>
                <ng-container *ngFor="let group of styleGroups | keyvalue: unordered">
                    <div class="styles-container card" *ngIf="group.value.id != 'ungrouped'">
                        <p-tree [value]="[group.value]">
                            <ng-template let-node pTemplate="Group">
                                <span>
                                    <p-checkbox [ngModel]="node.visible"
                                                (click)="$event.stopPropagation()"
                                                (ngModelChange)="toggleStyleGroup(node.id)"
                                                [binary]="true"
                                                [inputId]="node.id"
                                                [name]="node.id" tabindex="0"/>
                                    <label [for]="node.id" style="margin-left: 0.5em; cursor: pointer">
                                        {{ removeGroupPrefix(node.id) }}
                                    </label>
                                </span>
                            </ng-template>
                            <ng-template let-node pTemplate="Style">
                                <div class="flex-container">
                                    <div class="font-bold white-space-nowrap" style="display: flex; align-items: center;">
                                        <span onEnterClick class="material-icons menu-toggler"
                                              (click)="showStylesToggleMenu($event, node.id)" tabindex="0">
                                            more_vert
                                        </span>
                                        <span>
                                            <p-checkbox [(ngModel)]="node.params.visible"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="applyStyleConfig(node.id)"
                                                        [binary]="true"
                                                        [inputId]="node.id"
                                                        [name]="node.id"/>
                                            <label [for]="node.id"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                        </span>
                                    </div>
                                    <div class="layer-controls style-controls">
                                        <p-button onEnterClick *ngIf="node.imported" (click)="removeStyle(node.id)"
                                                  icon="pi pi-trash"
                                                  label="" pTooltip="Remove style"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                        <p-button onEnterClick *ngIf="!node.imported" (click)="resetStyle(node.id)"
                                                  icon="pi pi-refresh"
                                                  label="" pTooltip="Reload style from storage"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                        <p-button onEnterClick (click)="showStyleEditor(node.id)"
                                                  icon="pi pi-file-edit"
                                                  label="" pTooltip="Edit style"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                    </div>
                                </div>
                            </ng-template>
                            <ng-template let-node pTemplate="Bool">
                                <div style="display: flex; align-items: center;">
                                    <span onEnterClick class="material-icons menu-toggler"
                                          (click)="showOptionsToggleMenu($event, node.styleId, node.id)"
                                          [ngClass]="{'disabled': !styleService.styles.get(node.styleId)?.params?.visible}"
                                          tabindex="0">
                                        more_vert
                                    </span>
                                    <span [ngClass]="{'disabled': !styleService.styles.get(node.styleId)?.params?.visible}"
                                          style="font-style: oblique">
                                        <p-checkbox
                                                [(ngModel)]="styleService.styles.get(node.styleId)!.params.options[node.id]"
                                                (ngModelChange)="toggleOption(node.styleId)"
                                                [binary]="true"
                                                [inputId]="node.styleId + '_' + node.id"
                                                [name]="node.styleId + '_' + node.id"/>
                                        <label [for]="node.styleId + '_' + node.id"
                                               style="margin-left: 0.5em; cursor: pointer">{{ node.label }}</label>
                                    </span>
                                </div>
                            </ng-template>
                        </p-tree>
                    </div>
                </ng-container>
                <div class="card" *ngIf="styleGroups.has('ungrouped')">
                    <p-tree [value]="styleGroups.get('ungrouped')?.children">
                        <ng-template let-node pTemplate="Style">
                            <div class="flex-container">
                                <div class="font-bold white-space-nowrap" style="display: flex; align-items: center;">
                                        <span onEnterClick class="material-icons menu-toggler"
                                              (click)="showStylesToggleMenu($event, node.id)" tabindex="0">
                                            more_vert
                                        </span>
                                    <span>
                                            <p-checkbox [(ngModel)]="node.params.visible"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="applyStyleConfig(node.id)"
                                                        [binary]="true"
                                                        [inputId]="node.id"
                                                        [name]="node.id"/>
                                            <label [for]="node.id"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.id }}</label>
                                        </span>
                                </div>
                                <div class="layer-controls style-controls">
                                    <p-button onEnterClick *ngIf="node.imported" (click)="removeStyle(node.id)"
                                              icon="pi pi-trash"
                                              label="" pTooltip="Remove style"
                                              tooltipPosition="bottom" tabindex="0">
                                    </p-button>
                                    <p-button onEnterClick *ngIf="!node.imported" (click)="resetStyle(node.id)"
                                              icon="pi pi-refresh"
                                              label="" pTooltip="Reload style from storage"
                                              tooltipPosition="bottom" tabindex="0">
                                    </p-button>
                                    <p-button onEnterClick (click)="showStyleEditor(node.id)"
                                              icon="pi pi-file-edit"
                                              label="" pTooltip="Edit style"
                                              tooltipPosition="bottom" tabindex="0">
                                    </p-button>
                                </div>
                            </div>
                        </ng-template>
                        <ng-template let-node pTemplate="Bool">
                            <div style="display: flex; align-items: center;">
                                <span onEnterClick class="material-icons menu-toggler"
                                      (click)="showOptionsToggleMenu($event, node.styleId, node.id)"
                                      [ngClass]="{'disabled': !styleService.styles.get(node.styleId)?.params?.visible}"
                                      tabindex="0">
                                    more_vert
                                </span>
                                <span [ngClass]="{'disabled': !styleService.styles.get(node.styleId)?.params?.visible}"
                                      style="font-style: oblique">
                                    <p-checkbox
                                            [(ngModel)]="styleService.styles.get(node.styleId)!.params.options[node.id]"
                                            (ngModelChange)="toggleOption(node.styleId)"
                                            [binary]="true"
                                            [inputId]="node.styleId + '_' + node.id"
                                            [name]="node.styleId + '_' + node.id"/>
                                    <label [for]="node.styleId + '_' + node.id"
                                           style="margin-left: 0.5em; cursor: pointer">{{ node.label }}</label>
                                </span>
                            </div>
                        </ng-template>
                    </p-tree>
                </div>
            </ng-container>
            <div *ngIf="styleService.erroredStyleIds.size" class="styles-container">
                <div *ngFor="let message of styleService.erroredStyleIds | keyvalue: unordered"
                     class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em; color: red">
                            {{ message.key }}: {{ message.value }} (see console)
                        </span>
                </div>
            </div>
            <div class="styles-container">
                <div class="styles-import">
                    <p-fileupload #styleUploader onEnterClick mode="basic" name="demo[]" chooseIcon="pi pi-upload"
                                  accept=".yaml" maxFileSize="1048576" fileLimit="1" multiple="false"
                                  customUpload="true" (uploadHandler)="importStyle($event)" [auto]="true"
                                  class="import-dialog" pTooltip="Import style" tooltipPosition="bottom"
                                  chooseLabel="Import Style" tabindex="0"/>
                </div>
            </div>
        </p-fieldset>
        <p-menu #styleMenu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}" appendTo="body"></p-menu>
        <p-dialog header="Style Editor" [(visible)]="editorService.styleEditorVisible" [modal]="false" #editorDialog
                  class="editor-dialog" appendTo="body">
            <editor></editor>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
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
                </div>
            </div>
        </p-dialog>
        <p-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog appendTo="body">
            <p>You have already edited the style data. Do you really want to discard the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="discardStyleEdits()" label="Yes"></p-button>
                <p-button (click)="warningDialog.close($event)" label="No"></p-button>
            </div>
        </p-dialog>
        <p-dialog header="Updated Styles" [(visible)]="styleUpdateDialogVisible" [modal]="true"
                  (onHide)="resetUpdatedStyleIds()" #updatedStyleDialog appendTo="body">
            <ng-container *ngIf="getUpdatedStyleIds(false).length">
                <p>The following styles were updated:</p>
                <p-chip *ngFor="let styleId of getUpdatedStyleIds(false)" [label]="styleId"/>
            </ng-container>
            <ng-container *ngIf="getUpdatedStyleIds(true).length">
                <p>The following styles were newly initialised:</p>
                <p-chip *ngFor="let styleId of getUpdatedStyleIds(true)" [label]="styleId"/>
            </ng-container>
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
export class StyleComponent {
    warningDialogVisible: boolean = false;
    styleUpdateDialogVisible: boolean = false;
    editedStyleSourceSubscription: Subscription = new Subscription();
    savedStyleSourceSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;
    stylesCollapsed: boolean = false;

    @ViewChild('styleMenu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    // Group visibility is derived from leaf styles; bind directly to node.visible.

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public parameterService: ParametersService,
                public editorService: EditorService) {

        // Group visibility is computed in the service; no local map needed.
        this.editorService.editedSaveTriggered.subscribe(_ => this.applyEditedStyle());
        this.parameterService.ready$.subscribe(_ => {
            this.styleUpdateDialogVisible = this.styleService.styleHashes.values().some(state => state.isChanged);
        });
    }

    // TODO: Refactor these into a generic solution
    showOptionsToggleMenu(event: MouseEvent, styleId: string, optionId: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, id == optionId);
                    }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, id != optionId);
                    }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, false);
                    }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, true);
                    }
                    this.applyStyleConfig(style.id);
                }
            }
        ];
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
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId != id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, false, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, true, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            }
        ];
    }

    applyStyleConfig(styleId: string, redraw: boolean=true) {
        const style = this.styleService.styles.get(styleId);
        if (style === undefined || style === null) {
            return;
        }
        if (redraw) {
            this.styleService.reapplyStyle(styleId);
        }
        this.parameterService.setStyleConfig(styleId, style.params);
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
            if (styleId.toLowerCase().endsWith(".yaml")) {
                styleId = styleId.slice(0, -5);
            } else if (styleId.toLowerCase().endsWith(".yml")) {
                styleId = styleId.slice(0, -4);
            }
            styleId = `${styleId} (Imported)`
            this.styleService.importStyleYamlFile(event, file, styleId, this.styleUploader)
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
        this.editorService.editableData = this.editorService.editedStateData.getValue();
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
        this.styleService.setStyleSource(styleId, styleData);
        this.sourceWasModified = false;
    }

    closeEditorDialog(event: any) {
        if (this.editorDialog !== undefined) {
            if (this.sourceWasModified) {
                event.stopPropagation();
                this.warningDialogVisible = true;
            } else {
                this.warningDialogVisible = false;
                this.editorDialog.close(event);
            }
        }
        this.editedStyleSourceSubscription.unsubscribe();
        this.savedStyleSourceSubscription.unsubscribe();
    }

    discardStyleEdits() {
        this.editorService.updateEditorState.next(false);
        this.warningDialogVisible = false;
    }

    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    toggleStyleGroup(id: string) {
        if (!id || id === 'ungrouped') {
            return;
        }
        const rootGroups = this.styleService.styleGroups.getValue();
        const group = this.findStyleGroupById(rootGroups, id);
        if (!group) {
            return;
        }
        const target = !group.visible;
        const styleIds = this.collectStyleIds(group);
        for (const id of styleIds) {
            this.styleService.toggleStyle(id, target, true);
        }
        this.styleService.reapplyAllStyles();
        this.mapService.update().then();
    }

    private findStyleGroupById(groups: Map<string, ErdblickStyleGroup>, id: string): ErdblickStyleGroup | undefined {
        for (const [id, group] of groups) {
            if (id === id || group.id === id) {
                return group;
            }
            const found = this.findInChildren(group, id);
            if (found) return found;
        }
        return undefined;
    }

    private findInChildren(group: ErdblickStyleGroup, id: string): ErdblickStyleGroup | undefined {
        for (const child of group.children) {
            if ((child as any).type === 'Group') {
                const g = child as ErdblickStyleGroup;
                if (g.id === id) return g;
                const found = this.findInChildren(g, id);
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

    getUpdatedStyleIds(filterNew: boolean) {
        return [... this.styleService.styleHashes].filter(([_, state] ) => state.isChanged && (filterNew === state.isNew)).map(([name, _]) => name)
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;
}
