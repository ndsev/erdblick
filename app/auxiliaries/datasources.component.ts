import {Component, ViewChild} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {InfoMessageService} from "../shared/info.service";
import {AppStateService} from "../shared/appstate.service";
import {BehaviorSubject, Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {EditorService} from "../shared/editor.service";
import {JSONSchema7} from "json-schema";
import {FormGroup} from '@angular/forms';
import {FormlyFormOptions, FormlyFieldConfig, FieldType, FieldArrayType} from '@ngx-formly/core';
import {FormlyJsonschema} from '@ngx-formly/core/json-schema';
import {MapService} from "../mapdata/map.service";

@Component({
    selector: 'formly-multi-schema-type',
    template: `
    <div class="card mb-3">
      <div class="card-body">
        <legend *ngIf="props.label">{{ props.label }}</legend>
        <p *ngIf="props.description">{{ props.description }}</p>
        <div class="alert alert-danger" role="alert" *ngIf="showError && formControl.errors">
          <formly-validation-message [field]="field"></formly-validation-message>
        </div>
        <formly-field *ngFor="let f of field.fieldGroup" [field]="f"></formly-field>
      </div>
    </div>
  `,
    standalone: false
})
export class MultiSchemaTypeComponent extends FieldType {}

@Component({
    selector: 'formly-object-type',
    template: `
    <div class="mb-3">
      <legend *ngIf="props.label">{{ props.label }}</legend>
      <p *ngIf="props.description">{{ props.description }}</p>
      <div class="alert alert-danger" role="alert" *ngIf="showError && formControl.errors">
        <formly-validation-message [field]="field"></formly-validation-message>
      </div>
      <formly-field *ngFor="let f of field.fieldGroup" [field]="f"></formly-field>
    </div>
  `,
    standalone: false
})
export class ObjectTypeComponent extends FieldType {}

@Component({
    selector: 'formly-array-type',
    template: `
    <div class="mb-3">
        <p-fieldset class="ds-fieldset" [legend]="props.label">
            <p *ngIf="props.description">{{ props.description }}</p>
    
            <div class="alert alert-danger" role="alert" *ngIf="showError && formControl.errors">
                <formly-validation-message [field]="field"></formly-validation-message>
            </div>
    
            <div *ngFor="let field of field.fieldGroup; let i = index" class="row align-items-start">
                <div style="display: flex; flex-direction: row; gap: 0.5em;">
                    <div *ngIf="field.props?.['removable'] !== false" class="col-2 text-right">
                        <p-button class="btn btn-danger" type="button" (click)="remove(i)">-</p-button>
                    </div>
                    <formly-field class="p-col" [field]="field"></formly-field>
                </div>
                <p-divider></p-divider>
            </div>
            <div class="d-flex flex-row-reverse">
                <p-button class="btn btn-primary" type="button" (click)="add()">+</p-button>
            </div>
        </p-fieldset>
    </div>
  `,
    standalone: false
})
export class ArrayTypeComponent extends FieldArrayType {}

@Component({
    selector: 'datasources',
    template: `
        <p-dialog header="DataSource Configuration Editor" [(visible)]="editorService.datasourcesEditorVisible" [modal]="false"
                  #editorDialog class="editor-dialog" (onShow)="loadConfigEditor()" [style]="{'min-height': '14em', 'min-width': '36em'}">
            <p *ngIf="errorMessage">{{ errorMessage }}</p>
            <div [ngClass]="{'loading': loading || errorMessage }">
                <editor></editor>
                <div *ngIf="!errorMessage && !readOnly" 
                     style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; 
                     justify-content: space-between;">
                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                        <p-button (click)="applyEditedDatasourceConfig()" label="Apply" icon="pi pi-check"
                                  [disabled]="!wasModified"></p-button>
                        <p-button (click)="closeEditorDialog($event)" [label]='this.wasModified ? "Discard" : "Cancel"'
                                  icon="pi pi-times"></p-button>
                        <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; font-size: medium;">
                            <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                            <div>Press <span style="color: grey">Esc</span> to quit without saving</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="spinner" *ngIf="loading">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
            <div *ngIf="errorMessage || readOnly"
                 style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; 
                     justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="closeEditorDialog($event)" label="Close" icon="pi pi-times"></p-button>
                    <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; font-size: medium;">
                        <div style="color: orange">
                            {{ errorMessage ? errorMessage : "Data Source configuration is set to read-only!" }}
                        </div>
                    </div>
                </div>
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
export class DatasourcesComponent {
    datasourceWasModified: boolean = false;
    wasModified: boolean = false;
    dataSourcesConfig: string = "";
    form: FormGroup | undefined;
    model: any = {};
    options!: FormlyFormOptions;
    fields!: FormlyFieldConfig[];
    schema: JSONSchema7 = {};
    loading = false;
    errorMessage: string = "";
    readOnly = true;
    dataSourcesConfigJson: BehaviorSubject<any> = new BehaviorSubject<any>({});

    @ViewChild('formElement') formElement!: HTMLFormElement;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    private editedConfigSourceSubscription: Subscription = new Subscription();
    private savedConfigSourceSubscription: Subscription = new Subscription();

    constructor(private messageService: InfoMessageService,
                public parameterService: AppStateService,
                private formlyJsonSchema: FormlyJsonschema,
                public editorService: EditorService,
                private http: HttpClient,
                private mapService: MapService) {
        this.parameterService.parameters.subscribe(parameters => {
            return;
        });

        this.dataSourcesConfigJson.subscribe((config: any) => {
            if (config && config["schema"] && config["model"]) {
                this.schema = config["schema"];
                this.model = config["model"];
                this.dataSourcesConfig = JSON.stringify(this.model, null, 2);
                this.editorService.styleEditorVisible = false;
                this.editorService.readOnly = config.hasOwnProperty("readOnly") ? config["readOnly"] : true;
                this.editorService.editableData = `${this.dataSourcesConfig}\n\n\n\n\n`;
                this.editorService.datasourcesEditorVisible = true;
                this.form = new FormGroup({});
                this.options = {};
                this.fields = [this.formlyJsonSchema.toFieldConfig(this.schema)];
                this.loading = false;
                this.editorService.updateEditorState.next(true);
            }
        });

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
    }

    private postConfig(config: string) {
        this.loading = true;
        this.http.post("config", config, {observe: 'response', responseType: 'text'}).subscribe({
            next: (data: any) => {
                this.messageService.showSuccess(data.body);
                setTimeout(() => {
                    this.loading = false;
                    this.mapService.reloadDataSources().then(_ => this.mapService.update().then());
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
        if (this.editorDialog !== undefined) {
            if (this.wasModified) {
                event.stopPropagation();
            } else {
                this.editorDialog.close(event);
            }
        }
        this.editedConfigSourceSubscription.unsubscribe();
        this.savedConfigSourceSubscription.unsubscribe();
    }
}
