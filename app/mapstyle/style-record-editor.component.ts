import {CommonModule} from "@angular/common";
import {Component, EventEmitter, Input, OnChanges, Output, TemplateRef} from "@angular/core";
import {TooltipModule} from "primeng/tooltip";
import {StyleAuthoringSchema, StyleField} from "./style-authoring-schema.adapter";
import {StyleDocumentEdit, StyleDocumentModel, StylePath} from "./style-document.model";
import {StyleFieldInputComponent, StyleInputProblem} from "./style-field-input.component";

import {StyleRuleEditorComponent} from './style-rule-editor.component';
import {StylePropertyDraft, StyleRuleAction} from './style-property-draft.controller';
import {styleFieldSeed} from './style-rule.presentation';

interface FormField {key: string; label: string; wide: boolean; present: boolean; definition: StyleField;}
interface FormGroup {name: string; fields: FormField[]; presentFields: FormField[]; optionalFields: FormField[];}
export type StyleEditorSection = 'rules' | 'options' | 'metadata';

@Component({
    selector: "style-record-editor",
    standalone: true,
    imports: [CommonModule, StyleFieldInputComponent, TooltipModule, StyleRuleEditorComponent],
    template: `
        @if (record === 'stylesheet' && (!section || section === 'metadata')) {
            <section class="style-editor-quick-metadata" aria-label="Style metadata" data-testid="style-editor-metadata">
                <ng-container *ngTemplateOutlet="metadataHeader || null"/>
                <div class="style-metadata-fields">
                    <ng-container *ngTemplateOutlet="fields; context: {$implicit: metadataFields}"/>
                </div>
            </section>
        }
        @for (group of groups; track group.name) {
            @if (group.name === 'Common' || section === 'options') {
                <ng-container *ngTemplateOutlet="fields; context: {$implicit: group.presentFields}"/>
                @if (group.optionalFields.length) {
                    <details class="style-form-group style-optional-fields" [open]="expandedGroups.has('Common optional')"
                        (toggle)="toggleGroup('Common optional', $event)">
                        <summary><i class="pi pi-chevron-right" aria-hidden="true"></i>Add properties
                            <span class="style-optional-count">{{ group.optionalFields.length }}</span>
                        </summary>
                        @if (visitedGroups.has('Common optional')) {
                            <ng-container *ngTemplateOutlet="fields; context: {$implicit: group.optionalFields}"/>
                        }
                    </details>
                }
            } @else {
                <details class="style-form-group" [open]="expandedGroups.has(group.name)"
                    (toggle)="toggleGroup(group.name, $event)">
                    <summary><i class="pi pi-chevron-right" aria-hidden="true"></i>{{ group.name }}</summary>
                    @if (visitedGroups.has(group.name)) {
                        <ng-container *ngTemplateOutlet="fields; context: {$implicit: group.fields}"/>
                    }
                </details>
            }
        }
        @if (unknownKeys.length) {
            <small>Preserved unrecognized fields: {{ unknownKeys.join(', ') }}.</small>
        }
        <ng-template #fields let-items>
            @for (item of items; track item.key) {
                <fieldset [disabled]="!!ruleDraft && item.definition.record !== 'rule'" class="style-form-field" [class.style-field-wide]="item.wide && item.present"
                     [class.style-field-unset]="!item.present"
                     [attr.data-style-path]="fieldPath(item.key).join('.')">
                    @if (item.key !== 'rules' || !item.present) {
                        <div class="style-field-heading">
                            @if (item.key !== 'rules') {
                                <span class="style-field-label" [title]="item.key">{{ item.label }}
                                    @if (item.definition.help) {
                                        <button type="button" class="style-field-help" title="" [attr.aria-label]="'About ' + item.label"
                                            [pTooltip]="item.definition.help" tooltipEvent="both" tooltipPosition="top">
                                            <i class="pi pi-info-circle" aria-hidden="true"></i>
                                        </button>
                                    }
                                </span>
                            }
                            @if (item.present && item.key !== 'rules') {
                                <button type="button" class="style-field-reset" [attr.aria-label]="'Unset ' + item.key"
                                    title="Remove this value; use inheritance or the default"
                                    (click)="edit.emit({op: 'remove', path: fieldPath(item.key)})">
                                    <i class="pi pi-undo" aria-hidden="true"></i>
                                </button>
                            } @else if (!item.present) {
                                <button type="button" [disabled]="!!ruleDraft" class="style-field-add" [attr.aria-label]="'Add ' + item.label" (click)="addField(item)">
                                    <i class="pi pi-plus" aria-hidden="true"></i>{{ item.key === 'rules' ? 'Add rules' : 'Add' }}
                                </button>
                            }
                        </div>
                    }
                    @if (item.present) {
                        @if (item.definition.kind === 'record') {
                            @if (model.isRecord(fieldPath(item.key))) {
                                <style-record-editor class="style-nested-record" [model]="model" [catalog]="catalog"
                                    [record]="item.definition.record!" [path]="fieldPath(item.key)" [scope]="scope"
                                    (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                            } @else {
                                <small class="style-form-error">Expected a record.</small>
                                <button type="button" (click)="addField(item)">Replace with editable record</button>
                            }
                        } @else if (item.definition.kind === 'list') {
                            @for (index of indices(item.key); track index) {
                                @if (item.definition.record === 'rule') {
                                    <style-rule-editor [model]="model" [catalog]="catalog" [path]="itemPath(item.key, index)"
                                        [draft]="ruleDraft" [propertyTemplate]="propertyTemplate" [scope]="scope" (action)="ruleAction.emit($event)"/>
                                } @else {
                                <div class="style-list-item" [class.is-expanded]="itemOpen(item.key, index)">
                                    <div class="style-item-heading">
                                        <button type="button" class="style-item-title" [attr.aria-expanded]="itemOpen(item.key, index)"
                                            (click)="toggleItem(item.key, index)">
                                            <i class="pi pi-chevron-right" aria-hidden="true"></i><span>{{ itemTitle(item, index) }}</span>
                                        </button>
                                        <div class="style-item-actions">
                                            <button type="button" aria-label="Move item up" title="Move up" [disabled]="index === 0"
                                                (click)="move(item.key, index, index - 1)"><i class="pi pi-arrow-up" aria-hidden="true"></i></button>
                                            <button type="button" aria-label="Move item down" title="Move down" [disabled]="index === indices(item.key).length - 1"
                                                (click)="move(item.key, index, index + 1)"><i class="pi pi-arrow-down" aria-hidden="true"></i></button>
                                            <button type="button" aria-label="Duplicate item" title="Duplicate"
                                                (click)="edit.emit({op: 'duplicate', path: fieldPath(item.key), index})"><i class="pi pi-copy" aria-hidden="true"></i></button>
                                            <button type="button" class="style-item-remove" aria-label="Remove item" title="Remove"
                                                (click)="edit.emit({op: 'remove', path: itemPath(item.key, index)})"><i class="pi pi-trash" aria-hidden="true"></i></button>
                                        </div>
                                    </div>
                                    @if (itemOpen(item.key, index) || visitedItems.has(item.key + ':' + index)) {
                                        @if (model.isRecord(itemPath(item.key, index))) {
                                            <style-record-editor [hidden]="!itemOpen(item.key, index)" [model]="model" [catalog]="catalog"
                                                [record]="item.definition.record!" [path]="itemPath(item.key, index)" [scope]="scope"
                                                (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                                        } @else {
                                            <small class="style-form-error">Expected a record. Remove this item or correct its YAML value.</small>
                                        }
                                    }
                                </div>
                                }
                            }
                            @if (model.isList(fieldPath(item.key))) {
                                <button type="button" class="style-list-add" [disabled]="!!ruleDraft" (click)="append(item)">
                                    <i class="pi pi-plus" aria-hidden="true"></i>Add {{ item.definition.record }}
                                </button>
                            } @else {
                                <small class="style-form-error">Expected a list.</small>
                                <button type="button" (click)="addField(item)">Replace with editable list</button>
                            }
                        } @else {
                            <style-field-input [model]="model" [field]="item.definition" [path]="fieldPath(item.key)" [scope]="scope"
                                (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                        }
                    }
                </fieldset>
            }
        </ng-template>
    `
})
/** Native-record form for the document, options, composite fields, presets and effects. */
export class StyleRecordEditorComponent implements OnChanges {
    @Input({required: true}) model!: StyleDocumentModel;
    @Input({required: true}) catalog!: StyleAuthoringSchema;
    @Input() record = "stylesheet";
    @Input() section?: StyleEditorSection;
    @Input() path: StylePath = [];
    @Input() propertyTemplate?: TemplateRef<unknown>;
    @Input() ruleDraft?: StylePropertyDraft;
    @Output() ruleAction = new EventEmitter<StyleRuleAction>();
    @Input() skipMetadata = false;
    @Input() metadataHeader?: TemplateRef<unknown>;
    @Input() scope: "feature" | "attribute" | "relation" = "feature";
    @Output() edit = new EventEmitter<StyleDocumentEdit>();
    @Output() problem = new EventEmitter<StyleInputProblem>();
    groups: FormGroup[] = [];
    metadataFields: FormField[] = [];
    unknownKeys: string[] = [];
    expandedGroups = new Set<string>();
    visitedGroups = new Set<string>();
    visitedItems = new Set<string>();
    private expandedItems = new Map<string, boolean>();

