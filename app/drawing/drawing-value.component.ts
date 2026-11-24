import {ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges} from '@angular/core';
import {DrawingDocumentsService} from './drawing-documents.service';
import {DrawingObjectEdit, DrawingValueNode} from './drawing.model';

/** On-demand native JSON branches preserve exact leaf text without materializing a feature in JavaScript. */
@Component({selector: 'drawing-value', standalone: false, template: `
    <div class="node" role="treeitem" [attr.aria-label]="label" [tabindex]="path === '/geometry' || path === '/erdblick:drawing/points' ? 0 : -1" [attr.aria-expanded]="branch ? expanded : null">
        @if (branch) {
            <button pButton type="button" class="tree-toggle" tabindex="-1" [text]="true" [attr.aria-expanded]="expanded" (click)="toggle()">
                <i [class]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true"></i>
                <span>{{label}}</span><small>{{node?.size ?? ''}}</small>
            </button>
            @if (expanded) {
                <div class="children" role="group">
                    @for (child of children; track child.path) {
                        <drawing-value [label]="childLabel(child)" [mapId]="mapId" [objectId]="objectId" [revision]="revision"
                            [path]="child.path" [node]="child" [geometryType]="childGeometryType(child)" [disabled]="disabled || loading" (edit)="edit.emit($event)" (segment)="segment.emit($event)"/>
                        @if (vertices && child.type === 'array') {
                            <div class="vertex-actions">
                                <button pButton type="button" [text]="true" [disabled]="disabled" (click)="segment.emit({path, index: +child.key})">Select segment after vertex {{+child.key + 1}}</button>
                                <button pButton type="button" [text]="true" [disabled]="disabled" (click)="vertex('insertVertex', child)">Insert after</button>
                                <button pButton type="button" [text]="true" severity="danger" [disabled]="disabled" (click)="vertex('deleteVertex', child)" pTooltip="Removes adjoining curve controls">Delete vertex</button>
                            </div>
                        }
                    }
                    @if (offset) { <button pButton type="button" [text]="true" [disabled]="loading" (click)="load(previous.pop() ?? 0, false)">Previous page</button> }
                    @if (nextOffset !== null) { <button pButton type="button" [text]="true" [disabled]="loading" (click)="load(nextOffset)">Next page</button> }
                    @if (loading) { <span role="status">Loading…</span> }
                    @if (!loading && !children.length) { <span class="muted">Empty {{node?.type}}</span> }
                </div>
            }
        } @else {
            <label class="leaf"><span>{{label}}</span>
                @if (node?.limited) { <span>Large value — edit in Advanced</span> }
                @else if (node?.type === 'boolean') {
                    <p-checkbox [binary]="true" [tabindex]="-1" [ngModel]="node?.text === 'true'" [disabled]="disabled" [ariaLabel]="label"
                        (onChange)="commit($event.checked ? 'true' : 'false')"/>
                } @else {
                    <input pInputText tabindex="-1" [attr.aria-label]="label" [value]="displayText" [disabled]="disabled" (change)="change($event)" (keydown.escape)="cancelField($event)"/>
                }
            </label>
        }
        @if (propertyPath) {
            <button pButton type="button" [text]="true" class="value-options" [attr.aria-label]="'Value options for ' + label" [attr.aria-expanded]="propertyMenu" (click)="togglePropertyMenu()"><i class="pi pi-sliders-h" aria-hidden="true"></i><small>{{node?.type || 'Value options'}}</small></button>
            @if (propertyMenu) {
                <div class="property-controls" role="group" [attr.aria-label]="label + ' value options'">
                    <label>Type <p-select [options]="propertyTypes" [(ngModel)]="typeDraft" [disabled]="disabled" appendTo="body" [ariaLabel]="label + ' value type'"/></label>
                    <button pButton type="button" [text]="true" [disabled]="disabled || typeDraft === node?.type" (click)="changeType()">Apply type</button>
                    <small>Changing type replaces this value; Undo restores it.</small>
                    @if (node?.type === 'object') {
                        <input pInputText [attr.aria-label]="'New property in ' + label" [(ngModel)]="newKey" [disabled]="disabled" placeholder="Property name"/>
                        <button pButton type="button" [text]="true" [disabled]="disabled || !newKey" (click)="addChild()">Add property</button>
                    } @else if (node?.type === 'array') {
                        <button pButton type="button" [text]="true" [disabled]="disabled" (click)="addChild()">Append item</button>
                    }
                    @if (path !== '/properties') { <button pButton type="button" [text]="true" severity="danger" [disabled]="disabled" (click)="removeValue()">Remove value</button> }
                </div>
            }
        }
    </div>
`, styles: [`.node:focus-visible{outline:2px solid var(--p-primary-color);outline-offset:-2px;border-radius:3px}.children{padding-left:.75rem;border-left:1px solid var(--p-content-border-color)}.leaf{display:flex;gap:.5rem;padding:.25rem 0;align-items:center}.leaf>span{flex:0 1 10rem;overflow-wrap:anywhere}.leaf input{min-width:0;flex:1}.tree-toggle{width:100%;justify-content:flex-start;min-height:32px;padding:.3rem}.tree-toggle small{margin-left:auto}.vertex-actions{display:flex;flex-wrap:wrap;gap:.25rem;margin-bottom:.4rem}.vertex-actions button{font-size:.75rem;padding:.25rem}.value-options{padding:.15rem .35rem;gap:.35rem}.property-controls{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;padding:.4rem;border:1px solid var(--p-content-border-color);border-radius:4px}.property-controls label{display:flex;align-items:center;gap:.4rem}.property-controls small{flex-basis:100%}.property-controls input{min-width:0;max-width:100%}.muted,small{color:var(--p-text-muted-color)}`]})
export class DrawingValueComponent implements OnChanges, OnDestroy {
    @Input() label = '';
    @Input() mapId = '';
    @Input() objectId = '';
    @Input() path = '';
    @Input() revision = 0;
    @Input() node?: DrawingValueNode;
    @Input() disabled = false;
    @Input() geometryType = '';
    @Output() edit = new EventEmitter<DrawingObjectEdit>();
    @Output() segment = new EventEmitter<{path: string; index: number}>();
    children: DrawingValueNode[] = [];
    nextOffset: number | null = null;
    offset = 0;
    previous: number[] = [];
    expanded = false;
    loading = false;
    propertyMenu=false;
    typeDraft='null';
    newKey='';
    private serial = 0;
    /** The document owner supplies validation, diagnostics and worker lifetime. */
    constructor(private readonly documents: DrawingDocumentsService, private readonly cdr: ChangeDetectorRef) {}
    get branch(): boolean { return !this.node || ['object','array'].includes(this.node.type); }
    get propertyPath():boolean{return this.path==='/properties'||this.path.startsWith('/properties/');}
    get propertyTypes():string[]{return this.path==='/properties'?['object','null']:['string','number','boolean','null','object','array'];}
    get coordinatePath(): boolean { return this.path.startsWith('/geometry/') || this.path.startsWith('/erdblick:drawing/points') || this.path.startsWith('/erdblick:drawing/curves/'); }
    get vertices(): boolean { return this.coordinatePath && !this.path.includes('/curves/') && this.children.length > 0 && /(?:coordinates|points|\d+)$/.test(this.path) && this.children.every(child => child.type === 'array' && [2,3].includes(child.size ?? 0)); }
    get displayText(): string { return this.node?.type === 'string' ? JSON.parse(this.node.text ?? '""') : this.node?.text ?? ''; }
    /** A revised native source invalidates loaded descendants, retaining expansion intent. */
    ngOnChanges(changes:SimpleChanges): void {
        if(!['mapId','objectId','path','revision'].some(key=>changes[key]))return;
        ++this.serial;
        if(changes['mapId']||changes['objectId']||changes['path']){this.offset=0;this.previous=[];}
        if(this.expanded)void this.load(this.offset,false);else this.children=[];
    }
    /** Expand only this branch; descendants stay unopened and unloaded. */
    toggle(): void { this.expanded = !this.expanded; if (this.expanded && !this.children.length) void this.load(0); }
    /** Reveal structural changes only when requested, keeping the ordinary coordinate tree compact. */
    async togglePropertyMenu():Promise<void>{
        if(!this.node)await this.load(0);
        this.propertyMenu=!this.propertyMenu;this.typeDraft=this.node?.type??'null';
    }
    /** Deliberate type changes reuse native exact-value validation and the shared undo history. */
    changeType():void{
        const defaults:Record<string,string>={string:'""',number:'0',boolean:'false',null:'null',object:'{}',array:'[]'};
        let text=defaults[this.typeDraft];
        if(text===undefined)return;
        if(this.typeDraft==='string'&&!this.branch)text=JSON.stringify(this.displayText);
        else if(this.typeDraft==='number'&&this.node?.type==='string')text=this.displayText;
        this.commit(text);
    }
    /** Add one null member without fetching its siblings; existing keys require an explicit edit. */
    async addChild():Promise<void>{
        const key=this.newKey,path=this.path+'/'+(this.node?.type==='array'?'-':key.replace(/~/g,'~0').replace(/\//g,'~1'));
        if(this.node?.type==='object'){
            try{await this.documents.sources.branch(this.mapId,{id:this.objectId,path,revision:this.revision,count:1});this.documents.notify('quick','That property already exists. Select its value to edit it.');return;}
            catch(error){if(!String(error).includes('branch no longer exists')){this.documents.notify('quick',String(error));return;}}
        }
        this.edit.emit({type:'setExact',id:this.objectId,path,text:'null'});this.newKey='';this.expanded=true;
    }
    /** Removing a property or array item is one native, undoable structural operation. */
    removeValue():void{this.edit.emit({type:'remove',id:this.objectId,path:this.path});}
    /** Fetch a bounded branch page against the selection's accepted revision. */
    async load(offset: number, forward = true): Promise<void> {
        const serial = ++this.serial; this.loading = true;
        try {
            const branch = await this.documents.sources.branch(this.mapId, {id:this.objectId,path:this.path,revision:this.revision,offset,count:50});
            if (serial !== this.serial) return;
            if (offset && forward) this.previous.push(this.offset);
            this.offset=offset; this.node = branch; this.children = branch.entries; this.nextOffset = branch.nextOffset;
        } catch (error) {
            if(serial===this.serial&&!this.documents.documents.get(this.mapId)?.busy&&this.documents.sources.sources.get(this.mapId)?.summary.revision===this.revision)
                this.documents.notify('quick',String(error));
        }
        finally { if (serial === this.serial) { this.loading = false; this.cdr.markForCheck(); } }
    }
    /** Semantic labels replace implementation indices where their meaning is known. */
    childLabel(child: DrawingValueNode): string {
        if(child.key==='coordinates' && (this.coordinatePath || this.path==='/geometry'))return this.geometryType==='Polygon'?'Rings':this.geometryType==='MultiPolygon'?'Polygons':this.geometryType==='MultiLineString'?'Parts':this.geometryType==='Point'?'Position':'Vertices';
        if (this.path === '/erdblick:drawing/curves') return `Segment ${+child.key+1}`;
        if (/\/curves\/\d+$/.test(this.path)) return `Control handle ${+child.key+1}`;
        if (this.vertices) return `Vertex ${+child.key+1}`;
        if (this.node?.type === 'array' && this.coordinatePath) {
            if (this.geometryType === 'Polygon') return +child.key ? `Hole ${child.key}` : 'Outer ring';
            if (this.geometryType === 'MultiPolygon') return `Polygon ${+child.key+1}`;
            if (this.geometryType === 'MultiLineString') return `Part ${+child.key+1}`;
        }
        if (this.coordinatePath && this.node?.type === 'array' && this.children.every(value => value.type === 'number') && this.children.length <= 3)
            return ['Longitude (°)','Latitude (°)','Ellipsoidal height (m)'][+child.key] ?? child.key;
        if (this.path.endsWith('/geometries')) return `Geometry ${+child.key+1}`;
        return child.key;
    }
    /** Carry geometry semantics through nested coordinate arrays, while collections discover each part's type. */
    childGeometryType(child: DrawingValueNode): string {
        const typeNode=this.children.find(value=>value.key==='type'&&value.type==='string');
        if(typeNode)return JSON.parse(typeNode.text??'""');
        if(child.type==='array'&&this.node?.type==='array')return this.geometryType==='MultiPolygon'?'Polygon':this.geometryType==='Polygon'||this.geometryType==='MultiLineString'?'LineString':this.geometryType;
        return this.geometryType;
    }
    /** Keep numeric JSON lexical values intact; native parsing performs range and shape checks. */
    change(event: Event): void { const value=(event.target as HTMLInputElement).value; if(value!==this.displayText)this.commit(this.node?.type === 'string' ? JSON.stringify(value) : value); }
    /** Escape restores the accepted lexical value and returns to tree navigation without an edit. */
    cancelField(event:Event):void{event.preventDefault();event.stopPropagation();const input=event.target as HTMLInputElement;input.value=this.displayText;input.closest<HTMLElement>('[role="treeitem"]')?.focus();}
    /** Emit a single lossless, source-addressed history mutation. */
    commit(text: string): void { this.edit.emit({type:'setExact',id:this.objectId,path:this.path,text}); }
    /** Native insertion uses the selected segment's real interpolation, including curves. */
    vertex(type: 'insertVertex'|'deleteVertex', child: DrawingValueNode): void { this.edit.emit({type,id:this.objectId,path:this.path,index:+child.key}); }
    /** Ignore outstanding branch responses after a selection is destroyed. */
    ngOnDestroy(): void { ++this.serial; }
}
