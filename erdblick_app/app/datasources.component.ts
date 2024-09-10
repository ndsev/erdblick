import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {ParametersService} from "./parameters.service";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {EditorService} from "./editor.service";
import {JSONSchema7} from "json-schema";
import {DataSourcesService} from "./datasources.service";
import {FormGroup} from '@angular/forms';
import {FormlyFormOptions, FormlyFieldConfig, FieldType, FieldArrayType} from '@ngx-formly/core';
import {FormlyJsonschema} from '@ngx-formly/core/json-schema';

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
})
export class ArrayTypeComponent extends FieldArrayType {}

@Component({
    selector: 'datasources',
    template: `
        <!--        <p-dialog class="ds-config-dialog" header="DataSource Configuration" [(visible)]="dsService.configDialogVisible"-->
        <!--                  [modal]="false" (onShow)="dsService.getConfig()">-->
        <!--            <p *ngIf="dsService.errorMessage">{{ dsService.errorMessage }}</p>-->
        <!--            <div *ngIf="!dsService.loading" style="margin: 0.5em 0; display: flex; flex-direction: column; gap: 1em;">-->
        <!--                <form [formGroup]="form" *ngIf="form && fields && !dsService.errorMessage" (ngSubmit)="postConfig()"-->
        <!--                      #formElement="ngForm">-->
        <!--                    <formly-form [model]="model" [fields]="fields" [options]="options" [form]="form"></formly-form>-->
        <!--                </form>-->
        <!--                <div style="margin: 0.5em 0; display: flex; flex-direction: row; justify-content: center; gap: 1em;">-->
        <!--                    <p-button (click)="showConfigEditor()" [disabled]="false"-->
        <!--                              label="Open in Editor" icon="pi pi-pencil"></p-button>-->
        <!--                    <p-button (click)="submitForm()" [disabled]="(form && !form.valid)"-->
        <!--                              label="Apply" icon="pi pi-check"></p-button>-->
        <!--                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">-->
        <!--                        <p-button (click)="closeDatasources()" label="Close" icon="pi pi-times"></p-button>-->
        <!--                    </div>-->
        <!--                </div>-->
        <!--            </div>-->
        <!--            <div *ngIf="dsService.loading">-->
        <!--                <p-progressSpinner ariaLabel="loading"/>-->
        <!--            </div>-->
        <!--        </p-dialog>-->
        <p-dialog header="DataSource Configuration Editor" [(visible)]="dsService.configDialogVisible" [modal]="false"
                  #editorDialog class="editor-dialog" (onShow)="loadConfigEditor()">
            <p *ngIf="dsService.errorMessage">{{ dsService.errorMessage }}</p>
            <div [ngClass]="{'loading': dsService.loading || dsService.errorMessage }">
                <editor [loadFun]="loadEditedConfig" [saveFun]="saveEditedConfig"></editor>
            </div>
            <div class="spinner" *ngIf="dsService.loading">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
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
        </p-dialog>
    `,
    styles: [`
        .loading {
            visibility: collapse;
        }
    `]
})
export class DatasourcesComponent {

    datasourcesEditorDialogVisible: boolean = false;
    datasourceWasModified: boolean = false;
    wasModified: boolean = false;
    dataSourcesConfig: string = "";
    form: FormGroup | undefined;
    model: Object = {};
    options!: FormlyFormOptions;
    fields!: FormlyFieldConfig[];
    schema: JSONSchema7 = {};

    @ViewChild('formElement') formElement!: HTMLFormElement;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    private editedConfigSourceSubscription: Subscription = new Subscription();
    private savedConfigSourceSubscription: Subscription = new Subscription();

    constructor(private messageService: InfoMessageService,
                public parameterService: ParametersService,
                private formlyJsonSchema: FormlyJsonschema,
                public editorService: EditorService,
                public dsService: DataSourcesService) {
        this.parameterService.parameters.subscribe(parameters => {
            return;
        });

        this.dsService.dataSourcesConfigJson.subscribe((config: any) => {
            if (config && config["schema"] && config["model"]) {
                this.schema = config["schema"];
                this.model = config["model"];
                this.dataSourcesConfig = JSON.stringify(this.model, null, 2);
                this.editorService.editableData = this.dataSourcesConfig;
                this.form = new FormGroup({});
                this.options = {};
                this.fields = [this.formlyJsonSchema.toFieldConfig(this.schema)];
                this.dsService.loading = false;
                this.editorService.updateEditorState.next(true);
            }
        });
    }

    loadConfigEditor() {
        // this.datasourcesEditorDialogVisible = true;
        // this.editorService.updateEditorState.next(true);
        this.dsService.getConfig();
        this.editedConfigSourceSubscription = this.editorService.editedStateData.subscribe(editedStyleSource => {
            this.wasModified = editedStyleSource.replace(/\n+$/, '') !== this.dataSourcesConfig.replace(/\n+$/, '');
        });
        this.savedConfigSourceSubscription = this.editorService.editedSaveTriggered.subscribe(_ => {
            this.applyEditedDatasourceConfig();
        });
    }

    applyEditedDatasourceConfig() {
        const configData = this.editorService.editedStateData.getValue().replace(/\n+$/, '');
        if (!configData) {
            this.messageService.showError(`Cannot apply an empty configuration definition!`);
            return;
        }
        this.dsService.postConfig(configData);
        this.dataSourcesConfig = configData;
        this.wasModified = false;
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

    discardConfigEdits() {
        this.editorService.updateEditorState.next(false);
    }

    loadEditedConfig() {
        return `${this.editorService.editableData}\n\n\n\n\n`;
    }

    saveEditedConfig() {
        this.editorService.editedSaveTriggered.next(true);
    }

    closeDatasources() {
        this.dsService.configDialogVisible = false;
    }

    submitForm() {
        // if (this.form && this.form.valid) {
        //     this.formElement.submit();
        // } else {
        //     alert("Form is invalid");
        // }
    }

    postConfig() {
        // this.dsService.postConfig(this.model);
    }
}