import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {FormsModule} from "@angular/forms";
import {ButtonModule} from "primeng/button";
import {CheckboxModule} from "primeng/checkbox";
import {InputTextModule} from "primeng/inputtext";
import {MultiSelectModule} from "primeng/multiselect";

import {AppDialogComponent} from "../shared/app-dialog.component";
import type {SearchStyleSaveOptions} from "./search-style-sheet.converter";

interface LayerAffinityOption {
    label: string;
    value: string;
}

export type SearchStyleSaveAction = "save" | "save-and-open";

export interface SearchStyleSaveRequest {
    options: Readonly<SearchStyleSaveOptions>;
    action: SearchStyleSaveAction;
}

@Component({
    selector: "search-style-save-dialog",
    template: `
        <app-dialog header="Save Search Style"
                    styleClass="app-dialog-compact search-style-save-dialog"
                    [style]="{width: '28rem', maxWidth: 'calc(100vw - 2rem)'}"
                    [modal]="true"
                    [resizable]="false"
                    [closable]="!saving"
                    [closeOnEscape]="!saving"
                    [visible]="visible"
                    (visibleChange)="onVisibleChange($event)">
            <div class="search-style-save-content" data-testid="search-style-save-dialog">
                <label for="search-style-save-name">Name</label>
                <input id="search-style-save-name"
                       data-testid="search-style-save-name"
                       pInputText
                       autocomplete="off"
                       [(ngModel)]="name"
                       (keydown.enter)="submit('save')"
                       [disabled]="saving" />
                @if (showNameError) {
                    <small class="search-style-save-error" role="alert">A style name is required.</small>
                }

                <label for="search-style-save-layers">Layer affinity</label>
                <p-multiSelect inputId="search-style-save-layers"
                               data-testid="search-style-save-layers"
                               [options]="layerOptions"
                               [(ngModel)]="selectedLayerIds"
                               optionLabel="label"
                               optionValue="value"
                               placeholder="Any layer"
                               [filter]="true"
                               [showToggleAll]="true"
                               [maxSelectedLabels]="3"
                               [disabled]="saving"
                               appendTo="body">
                </p-multiSelect>
                <small class="search-style-save-help">
                    No selection means any layer. A layer ID shared by maps applies to every map.
                </small>

                <div class="search-style-save-toggle-row">
                    <p-checkbox inputId="search-style-save-enabled"
                                data-testid="search-style-save-enabled"
                                [(ngModel)]="enableUponSave"
                                [binary]="true"
                                [disabled]="saving">
                    </p-checkbox>
                    <label for="search-style-save-enabled">Enable this style upon save</label>
                </div>

                <div class="search-style-save-actions">
                    <p-button label="Cancel"
                              severity="secondary"
                              [text]="true"
                              data-testid="search-style-save-cancel"
                              [disabled]="saving"
                              (click)="cancel()">
                    </p-button>
                    <p-button label="Save"
                              icon="pi pi-save"
                              data-testid="search-style-save-confirm"
                              [loading]="saving"
                              [disabled]="saving"
                              (click)="submit('save')">
                    </p-button>
                    <p-button label="Save and Open"
                              icon="pi pi-external-link"
                              data-testid="search-style-save-and-open"
                              [loading]="saving"
                              [disabled]="saving"
                              (click)="submit('save-and-open')">
                    </p-button>
                </div>
            </div>
        </app-dialog>
    `,
    standalone: true,
    imports: [
        AppDialogComponent,
        ButtonModule,
        CheckboxModule,
        FormsModule,
        InputTextModule,
        MultiSelectModule
    ]
})
/** Presentational dialog for naming and scoping a saved search stylesheet. */
export class SearchStyleSaveDialogComponent implements OnChanges {
    @Input() visible = false;
    @Output() visibleChange = new EventEmitter<boolean>();
    @Input() layerIds: readonly string[] = [];
    @Input() initialLayerIds: readonly string[] = [];
    @Input() saving = false;
    @Output() saveRequested = new EventEmitter<Readonly<SearchStyleSaveRequest>>();

    name = "Search Style";
    enableUponSave = true;
    selectedLayerIds: string[] = [];
    showNameError = false;
    layerOptions: LayerAffinityOption[] = [];

    ngOnChanges(changes: SimpleChanges): void {
        if (changes["layerIds"]) {
            this.layerOptions = this.layerIds.map(layerId => ({label: layerId, value: layerId}));
        }
        if (changes["visible"]?.currentValue === true) {
            this.reset();
        }
    }

    /** Emits an immutable value object; persistence and collision checks stay with the host. */
    submit(action: SearchStyleSaveAction = "save"): void {
        if (this.saving) {
            return;
        }
        if (!this.name.trim()) {
            this.showNameError = true;
            return;
        }
        this.showNameError = false;
        const options = Object.freeze({
            name: this.name,
            defaultEnabled: this.enableUponSave,
            layerIds: Object.freeze([...this.selectedLayerIds])
        });
        this.saveRequested.emit(Object.freeze({options, action}));
    }

    cancel(): void {
        if (!this.saving) {
            this.onVisibleChange(false);
        }
    }

    onVisibleChange(visible: boolean): void {
        if (this.saving && !visible) {
            return;
        }
        this.visible = visible;
        this.visibleChange.emit(visible);
    }

    private reset(): void {
        this.name = "Search Style";
        this.enableUponSave = true;
        const availableLayerIds = new Set(this.layerIds);
        this.selectedLayerIds = Array.from(new Set(this.initialLayerIds))
            .filter(layerId => availableLayerIds.has(layerId));
        this.showNameError = false;
    }
}