    /** Groups catalog fields without projecting or regenerating authored values. */
    ngOnChanges(): void {
        const fields = this.catalog.records[this.record];
        const groups = new Map<string, FormField[]>();
        this.metadataFields = [];
        for (const [key, definition] of Object.entries(fields)) {
            if (this.skipMetadata && (key === "name" || key === "layer")) continue;
            const present = this.model.has(this.fieldPath(key));
            const label = definition.label ?? key.replaceAll('-', ' ');
            const item = {key, definition, present, label: label.charAt(0).toUpperCase() + label.slice(1),
                wide: ["record", "list", "stops"].includes(definition.kind)};
            if (this.record === 'stylesheet' && (definition.group === 'Document' || key === 'name' || key === 'layer')) {
                this.metadataFields.push(item);
                continue;
            }
            const group = groups.get(definition.group) ?? [];
            group.push(item);
            groups.set(definition.group, group);
        }
        this.groups = [...groups].filter(([name]) => !this.section || (this.section === 'rules'
            ? name === 'Common' || name === 'Interaction' : this.section === 'options' && name === 'Options and presets'))
            .map(([name, fields]) => ({name, fields,
            presentFields: fields.filter(field => field.present), optionalFields: fields.filter(field => !field.present)}));
        this.unknownKeys = !this.section || this.section === 'metadata' ? this.model.keys(this.path).filter(key => !fields[key]) : [];
    }

