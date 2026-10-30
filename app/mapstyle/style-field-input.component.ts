import {Component, EventEmitter, Input, OnChanges, OnDestroy, Output} from "@angular/core";
import {FormsModule} from "@angular/forms";
import {StyleField} from "./style-authoring-schema.adapter";
import {stylePickerColor} from "./style-color.util";
import {parseStyleNumber, StyleDocumentEdit, StyleDocumentModel, StylePath} from "./style-document.model";
import {SimfilExpressionInputComponent} from "../search/simfil-expression-input.component";

export interface StyleInputProblem {path: string; message: string;}

@Component({
    selector: "style-field-input",
    standalone: true,
    imports: [FormsModule, SimfilExpressionInputComponent],
    styleUrl: "./style-form.scss",
    template: `
        @switch (kind) {
            @case ('expression') {
                <simfil-expression-input [value]="text()" (valueChange)="set($event)"
                    [completionScope]="scope === 'attribute' && path.at(-1) !== 'filter' ? 'attribute' : 'feature'"
                    [completionEnabled]="scope !== 'relation'"
                    [completionOwnerId]="id" [completionZIndex]="31050"/>
            }
            @case ('boolean') {
                <select [attr.aria-label]="label" [ngModel]="value" (ngModelChange)="set($event)">
                    <option [ngValue]="true">True</option><option [ngValue]="false">False</option>
                </select>
            }
            @case ('enum') {
                <select [attr.aria-label]="label" [ngModel]="value" (ngModelChange)="set($event)">
                    @if (!field.values.includes(text())) { <option [ngValue]="value">{{ text() }}</option> }
                    @for (choice of field.values; track choice) { <option [ngValue]="choice">{{ choice }}</option> }
                </select>
            }
            @case ('enum-list') {
                <div class="style-choices" [attr.aria-label]="label">
                    @for (choice of field.values; track choice) {
                        <label><input type="checkbox" [checked]="includes(choice)"
                            (change)="toggleChoice(choice, $event)">{{ choice }}</label>
                    }
                </div>
            }
            @case ('number') {
                <input type="text" inputmode="decimal" [attr.aria-label]="label"
                    [value]="text()" (input)="number($event, path)">
            }
            @case ('vector') {
                <div class="style-vector">
                    @if (field.sizes.length > 1) {
                        <select aria-label="Vector shape" [ngModel]="vectorLength()" (ngModelChange)="resize($event)">
                            @for (size of field.sizes; track size) {
                                <option [ngValue]="size">{{ size === 0 ? 'Scalar' : size + ' components' }}</option>
                            }
                        </select>
                    }
                    @if (vectorLength() === 0) {
                        <input aria-label="Scalar value" [value]="text()" (input)="number($event, path)">
                    } @else {
                        @for (index of indices(); track index) {
                            <input type="text" inputmode="decimal" [attr.aria-label]="label + ' ' + (index + 1)"
                                [value]="text(child(index))" (input)="number($event, child(index))">
                        }
                    }
                </div>
            }
            @case ('stops') {
                <div class="style-stop-list">
                    @for (index of indices(); track index) {
                        <div class="style-stop">
                            <select aria-label="Stop key type" [ngModel]="stopKeyType(index)"
                                (ngModelChange)="changeStopType(index, $event)">
                                <option value="number">Number</option>
                                @if (categorical) {
                                    <option value="string">String</option><option value="boolean">Boolean</option>
                                }
                            </select>
                            @if (stopKeyType(index) === 'boolean') {
                                <select aria-label="Stop key" [ngModel]="model.value(child(index, 0))"
                                    (ngModelChange)="set($event, child(index, 0))">
                                    <option [ngValue]="true">True</option><option [ngValue]="false">False</option>
                                </select>
                            } @else {
                                <input aria-label="Stop key" [value]="text(child(index, 0))"
                                    (input)="stopKey(index, $event)">
                            }
                            <input [attr.aria-label]="field.valueKind === 'color' ? 'Stop color' : 'Stop width'"
                                [value]="text(child(index, 1))" (input)="stopValue(index, $event)">
                            <button type="button" aria-label="Move stop up" [disabled]="index === 0" (click)="move(index, index - 1)">↑</button>
                            <button type="button" aria-label="Move stop down" [disabled]="index === indices().length - 1" (click)="move(index, index + 1)">↓</button>
                            <button type="button" aria-label="Remove stop" (click)="remove(index)">×</button>
                        </div>
                    }
                    <button type="button" (click)="addStop()">Add stop</button>
                    <small>Typed keys are preserved. Missing or null results use the optional fallback.</small>
                </div>
            }
            @case ('color-ref') {
                <div class="style-color">
                    <select aria-label="Color source" [ngModel]="model.isRecord(path) ? 'option' : 'literal'"
                        (ngModelChange)="set($event === 'option' ? {option: ''} : '#000000')">
                        <option value="literal">Literal color</option><option value="option">Color option</option>
                    </select>
                    @if (model.isRecord(path)) {
                        <input aria-label="Color option ID" [value]="text(child('option'))"
                            (change)="set(eventText($event), child('option'))">
                    } @else {
                        <input [attr.aria-label]="label" [ngModel]="text()" (ngModelChange)="set($event)">
                    }
                </div>
            }
            @case ('color') {
                <div class="style-color">
                    <input type="color" aria-label="Color picker" [value]="pickerColor()" (input)="set(eventText($event))">
                    <input [attr.aria-label]="label" [ngModel]="text()" (ngModelChange)="set($event)"
                        placeholder="Named color or RGB hex">
                </div>
            }
            @default {
                <input [attr.aria-label]="label" [ngModel]="text()" (ngModelChange)="set($event)" autocomplete="off">
            }
        }
        @if (error) { <small class="style-form-error" role="alert">{{ error }}</small> }
    `
})
/** Typed leaf controls shared by all style records; never evaluates native style semantics. */
export class StyleFieldInputComponent implements OnChanges, OnDestroy {
    @Input({required: true}) model!: StyleDocumentModel;
    @Input({required: true}) path: StylePath = [];
    @Input({required: true}) field!: StyleField;
    @Input() scope: "feature" | "attribute" | "relation" = "feature";
    @Output() edit = new EventEmitter<StyleDocumentEdit>();
    @Output() problem = new EventEmitter<StyleInputProblem>();
    private numericInputs = new Map<string, {path: StylePath; text: string; sourceValue: string; message: string}>();

