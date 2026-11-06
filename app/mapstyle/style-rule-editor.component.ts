import {CommonModule} from '@angular/common';
import {Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, TemplateRef, ViewChild} from '@angular/core';
import {MenuItem} from 'primeng/api';
import {TieredMenuModule} from 'primeng/tieredmenu';
import {TooltipModule} from 'primeng/tooltip';
import {StyleAuthoringSchema} from './style-authoring-schema.adapter';
import {StyleDocumentModel, StylePath} from './style-document.model';
import {StylePropertyDraft, StyleRuleAction} from './style-property-draft.controller';
import {STYLE_RULE_CATEGORIES, STYLE_RULE_STRUCTURES, StyleRuleProperty, styleRuleProperties} from './style-rule.presentation';

@Component({
    selector: 'style-rule-editor',
    standalone: true,
    imports: [CommonModule, TieredMenuModule, TooltipModule],
    templateUrl: './style-rule-editor.component.html'
})
/** Recursive rule overview. All depths forward edits to one document-owned property draft. */
export class StyleRuleEditorComponent implements OnChanges {
    @Input({required: true}) model!: StyleDocumentModel;
    @Input({required: true}) catalog!: StyleAuthoringSchema;
    @Input({required: true}) path!: StylePath;
    @Input() propertyTemplate?: TemplateRef<unknown>;
    @Input() draft?: StylePropertyDraft;
    @Input() scope: 'feature' | 'attribute' | 'relation' = 'feature';
    @Input() title = '';
    @Output() action = new EventEmitter<StyleRuleAction>();
    properties: StyleRuleProperty[] = [];
    structures: StyleRuleProperty[] = [];
    addMenuItems: MenuItem[] = [];
    @ViewChild('addButton') private addButton?: ElementRef<HTMLButtonElement>;
    unknownKeys: string[] = [];
    // Defer unopened descendants, then retain their expansion state on collapse.
    readonly visitedSections = new Set<string>();
    private expandedSections = new Map<string, boolean>();

    get id(): string { return this.path.join('.'); }
    get heading(): string { return this.title || `Rule ${this.path.filter(part => typeof part === 'number').map(part => Number(part) + 1).join('.')}`; }
    get index(): number | undefined { const last = this.path.at(-1); return typeof last === 'number' ? last : undefined; }
    get activeDraft(): StylePropertyDraft | undefined { return this.draft?.rulePath.join('.') === this.id ? this.draft : undefined; }
    get effectiveScope(): 'feature' | 'attribute' | 'relation' {
        const value = this.path.length === 2 ? this.model.value([...this.path, 'scope']) : this.scope;
        return value === 'attribute' || value === 'relation' ? value : 'feature';
    }

    /** Refreshes summaries only when source or rule inputs change, never by evaluating style expressions. */
    ngOnChanges(changes: SimpleChanges): void {
        const previousPath: StylePath | undefined = changes['path']?.previousValue;
        const pathChanged = !!changes['path'] && (!previousPath || previousPath.length !== this.path.length
            || previousPath.some((part, index) => part !== this.path[index]));
        // Template path arrays and draft updates need not rebuild source summaries.
        if (!changes['model'] && !changes['catalog'] && !pathChanged) return;
        const fields = styleRuleProperties(this.model, this.catalog, this.path);
        this.properties = fields.filter(field => field.present && !STYLE_RULE_STRUCTURES[field.key]);
        this.structures = fields.filter(field => field.present && STYLE_RULE_STRUCTURES[field.key]);
        this.unknownKeys = this.model.keys(this.path).filter(key => !this.catalog.records['rule'][key]);
    }