    /** Locates a field relative to this record. */
    fieldPath(key: string): StylePath { return [...this.path, key]; }

    /** Locates an ordered record item. */
    itemPath(key: string, index: number): StylePath { return [...this.path, key, index]; }

    /** Supplies stable list indices without deserializing record content. */
    indices(key: string): number[] { return Array.from({length: this.model.length(this.fieldPath(key))}, (_, i) => i); }

    /** Gives list entries a readable authored identity when one exists. */
    itemTitle(item: FormField, index: number): string {
        const path = this.itemPath(item.key, index);
        const label = this.model.value([...path, "name"]) ?? this.model.value([...path, "label"])
            ?? this.model.value([...path, "id"]) ?? this.model.value([...path, "scope"]);
        const record = item.definition.record ?? "item";
        return `${record.charAt(0).toUpperCase() + record.slice(1)} ${index + 1}${label ? ': ' + label : ''}`;
    }

    /** Keep expansion by list position; each list's first item is open by default. */
    itemOpen(key: string, index: number): boolean { return this.expandedItems.get(`${key}:${index}`) ?? index === 0; }

    /** Expands one record without opening every nested branch. */
    toggleItem(key: string, index: number): void {
        this.visitedItems.add(`${key}:${index}`);
        this.expandedItems.set(`${key}:${index}`, !this.itemOpen(key, index));
    }

    /** Lazily creates advanced controls when their group is expanded. */
    toggleGroup(name: string, event: Event): void {
        if ((event.target as HTMLDetailsElement).open) {
            this.expandedGroups.add(name);
            this.visitedGroups.add(name);
        }
        else this.expandedGroups.delete(name);
    }

    /** Initializes a field only after the user explicitly chooses Set. */
    addField(item: FormField): void {
        const field = item.definition;
        const value = styleFieldSeed(field, this.catalog, this.model.value(this.fieldPath('type')));
        this.edit.emit({op: "set", path: this.fieldPath(item.key), value, remove: field.exclusive});
    }

    /** Appends a seeded top-level rule, option, preset or effect record. */
    append(item: FormField): void {
        const index = this.model.length(this.fieldPath(item.key));
        this.expandedItems.set(`${item.key}:${index}`, true);
        const value = this.catalog.seeds[item.definition.record!] ?? {};
        this.edit.emit({op: "append", path: this.fieldPath(item.key), value});
    }

    /** Reorders existing rule/option/preset AST nodes instead of serializing reduced objects. */
    move(key: string, index: number, to: number): void { this.edit.emit({op: "move", path: this.fieldPath(key), index, to}); }
}
