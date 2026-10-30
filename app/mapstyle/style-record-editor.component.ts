import {CommonModule} from "@angular/common";
import {Component, EventEmitter, Input, OnChanges, Output} from "@angular/core";
import {StyleAuthoringSchema, StyleField} from "./style-authoring-schema.adapter";
import {StyleDocumentEdit, StyleDocumentModel, StylePath} from "./style-document.model";
import {StyleFieldInputComponent, StyleInputProblem} from "./style-field-input.component";

interface FormField {key: string; definition: StyleField;}
interface FormGroup {name: string; fields: FormField[];}

@Component({
    selector: "style-record-editor",
    standalone: true,
    imports: [CommonModule, StyleFieldInputComponent],
    styleUrl: "./style-form.scss",
    template: `
        @if (record === 'rule' && path.length > 2) {
            <small>Unset fields inherit from the parent. Inherited scales and expressions retain native precedence over child literals.</small>
        }
        @for (group of groups; track group.name) {
            @if (group.name === 'Common') {
                <ng-container *ngTemplateOutlet="fields; context: {$implicit: group.fields}"/>
            } @else {
                <details class="style-form-group" [open]="expandedGroups.has(group.name)"
                    (toggle)="toggleGroup(group.name, $event)">
                    <summary>{{ group.name }}</summary>
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
                <div class="style-form-field" [attr.data-style-path]="fieldPath(item.key).join('.')">
                    <div class="style-field-heading">
                        <label>{{ item.definition.label ?? item.key }}</label>
                        @if (model.has(fieldPath(item.key))) {
                            <button type="button" [attr.aria-label]="'Unset ' + item.key" title="Remove this field; use inheritance or native default"
                                (click)="edit.emit({op: 'remove', path: fieldPath(item.key)})">Unset</button>
                        } @else {
                            <span class="style-unset">Unset</span>
                            <button type="button" [attr.aria-label]="'Set ' + item.key" (click)="addField(item)">Set</button>
                        }
                    </div>
                    @if (model.has(fieldPath(item.key))) {
                        @if (item.definition.kind === 'record') {
                            @if (model.isRecord(fieldPath(item.key))) {
                                <style-record-editor class="style-nested-record" [model]="model" [catalog]="catalog"
                                    [record]="item.definition.record!" [path]="fieldPath(item.key)" [scope]="childScope(item.key)"
                                    (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                            } @else {
                                <small class="style-form-error">Expected a record.</small>
                                <button type="button" (click)="addField(item)">Replace with editable record</button>
                            }
                        } @else if (item.definition.kind === 'list') {
                            @for (index of indices(item.key); track index) {
                                <div class="style-list-item">
                                    <div class="style-item-heading">
                                        <button type="button" class="style-item-title" [attr.aria-expanded]="itemOpen(item.key, index)"
                                            (click)="toggleItem(item.key, index)">{{ itemOpen(item.key, index) ? '▾' : '▸' }} {{ itemTitle(item, index) }}</button>
                                        <button type="button" aria-label="Move item up" [disabled]="index === 0"
                                            (click)="move(item.key, index, index - 1)">↑</button>
                                        <button type="button" aria-label="Move item down" [disabled]="index === indices(item.key).length - 1"
                                            (click)="move(item.key, index, index + 1)">↓</button>
                                        <button type="button" aria-label="Duplicate item"
                                            (click)="edit.emit({op: 'duplicate', path: fieldPath(item.key), index})">Duplicate</button>
                                        <button type="button" aria-label="Remove item"
                                            (click)="edit.emit({op: 'remove', path: itemPath(item.key, index)})">Remove</button>
                                    </div>
                                    @if (itemOpen(item.key, index) || visitedItems.has(item.key + ':' + index)) {
                                        @if (model.isRecord(itemPath(item.key, index))) {
                                            <style-record-editor [hidden]="!itemOpen(item.key, index)" [model]="model" [catalog]="catalog"
                                                [record]="item.definition.record!" [path]="itemPath(item.key, index)" [scope]="effectiveScope"
                                                (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                                        } @else {
                                            <small class="style-form-error">Expected a record. Remove this item or correct its YAML value.</small>
                                        }
                                    }
                                </div>
                            }
                            @if (model.isList(fieldPath(item.key))) {
                                <button type="button" (click)="append(item)">Add {{ item.definition.record }}</button>
                            } @else {
                                <small class="style-form-error">Expected a list.</small>
                                <button type="button" (click)="addField(item)">Replace with editable list</button>
                            }
                        } @else {
                            <style-field-input [model]="model" [field]="item.definition" [path]="fieldPath(item.key)" [scope]="effectiveScope"
                                (edit)="edit.emit($event)" (problem)="problem.emit($event)"/>
                        }
                    }
                    @if (item.definition.help) { <small>{{ item.definition.help }}</small> }
                </div>
            }
        </ng-template>
    `
})
/** Recursive native-record form, shared by rules, options, scales, presets and effects. */
export class StyleRecordEditorComponent implements OnChanges {
    @Input({required: true}) model!: StyleDocumentModel;
    @Input({required: true}) catalog!: StyleAuthoringSchema;
    @Input() record = "stylesheet";
    @Input() path: StylePath = [];
    @Input() skipMetadata = false;
    @Input() scope: "feature" | "attribute" | "relation" = "feature";
    @Output() edit = new EventEmitter<StyleDocumentEdit>();
    @Output() problem = new EventEmitter<StyleInputProblem>();
    groups: FormGroup[] = [];
    unknownKeys: string[] = [];
    expandedGroups = new Set<string>();
    visitedGroups = new Set<string>();
    visitedItems = new Set<string>();
    private expandedItems = new Map<string, boolean>();