    /** Build on opening: equivalent path inputs must not rebuild the active menu and reset its focus/submenus. */
    prepareAddMenu(): void {
        const fields = styleRuleProperties(this.model, this.catalog, this.path);
        const choices = [...STYLE_RULE_CATEGORIES, 'Structure'].map(name => ({name,
            fields: fields.filter(field => !field.present && (STYLE_RULE_STRUCTURES[field.key] ? name === 'Structure' : field.category === name))
        })).filter(group => group.fields.length);
        const sections = choices.flatMap(group => group.name !== 'Labels' ? [group]
            : ['Common', 'Labels', 'Label layout', 'Label decoration'].map(section => ({
                name: section === 'Common' ? 'Labels · Text' : section === 'Labels' ? 'Labels · Font and size' : section,
                fields: group.fields.filter(field => field.field.group === section)
            })).filter(section => section.fields.length));
        this.addMenuItems = sections.map(group => ({label: group.name, items: group.fields.map(property => ({
            label: property.label,
            automationId: property.key,
            command: () => {
                // Return to the rule's add button, not a menu item removed when the popup closes.
                if (this.addButton) this.add(property, this.addButton.nativeElement);
            }
        }))}));
        if (!this.addMenuItems.length) {
            this.addMenuItems = [{label: 'All available properties are configured.', disabled: true}];
        }
    }

    /** Opens an exact property; the originating button receives focus when the panel closes. */
    open(property: StyleRuleProperty, target: HTMLElement): void {
        this.action.emit({kind: 'open', path: this.path, key: property.key, target});
    }

    /** Adds only explicitly requested structure; ordinary choices open an isolated field draft. */
    add(property: StyleRuleProperty, target: HTMLElement): void {
        if (!STYLE_RULE_STRUCTURES[property.key]) { this.open(property, target); return; }
        if (this.draft) return;
        const other = property.key === 'first-of' ? 'all-of' : property.key === 'all-of' ? 'first-of' : '';
        this.action.emit({kind: 'edit', edit: other && this.model.has([...this.path, other])
            ? {op: 'rename', path: [...this.path, other], key: property.key}
            : {op: 'set', path: [...this.path, property.key], value: property.field.kind === 'list' ? [] : {}}});
    }

    /** Locates a structural field without constructing paths in Angular templates. */
    fieldPath(key: string): StylePath { return [...this.path, key]; }
    /** Locates a branch child. */
    childPath(key: string, index: number): StylePath { return [...this.path, key, index]; }

    /** Supplies child paths without converting their YAML records to JavaScript objects. */
    children(key: string): number[] { return Array.from({length: this.model.length([...this.path, key])}, (_, i) => i); }

    /** Endpoint styles use feature expressions; line markers retain the current completion contract. */
    childScope(key: string): 'feature' | 'attribute' | 'relation' {
        return ['relation-source-style', 'relation-target-style'].includes(key) ? 'feature' : this.effectiveScope;
    }

    /** Keeps the active panel's ancestor subsection expanded during browsing. */
    containsDraft(key: string): boolean {
        const prefix = [...this.path, key];
        return !!this.draft && prefix.every((part, i) => this.draft!.rulePath[i] === part);
    }

    /** Starts with the first level visible and retains the user's subsection choices. */
    sectionOpen(key: string): boolean {
        return this.containsDraft(key) || (this.expandedSections.get(key) ?? this.path.length <= 2);
    }

    /** Rejects a collapse that would hide the only draft controls. */
    toggleSection(key: string, event: Event): void {
        const details = event.target;
        if (details instanceof HTMLDetailsElement) {
            if (this.containsDraft(key)) details.open = true;
            if (details.open) this.visitedSections.add(key);
            this.expandedSections.set(key, details.open);
        }
    }

    /** Reorders source nodes; structural controls stay disabled while any field is being edited. */
    move(to: number): void {
        if (this.index !== undefined) this.action.emit({kind: 'edit', edit: {op: 'move', path: this.path.slice(0, -1), index: this.index, to}});
    }

    /** Requests explicit confirmation for named rule/subtree removal through the document owner. */
    remove(path: StylePath, label: string, target: HTMLElement): void {
        this.action.emit({kind: 'remove-structure', path, label, target});
    }
}