    get error(): string { return [...this.numericInputs.values()].find(input => input.message)?.message ?? ""; }
    get id(): string { return this.path.join("."); }
    get label(): string { return this.field.label ?? String(this.path.at(-1)); }
    get value(): unknown { return this.model.value(this.path); }
    get categorical(): boolean { return this.model.value([...this.path.slice(0, -1), "mode"]) === "categorical"; }
    get kind(): StyleField["kind"] {
        if (this.field.kind !== "option-default") return this.field.kind;
        const type = this.model.value([...this.path.slice(0, -1), "type"]);
        return type === undefined || type === "bool" ? "boolean" : type === "color" ? "color" : "string";
    }

    /** Locates a vector component or scale cell. */
    child(...parts: (string | number)[]): StylePath { return [...this.path, ...parts]; }
    /** Displays a scalar exactly, including bigint category keys. */
    text(path: StylePath = this.path): string {
        return this.numericInputs.get(path.join("."))?.text ?? String(this.model.value(path) ?? "");
    }
    /** Extracts user text from a native input event. */
    eventText(event: Event): string { return (event.target as HTMLInputElement).value; }
    /** Publishes an intentional field edit and clears a corrected local input error. */
    set(value: unknown, path: StylePath = this.path): void {
        const key = path.join(".");
        for (const candidate of this.numericInputs.keys()) {
            if (candidate === key || candidate.startsWith(key + ".")) this.numericInputs.delete(candidate);
        }
        this.report();
        this.edit.emit({op: "set", path, value, remove: path === this.path ? this.field.exclusive : []});
    }
    /** Validates only the input's primitive number shape; native validation owns its domain. */
    number(event: Event, path: StylePath): void {
        const input = {path, text: this.eventText(event), sourceValue: String(this.model.value(path) ?? ""), message: ""};
        this.numericInputs.set(path.join("."), input);
        try {
            const value = parseStyleNumber(input.text);
            input.sourceValue = String(value);
            this.report();
            this.edit.emit({op: "set", path, value});
        } catch (error) {
            input.message = error instanceof Error ? error.message : String(error);
            this.report();
        }
    }
    /** Preserves scalar enum syntax until a user adds a second choice. */
    toggleChoice(choice: string, event: Event): void {
        const values = Array.isArray(this.value) ? [...this.value] : [this.value];
        const next = (event.target as HTMLInputElement).checked
            ? [...values.filter(value => value !== choice), choice] : values.filter(value => value !== choice);
        this.set(next.length === 1 && !Array.isArray(this.value) ? next[0] : next);
    }
    /** Tests a native enum scalar or list without changing its representation. */
    includes(choice: string): boolean { return Array.isArray(this.value) ? this.value.includes(choice) : this.value === choice; }
    /** Returns authored vector/stop indices. */
    indices(): number[] { return Array.from({length: this.model.length(this.path)}, (_, i) => i); }
    /** Uses zero to represent the scalar alternative of a vector field. */
    vectorLength(): number { return Array.isArray(this.value) ? this.value.length : 0; }
    /** Changes a vector's explicit shape, preserving existing components where possible. */
    resize(size: number): void {
        const values = Array.isArray(this.value) ? this.value : [this.value];
        this.set(size === 0 ? values[0] ?? 0 : Array.from({length: size}, (_, i) => values[i] ?? 0));
    }
    /** Reports the exact category key type instead of inferring it from its displayed text. */
    stopKeyType(index: number): string {
        const type = typeof this.model.value([...this.path, index, 0]);
        return type === "bigint" ? "number" : type;
    }
    /** Makes category type changes explicit and resets the key to an unambiguous value. */
    changeStopType(index: number, type: string): void {
        this.set(type === "number" ? 0 : type === "boolean" ? false : "", [...this.path, index, 0]);
    }
    /** Writes a numeric or string stop key using its selected type. */
    stopKey(index: number, event: Event): void {
        const path = [...this.path, index, 0];
        if (this.stopKeyType(index) === "number") this.number(event, path);
        else this.set(this.eventText(event), path);
    }
    /** Writes the native scale's color/width stop value. */
    stopValue(index: number, event: Event): void {
        if (this.field.valueKind === "number") this.number(event, [...this.path, index, 1]);
        else this.set(this.eventText(event), [...this.path, index, 1]);
    }
    /** Appends one editable typed stop. */
    addStop(): void { this.edit.emit({op: "append", path: this.path, value: [0, this.field.valueKind === "color" ? "#000000" : 1]}); }
    /** Reorders stops without regenerating their AST nodes. */
    move(index: number, to: number): void { this.edit.emit({op: "move", path: this.path, index, to}); }
    /** Removes precisely the chosen stop. */
    remove(index: number): void { this.edit.emit({op: "remove", path: [...this.path, index]}); }
    /** Shows an RGB picker only as a convenience; the text field retains native color syntax. */
    pickerColor(): string {
        return stylePickerColor(this.value);
    }
    /** Drops stale buffers after external source edits, retaining other unfinished numeric cells. */
    ngOnChanges(): void {
        let removed = false;
        for (const [key, input] of this.numericInputs) {
            if (String(this.model.value(input.path) ?? "") !== input.sourceValue) {
                this.numericInputs.delete(key);
                removed = true;
            }
        }
        if (removed) this.report();
    }
    /** Clears local form errors when a field/rule is removed. */
    ngOnDestroy(): void { this.problem.emit({path: this.id, message: ""}); }
    /** Reports all cells together so correcting one cannot hide another invalid value. */
    private report(): void {
        this.problem.emit({path: this.id, message: this.error});
    }
}
