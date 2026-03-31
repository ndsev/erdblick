import {Component, HostListener, ViewChild} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Subscription} from 'rxjs';
import {JSONSchema7} from 'json-schema';
import {InfoMessageService} from '../shared/info.service';
import {AppStateService} from '../shared/appstate.service';
import {EditorService} from '../shared/editor.service';
import {MapDataService} from '../mapdata/map.service';
import {DialogStackService} from '../shared/dialog-stack.service';
import {AppDialogComponent} from '../shared/app-dialog.component';

@Component({
    selector: 'datasources',
    template: `
        <app-dialog header="DataSource Configuration Editor"
                  [(visible)]="stateService.datasourcesEditorDialogVisible"
                  [modal]="false"
                  #editorDialog
                  (onShow)="onEditorDialogShow()"
                  (onHide)="onEditorDialogHide()"
                  class="editor-dialog datasource-dialog"
                  [persistLayout]="true" [layoutId]="'datasources-editor-dialog'"
                  [closeOnEscape]="false">
            @if (errorMessage) {
                <p>{{ errorMessage }}</p>
            }
            <div [ngClass]="{'loading': loading || errorMessage }">
                <editor [sessionId]="datasourcesEditorSessionId"></editor>
                @if (!errorMessage && !readOnly) {
                    <div style="margin-top: 0.5em; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                        <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                            <p-button (click)="applyEditedDatasourceConfig()" label="Apply" icon="pi pi-check"
                                      [disabled]="!wasModified"></p-button>
                            <p-button (click)="closeEditorDialog($event)" [label]='this.wasModified ? "Discard" : "Close"'
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
        </app-dialog>
        <app-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog
                  [closeOnEscape]="false" (onShow)="onWarningShow()">
            <p>You have already edited the datasource configuration. Do you really want to discard the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="applyEditedDatasourceConfig(); warningDialog.close($event)" label="Save"></p-button>
                <p-button (click)="warningDialog.close($event)" label="Cancel"></p-button>
                <p-button (click)="closeWarningAndEditor($event)" label="Discard"></p-button>
            </div>
        </app-dialog>
    `,
    styles: [`
        .loading {
            visibility: collapse;
        }
    `],
    standalone: false
})
export class DatasourcesComponent {
    readonly datasourcesEditorSessionId = 'datasources-editor';
    warningDialogVisible = false;
    wasModified = false;
    dataSourcesConfig = '';
    model: any = {};
    schema: JSONSchema7 = {};
    loading = false;
    errorMessage = '';
    readOnly = true;

    @ViewChild('editorDialog') editorDialog: AppDialogComponent | undefined;
    @ViewChild('warningDialog') warningDialog: AppDialogComponent | undefined;

    private editedConfigSourceSubscription: Subscription = new Subscription();
    private saveRequestedSubscription: Subscription = new Subscription();

    constructor(private readonly messageService: InfoMessageService,
                public readonly stateService: AppStateService,
                public readonly editorService: EditorService,
                private readonly http: HttpClient,
                private readonly mapService: MapDataService,
                private readonly dialogStack: DialogStackService) {}

    onEditorDialogShow() {
        this.loadConfigEditor();
        this.dialogStack.bringToFront(this.editorDialog);
    }

    onEditorDialogHide() {
        this.cleanupEditorSubscriptions();
        this.editorService.closeSession(this.datasourcesEditorSessionId);
        this.warningDialogVisible = false;
        this.wasModified = false;
    }

    loadConfigEditor() {
        this.cleanupEditorSubscriptions();
        this.getConfig();
    }

    applyEditedDatasourceConfig() {
        if (this.readOnly) {
            return;
        }
        const configData = this.editorService.getSessionSource(this.datasourcesEditorSessionId).replace(/\n+$/, '');
        if (!configData) {
            this.messageService.showError('Cannot apply an empty configuration definition!');
            return;
        }
        this.postConfig(configData);
        this.dataSourcesConfig = configData;
        this.wasModified = false;
        this.warningDialogVisible = false;
        this.editorService.updateSessionSource(this.datasourcesEditorSessionId, configData);
    }

    private postConfig(config: string) {
        this.loading = true;
        this.http.post('config', config, {observe: 'response', responseType: 'text'}).subscribe({
            next: (data: any) => {
                this.messageService.showSuccess(data.body);
                setTimeout(() => {
                    this.loading = false;
                    this.mapService.reloadDataSources().then(() => this.mapService.scheduleUpdate());
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
        this.errorMessage = '';
        this.loading = true;
        this.http.get('config').subscribe({
            next: (data: any) => {
                if (!data) {
                    this.errorMessage = 'Unknown error: DataSources configuration data is missing!';
                    this.loading = false;
                    return;
                }
                if (!data['model']) {
                    this.errorMessage = 'Unknown error: DataSources config file data is missing!';
                    this.loading = false;
                    return;
                }
                if (!data['schema']) {
                    this.errorMessage = 'Unknown error: DataSources schema file data is missing!';
                    this.loading = false;
                    return;
                }
                this.schema = data['schema'];
                this.model = data['model'];
                this.readOnly = data['readOnly'] ?? true;
                this.dataSourcesConfig = JSON.stringify(this.model, null, 2);
                this.loading = false;
                this.editorService.createSession({
                    id: this.datasourcesEditorSessionId,
                    source: `${this.dataSourcesConfig}\n\n\n\n\n`,
                    language: 'json',
                    readOnly: this.readOnly
                });
                const session = this.editorService.getSession(this.datasourcesEditorSessionId);
                if (!session) {
                    return;
                }
                this.editedConfigSourceSubscription = session.source$.subscribe(editedStyleSource => {
                    this.wasModified = editedStyleSource.replace(/\n+$/, '') !== this.dataSourcesConfig.replace(/\n+$/, '');
                });
                this.saveRequestedSubscription = this.editorService.onSaveRequested(this.datasourcesEditorSessionId)?.subscribe(() => {
                    this.applyEditedDatasourceConfig();
                }) ?? new Subscription();
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
        this.warningDialogVisible = false;
        this.stateService.datasourcesEditorDialogVisible = false;
    }

    closeWarningAndEditor(event: any) {
        this.wasModified = false;
        this.closeEditorDialog(event);
    }

    @HostListener('window:keydown', ['$event'])
    onWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.stateService.datasourcesEditorDialogVisible) {
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

    private cleanupEditorSubscriptions() {
        this.editedConfigSourceSubscription.unsubscribe();
        this.saveRequestedSubscription.unsubscribe();
        this.editedConfigSourceSubscription = new Subscription();
        this.saveRequestedSubscription = new Subscription();
    }
}