    get effectiveScope(): "feature" | "attribute" | "relation" {
        const value = this.record === "rule" && this.path.length === 2 ? this.model.value(this.fieldPath("scope")) : this.scope;
        return value === "attribute" || value === "relation" ? value : "feature";
    }

    /** Endpoint substyles run on features; other nested records retain their rule's entry context. */
    childScope(key: string): "feature" | "attribute" | "relation" {
        return ["relation-source-style", "relation-target-style"].includes(key)
            ? "feature" : this.effectiveScope;
    }

    /** Groups catalog fields without projecting or regenerating authored values. */
    ngOnChanges(): void {
        const fields = this.catalog.records[this.record];
        const groups = new Map<string, FormField[]>();
        for (const [key, definition] of Object.entries(fields)) {
            if (this.skipMetadata && (key === "name" || key === "layer")) continue;
            const present = this.model.has(this.fieldPath(key));
            if (!present && definition.topLevel && this.path.length !== 2) continue;
            if (!present && this.record === "rule" && this.path.length === 2
                && this.model.value(this.fieldPath("scope")) === "relation"
                && (key === "all-of" || key === "first-of")) continue;
            const group = groups.get(definition.group) ?? [];
            group.push({key, definition});
            groups.set(definition.group, group);
        }
        this.groups = [...groups].map(([name, fields]) => ({name, fields}));
        this.unknownKeys = this.model.keys(this.path).filter(key => !fields[key]);
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
        return `${item.definition.record} ${index + 1}${label ? ': ' + label : ''}`;
    }
    /** Opens the first rule initially and retains the user's expansion choices across edits. */
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
        if (item.key === "first-of" || item.key === "all-of") {
            const other = item.key === "first-of" ? "all-of" : "first-of";
            if (this.model.has(this.fieldPath(other))) {
                this.edit.emit({op: "rename", path: this.fieldPath(other), key: item.key});
                return;
            }
        }
        let value: unknown = field.seed;
        if (value === undefined) {
            switch (field.kind) {
                case "record": value = field.record === "rule" ? {} : this.catalog.seeds[field.record!] ?? {}; break;
                case "list": case "stops": value = []; break;
                case "vector": value = field.sizes[0] === 0 ? 0 : Array(field.sizes[0]).fill(0); break;
                case "enum": case "enum-list": value = field.values[0]; break;
                case "boolean": value = false; break;
                case "number": value = 0; break;
                case "color": case "color-ref": value = "#000000"; break;
                case "option-default": {
                    const type = this.model.value(this.fieldPath("type"));
                    value = type === undefined || type === "bool" ? false : "";
                    break;
                }
                default: value = "";
            }
        }
        this.edit.emit({op: "set", path: this.fieldPath(item.key), value, remove: field.exclusive});
    }
    /** Appends a seeded record; nested rules intentionally start with inherited fields unset. */
    append(item: FormField): void {
        const index = this.model.length(this.fieldPath(item.key));
        this.expandedItems.set(`${item.key}:${index}`, true);
        const value = item.definition.record === "rule" && this.path.length > 0
            ? {} : this.catalog.seeds[item.definition.record!] ?? {};
        this.edit.emit({op: "append", path: this.fieldPath(item.key), value});
    }
    /** Reorders existing rule/option/preset AST nodes instead of serializing reduced objects. */
    move(key: string, index: number, to: number): void { this.edit.emit({op: "move", path: this.fieldPath(key), index, to}); }
}
