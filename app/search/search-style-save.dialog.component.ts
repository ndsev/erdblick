import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";

import type {SearchStyleSaveOptions} from "./search-style-sheet.converter";

interface LayerAffinityOption {
    label: string;
    value: string;
}

@Component({
    selector: "search-style-save-dialog",
    template: `
        <app-dialog header="Save Search Style"
                    styleClass="search-style-save-dialog"
                    [style]="{width: '28rem', maxWidth: 'calc(100vw - 2rem)'}"
                    [modal]="true"
                    [resizable]="false"
                    [visible]="visible"
                    (visibleChange)="onVisibleChange($event)">
            <div class="search-style-save-content" data-testid="search-style-save-dialog">
                <label for="search-style-save-name">Name</label>
                <input id="search-style-save-name"
                       data-testid="search-style-save-name"
                       pInputText
                       autocomplete="off"
                       [(ngModel)]="name"
                       (keydown.enter)="submit()"
                       [disabled]="saving" />
                @if (showNameError) {
                    <small class="search-style-save-error" role="alert">A style name is required.</small>
                }

                <div class="search-style-save-toggle-row">
                    <p-toggleswitch inputId="search-style-save-default"
                                    data-testid="search-style-save-default"
                                    [(ngModel)]="defaultEnabled"
                                    [disabled]="saving">
                    </p-toggleswitch>
                    <label for="search-style-save-default">Enabled by default</label>
                </div>

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
                              (click)="submit()">
                    </p-button>
                </div>
            </div>
        </app-dialog>
    `,
    standalone: false
})
/** Presentational dialog for naming and scoping a saved search stylesheet. */
export class SearchStyleSaveDialogComponent implements OnChanges {
    @Input() visible = false;
    @Output() visibleChange = new EventEmitter<boolean>();
    @Input() layerIds: readonly string[] = [];
    @Input() saving = false;
    @Output() saveRequested = new EventEmitter<Readonly<SearchStyleSaveOptions>>();

    name = "Search Style";
    defaultEnabled = false;
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
    submit(): void {
        if (this.saving) {
            return;
        }
        if (!this.name.trim()) {
            this.showNameError = true;
            return;
        }
        this.showNameError = false;
        this.saveRequested.emit(Object.freeze({
            name: this.name,
            defaultEnabled: this.defaultEnabled,
            layerIds: Object.freeze([...this.selectedLayerIds])
        }));
    }

    cancel(): void {
        if (!this.saving) {
            this.onVisibleChange(false);
        }
    }

    onVisibleChange(visible: boolean): void {
        this.visible = visible;
        this.visibleChange.emit(visible);
    }

    private reset(): void {
        this.name = "Search Style";
        this.defaultEnabled = false;
        this.selectedLayerIds = [];
        this.showNameError = false;
    }
}
