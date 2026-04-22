import {Component, HostListener, ViewChild} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Subscription} from 'rxjs';
import {JSONSchema7} from 'json-schema';
import {InfoMessageService} from '../shared/info.service';
import {AppStateService, DATASOURCES_EDITOR_DIALOG_LAYOUT_ID} from '../shared/appstate.service';
import {EditorService} from '../shared/editor.service';
import {MapDataService} from '../mapdata/map.service';
import {DialogStackService} from '../shared/dialog-stack.service';
import {AppDialogComponent} from '../shared/app-dialog.component';

@Component({
    selector: 'datasources',
    template: `
        <app-dialog header="DataSource Configuration Editor"
                    [(visible)]="dialogVisible"
                    [modal]="false"
                    #editorDialog
                    (onShow)="onEditorDialogShow()"
                    (onHide)="onEditorDialogHide()"
                    class="editor-dialog datasource-dialog"
                    [persistLayout]="true" [layoutId]="dialogLayoutId"
                    [contentStyle]="loading ? {'overflow-y': 'hidden'} : {}"
                    [closeOnEscape]="false">
            @if (loading) {
                <div class="spinner datasource-loading-spinner">
                    <p-progressSpinner ariaLabel="loading"/>
                </div>
            } @else if (errorMessage || readOnly) {
                <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                        <p-button (click)="closeEditorDialog($event)" label="Close" icon="pi pi-times"></p-button>
                        <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; width: 18em; font-size: 1em;">
                            <div style="color: orange">
                                {{ errorMessage ? errorMessage : "Data Source configuration is set to read-only!" }}
                            </div>
                        </div>
                    </div>
                </div>
            } @else {
                <editor [sessionId]="datasourcesEditorSessionId"></editor>
                <div style="margin-top: 0.5em; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                        <p-button (click)="applyEditedDatasourceConfig()" label="Apply" icon="pi pi-check"
                                  [disabled]="!wasModified"></p-button>
                        <p-button (click)="closeEditorDialog($event)" [label]='this.wasModified ? "Discard" : "Close"'
                                  icon="pi pi-times"></p-button>
                        <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; width: 18em; font-size: 1em;">
                            <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                            <div>Press <span style="color: grey">Esc</span> to quit</div>
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
    standalone: false
})
/**
 * Hosts the datasource configuration editor and mediates loading, editing, and applying
 * backend datasource configuration without leaving the viewer.
 */
export class DatasourcesComponent {
    readonly dialogLayoutId = DATASOURCES_EDITOR_DIALOG_LAYOUT_ID;
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

    /** Wires shared dialog, editor, and map services used by the datasource editor. */
    constructor(private readonly messageService: InfoMessageService,
                public readonly stateService: AppStateService,
                public readonly editorService: EditorService,
                private readonly http: HttpClient,
                private readonly mapService: MapDataService,
                private readonly dialogStack: DialogStackService) {}

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Initializes the editor session whenever the datasource dialog becomes visible. */
    onEditorDialogShow() {
        this.loadConfigEditor();
        this.dialogStack.bringToFront(this.editorDialog);
    }

    /** Tears down editor state when the dialog closes so stale subscriptions do not linger. */
    onEditorDialogHide() {
        this.cleanupEditorSubscriptions();
        this.editorService.closeSession(this.datasourcesEditorSessionId);
        this.warningDialogVisible = false;
        this.wasModified = false;
    }

    /** Reloads the datasource configuration into a fresh editor session. */
    loadConfigEditor() {
        this.cleanupEditorSubscriptions();
        this.getConfig();
    }

    /** Validates and posts the edited datasource configuration back to the backend. */
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

    /** Persists datasource configuration changes and refreshes map content after the backend accepts them. */
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

    /** Fetches the current datasource configuration and opens it in the shared JSON editor. */
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

    /** Closes the editor or opens the discard warning when unsaved changes are present. */
    closeEditorDialog(event: any) {
        event.stopPropagation();
        if (this.wasModified) {
            this.warningDialogVisible = true;
            return;
        }
        this.warningDialogVisible = false;
        this.dialogVisible = false;
    }

    /** Discards pending edits and then closes the editor dialog. */
    closeWarningAndEditor(event: any) {
        this.wasModified = false;
        this.closeEditorDialog(event);
    }

    @HostListener('window:keydown', ['$event'])
    /** Handles the shared Escape behavior for the datasource editor and its discard warning. */
    onWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.dialogVisible) {
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

    /** Keeps the warning dialog above other floating dialogs when it opens. */
    protected onWarningShow() {
        this.dialogStack.bringToFront(this.warningDialog);
    }

    /** Resets editor-related subscriptions before a fresh session is created. */
    private cleanupEditorSubscriptions() {
        this.editedConfigSourceSubscription.unsubscribe();
        this.saveRequestedSubscription.unsubscribe();
        this.editedConfigSourceSubscription = new Subscription();
        this.saveRequestedSubscription = new Subscription();
    }
}
