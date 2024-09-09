import {Component, Input, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {EditorService} from "./editor.service";
import {HttpClient} from "@angular/common/http";
import {FormGroup} from '@angular/forms';
import {FormlyFormOptions, FormlyFieldConfig, FieldType, FieldArrayType} from '@ngx-formly/core';
import {FormlyJsonschema} from '@ngx-formly/core/json-schema';
import {JSONSchema7} from "json-schema";
import {DataSourcesService} from "./datasources.service";

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
        <p-dialog class="ds-config-dialog" header="DataSource Configuration" [(visible)]="dsService.configDialogVisible" 
                  [modal]="false" (onShow)="getConfig()">
            <p *ngIf="dataSourcesErrorMessage">{{ dataSourcesErrorMessage }}</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: column; gap: 1em;">
                <form [formGroup]="form" *ngIf="form && fields && !dataSourcesErrorMessage" (ngSubmit)="postConfig()" #formElement="ngForm">
                    <formly-form [model]="model" [fields]="fields" [options]="options" [form]="form"></formly-form>
                </form>
                <div style="margin: 0.5em 0; display: flex; flex-direction: row; justify-content: center; gap: 1em;">
                    <p-button (click)="showConfigEditor()" [disabled]="false"
                              label="Open in Editor" icon="pi pi-pencil"></p-button>
                    <p-button (click)="submitForm()" [disabled]="(form && !form.valid)" 
                              label="Apply" icon="pi pi-check"></p-button>
                    <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                        <p-button (click)="closeDatasources()" label="Close" icon="pi pi-times"></p-button>
                    </div>
                </div>
            </div>
        </p-dialog>
        <p-dialog header="DataSource Configuration Editor" [(visible)]="datasourcesEditorDialogVisible" [modal]="false"
                  #editorDialog class="editor-dialog">
            <editor [loadFun]="loadEditedConfig" [saveFun]="saveEditedConfig" [updateFun]="trackConfigUpdates"></editor>
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
    styles: [``]
})
export class DatasourcesComponent {

    datasourcesEditorDialogVisible: boolean = false;
    datasourceWasModified: boolean = false;
    wasModified: boolean = false;
    dataSourcesConfig: string = "";
    form: FormGroup | undefined;
    model: any;
    options!: FormlyFormOptions;
    fields!: FormlyFieldConfig[];
    dataSourcesErrorMessage: string = "";

