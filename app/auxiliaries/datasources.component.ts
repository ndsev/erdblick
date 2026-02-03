import {Component, HostListener, OnDestroy, ViewChild} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {InfoMessageService} from "../shared/info.service";
import {AppStateService} from "../shared/appstate.service";
import {BehaviorSubject, Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {EditorService} from "../shared/editor.service";
import {JSONSchema7} from "json-schema";
import {MapDataService} from "../mapdata/map.service";
import {DialogStackService} from "../shared/dialog-stack.service";

@Component({
    selector: 'datasources',
    template: `
        <p-dialog header="DataSource Configuration Editor" [(visible)]="editorService.datasourcesEditorVisible" [modal]="false"
                  #editorDialog (onShow)="onEditorDialogShow()" class="editor-dialog datasource-dialog" [closeOnEscape]="false">
            @if (errorMessage) {
                <p>{{ errorMessage }}</p>
            }
            <div [ngClass]="{'loading': loading || errorMessage }">
                <editor></editor>
                @if (!errorMessage && !readOnly) {
                    <div style="margin-top: 0.5em; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                        <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                            <p-button (click)="applyEditedDatasourceConfig()" label="Apply" icon="pi pi-check"
                                      [disabled]="!wasModified"></p-button>
                            <p-button (click)="closeEditorDialog($event)" [label]='this.wasModified ? "Discard" : "Cancel"'
                                      icon="pi pi-times"></p-button>
                            <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; font-size: medium;">
                                <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                                <div>Press <span style="color: grey">Esc</span> to quit</div>
                            </div>
                        </div>
                    </div>
                }
            </div>
            @if (loading) {
                <div class="spinner">
                    <p-progressSpinner ariaLabel="loading"/>
                </div>
            }
            @if (errorMessage || readOnly) {
                <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                        <p-button (click)="closeEditorDialog($event)" label="Close" icon="pi pi-times"></p-button>
                        <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; font-size: medium;">
                            <div style="color: orange">
                                {{ errorMessage ? errorMessage : "Data Source configuration is set to read-only!" }}
                            </div>
                        </div>
                    </div>
                </div>
            }
        </p-dialog>
        <p-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog 
                  [closeOnEscape]="false" (onShow)="onWarningShow()">
            <p>You have already edited the datasource configuration. Do you really want to discard the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="applyEditedDatasourceConfig(); warningDialog.close($event)" label="Save"></p-button>
                <p-button (click)="warningDialog.close($event)" label="Cancel"></p-button>
                <p-button (click)="closeWarningAndEditor($event)" label="Discard"></p-button>
            </div>
        </p-dialog>
    `,
    styles: [`
        .loading {
            visibility: collapse;
        }
    `],
    standalone: false
})
export class DatasourcesComponent implements OnDestroy {
    warningDialogVisible: boolean = false;
    wasModified: boolean = false;
    dataSourcesConfig: string = "";
    model: any = {};
    schema: JSONSchema7 = {};
    loading = false;
    errorMessage: string = "";
    readOnly = true;
    dataSourcesConfigJson: BehaviorSubject<any> = new BehaviorSubject<any>({});

    // @ViewChild('formElement') formElement!: HTMLFormElement;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;
    @ViewChild('warningDialog') warningDialog: Dialog | undefined;

    private editedConfigSourceSubscription: Subscription = new Subscription();
    private savedConfigSourceSubscription: Subscription = new Subscription();
    private detachFocusListener?: () => void;

    constructor(private messageService: InfoMessageService,
                public stateService: AppStateService,
                public editorService: EditorService,
                private http: HttpClient,
                private mapService: MapDataService,
                private dialogStack: DialogStackService) {
        this.dataSourcesConfigJson.subscribe((config: any) => {
            if (config && config["schema"] && config["model"]) {
                this.schema = config["schema"];
                this.model = config["model"];
                this.dataSourcesConfig = JSON.stringify(this.model, null, 2);
                this.editorService.styleEditorVisible = false;
                this.editorService.readOnly = config.hasOwnProperty("readOnly") ? config["readOnly"] : true;
                this.editorService.editableData = `${this.dataSourcesConfig}\n\n\n\n\n`;
                this.editorService.datasourcesEditorVisible = true;
                this.loading = false;
                this.editorService.updateEditorState.next(true);
            }
        });

    }

    ngOnDestroy() {
        this.detachFocusListener?.();
    }

    onEditorDialogShow() {
        this.loadConfigEditor();
        this.dialogStack.bringToFront(this.editorDialog);
        this.bindDialogFocus();
    }

    private bindDialogFocus() {
        if (!this.editorDialog?.container) {
            return;
        }
        this.detachFocusListener?.();
        const handler = () => this.dialogStack.bringToFront(this.editorDialog);
        this.editorDialog.container.addEventListener('mousedown', handler, true);
        this.detachFocusListener = () => {
            this.editorDialog?.container?.removeEventListener('mousedown', handler, true);
        };
    }

    loadConfigEditor() {
        // this.datasourcesEditorDialogVisible = true;
        // this.editorService.updateEditorState.next(true);
        this.getConfig();
        this.editedConfigSourceSubscription = this.editorService.editedStateData.subscribe(editedStyleSource => {
            this.wasModified = editedStyleSource.replace(/\n+$/, '') !== this.dataSourcesConfig.replace(/\n+$/, '');
        });
        this.savedConfigSourceSubscription = this.editorService.editedSaveTriggered.subscribe(_ => {
            this.applyEditedDatasourceConfig();
        });
    }

    applyEditedDatasourceConfig() {
        this.editorService.editableData = this.editorService.editedStateData.getValue();
        const configData = this.editorService.editedStateData.getValue().replace(/\n+$/, '');
        if (!configData) {
            this.messageService.showError(`Cannot apply an empty configuration definition!`);
            return;
        }
        this.postConfig(configData);
        this.dataSourcesConfig = configData;
        this.wasModified = false;
        this.warningDialogVisible = false;
    }

    private postConfig(config: string) {
        this.loading = true;
        this.http.post("config", config, {observe: 'response', responseType: 'text'}).subscribe({
            next: (data: any) => {
                this.messageService.showSuccess(data.body);
                setTimeout(() => {
                    this.loading = false;
                    this.mapService.reloadDataSources().then(_ => this.mapService.scheduleUpdate());
                }, 2000);
            },
            error: error => {
                this.loading = false;
                alert(`Error: ${error.error}`);
            }
        });
    }

    private getConfig() {
        this.readOnly = true;
        this.errorMessage = "";
        this.loading = true;
        this.http.get("config").subscribe({
            next: (data: any) => {
                if (!data) {
                    this.errorMessage = "Unknown error: DataSources configuration data is missing!";
                    this.loading = false;
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                if (!data["model"]) {
                    this.errorMessage = "Unknown error: DataSources config file data is missing!";
                    this.loading = false;
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                if (!data["schema"]) {
                    this.errorMessage = "Unknown error: DataSources schema file data is missing!";
                    this.loading = false;
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                this.readOnly = data["readOnly"];
                this.dataSourcesConfigJson.next(data);
            },
            error: error => {
                this.loading = false;
                this.errorMessage = `Error: ${error.error}`;
            }
        });
    }

    closeEditorDialog(event: any) {
        event.stopPropagation();
        if (this.wasModified) {
            this.warningDialogVisible = true;
            return;
        }
        if (this.editorDialog !== undefined) {
            this.warningDialogVisible = false;
            this.editorDialog.close(event);
        }
        this.editedConfigSourceSubscription.unsubscribe();
        this.savedConfigSourceSubscription.unsubscribe();
    }

    closeWarningAndEditor(event: any) {
        this.wasModified = false;
        this.closeEditorDialog(event);
    }

    @HostListener('window:keydown', ['$event'])
    onWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.editorService.datasourcesEditorVisible) {
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

    protected onWarningShow() {
        this.dialogStack.bringToFront(this.warningDialog);
    }
}