    @ViewChild('formElement') formElement!: HTMLFormElement;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    private editedConfigSourceSubscription: Subscription = new Subscription();
    private savedConfigSourceSubscription: Subscription = new Subscription();
    private dataSourcesConfigJson: Object | null = null;
    private dataSourceSchema: JSONSchema7 = {
        "type": "object",
        "properties": {
            "http-settings": {
                "type": "array",
                "title": "HTTP Settings",
                "items": {
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "title": "Scope",
                            "description": "URL scope for matching requests (regex or wildcard)"
                        },
                        "api-key": {
                            "type": "string",
                            "title": "API Key",
                            "description": "API Key for OpenAPI"
                        },
                        "basic-auth": {
                            "type": "object",
                            "title": "Basic Authentication",
                            "properties": {
                                "user": {
                                    "type": "string",
                                    "title": "Username"
                                },
                                "password": {
                                    "type": "string",
                                    "title": "Password"
                                },
                                "keychain": {
                                    "type": "string",
                                    "title": "Keychain",
                                    "description": "Keychain string value"
                                }
                            },
                            "oneOf": [
                                {
                                    "required": ["user", "password"]
                                },
                                {
                                    "required": ["user", "keychain"]
                                }
                            ],
                            "additionalProperties": false
                        },
                        "proxy": {
                            "type": "object",
                            "title": "Proxy Settings",
                            "properties": {
                                "host": {
                                    "type": "string",
                                    "title": "Proxy Host"
                                },
                                "port": {
                                    "type": "integer",
                                    "title": "Proxy Port"
                                },
                                "user": {
                                    "type": "string",
                                    "title": "Proxy User"
                                },
                                "keychain": {
                                    "type": "string",
                                    "title": "Proxy Keychain"
                                }
                            },
                            "additionalProperties": false
                        },
                        "cookies": {
                            "type": "object",
                            "title": "Cookies",
                            "properties": {
                                "key": {
                                    "type": "string",
                                    "title": "Key"
                                }
                            }
                        },
                        "headers": {
                            "type": "object",
                            "title": "Headers",
                            "properties": {
                                "key": {
                                    "type": "string",
                                    "title": "Key"
                                }
                            }
                        },
                        "query": {
                            "type": "object",
                            "title": "Query Parameters",
                            "properties": {
                                "key": {
                                    "type": "string",
                                    "title": "Key"
                                }
                            }
                        }
                    },
                    "required": ["scope"],
                    "additionalProperties": false
                }
            },
            "sources": {
                "type": "array",
                "title": "Sources",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": [
                                "DataSourceHost",
                                "DataSourceProcess",
                                "SmartLayerTileService",
                                "GeoJsonFolder"
                            ],
                            "title": "Source Type"
                        },
                        "url": {
                            "type": "string",
                            "title": "URL",
                            "description": "URL for DataSourceHost or SmartLayerTileService"
                        },
                        "cmd": {
                            "type": "string",
                            "title": "Command",
                            "description": "Command for DataSourceProcess"
                        },
                        "uri": {
                            "type": "string",
                            "title": "URI",
                            "description": "URI for SmartLayerTileService"
                        },
                        "mapId": {
                            "type": "string",
                            "title": "Map ID",
                            "description": "Optional map ID for SmartLayerTileService"
                        },
                        "folder": {
                            "type": "string",
                            "title": "Folder Path",
                            "description": "Folder path for GeoJsonFolder"
                        },
                        "withAttrLayers": {
                            "type": "boolean",
                            "title": "With Attribute Layers",
                            "description": "Optional flag for GeoJsonFolder"
                        }
                    },
                    "required": ["type"],
                    "oneOf": [
                        {
                            "properties": {
                                "type": {
                                    "enum": ["DataSourceHost"]
                                },
                                "url": {
                                    "type": "string"
                                }
                            },
                            "required": ["url"]
                        },
                        {
                            "properties": {
                                "type": {
                                    "enum": ["DataSourceProcess"]
                                },
                                "cmd": {
                                    "type": "string"
                                }
                            },
                            "required": ["cmd"]
                        },
                        {
                            "properties": {
                                "type": {
                                    "enum": ["SmartLayerTileService"]
                                },
                                "uri": {
                                    "type": "string"
                                },
                                "mapId": {
                                    "type": "string"
                                }
                            },
                            "required": ["uri"]
                        },
                        {
                            "properties": {
                                "type": {
                                    "enum": ["GeoJsonFolder"]
                                },
                                "folder": {
                                    "type": "string"
                                },
                                "withAttrLayers": {
                                    "type": "boolean"
                                }
                            },
                            "required": ["folder"]
                        }
                    ],
                    "additionalProperties": false
                }
            }
        },
        "required": ["http-settings", "sources"],
        "additionalProperties": false
    };

    constructor(public mapService: MapService,
                private http: HttpClient,
                private messageService: InfoMessageService,
                public parameterService: ParametersService,
                private formlyJsonSchema: FormlyJsonschema,
                public editorService: EditorService,
                public dsService: DataSourcesService)
    {
        this.parameterService.parameters.subscribe(parameters => {
            return;
        });
    }

    showConfigEditor() {
        this.datasourcesEditorDialogVisible = true;
        this.editorService.updateEditorState.next(true);
        this.editedConfigSourceSubscription = this.editorService.configEditedStateData.subscribe(editedStyleSource => {
            this.wasModified = !(editedStyleSource.replace(/\n+$/, '') == this.dataSourcesConfig.replace(/\n+$/, ''));
        });
        this.savedConfigSourceSubscription = this.editorService.editedSaveTriggered.subscribe(_ => {
            this.applyEditedDatasourceConfig();
        });
    }

    applyEditedDatasourceConfig() {
        const configData = this.editorService.configEditedStateData.getValue().replace(/\n+$/, '');
        if (!configData) {
            this.messageService.showError(`Cannot apply an empty configuration definition!`);
            return;
        }
        // TODO: POST request
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
        return `${this.editorService.editedData}\n\n\n\n\n`;
    }

    trackConfigUpdates(state: string) {
        this.editorService.configEditedStateData.next(state);
    }

    saveEditedConfig() {
        this.editorService.editedSaveTriggered.next(true);
    }

    closeDatasources() {
        this.dsService.configDialogVisible = false;
    }

    applyDatasourceConfig() {

    }

    getConfig() {
        this.dataSourcesErrorMessage = "";
        this.http.get("/config").subscribe({
            next: (data: any) => {
                this.dataSourcesConfigJson = data && data["model"] ? data["model"] : null;
                this.dataSourceSchema =  data && data["schema"] ? data["schema"] : null;
                if (!this.dataSourcesConfigJson || !this.dataSourceSchema) {
                    this.dataSourcesErrorMessage = "Unknown error: either DataSources configuration or schema are missing!";
                    return;
                }
                this.dataSourcesConfig = this.dataSourcesConfigJson ? JSON.stringify(this.dataSourcesConfigJson, null, 2) : "";
                this.editorService.editedData = this.dataSourcesConfig;
                this.form = new FormGroup({});
                this.options = {};
                this.fields = [this.formlyJsonSchema.toFieldConfig(this.dataSourceSchema)];
                this.model = this.dataSourcesConfigJson;
            },
            error: error => {
                this.dataSourcesErrorMessage = error.toString();
            }
        });
    }

    submitForm() {
        if (this.form && this.form.valid) {
            this.formElement.submit();
            setTimeout(() => {
                this.mapService.reloadDataSources();
                this.mapService.update();
            }, 2000);
        } else {
            alert("Form is invalid");
        }
    }

    postConfig() {
        this.http.post("/config", this.model).subscribe({
            next: (data: any) => {
                alert(data);
            },
            error: error => {
                alert(error);
            }
        });
    }
}