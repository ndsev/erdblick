import {Component, Input, OnChanges, OnDestroy, Output, EventEmitter, ChangeDetectorRef} from '@angular/core';
import {Subscription} from 'rxjs';
import {DrawingDocumentsService} from './drawing-documents.service';
import {DrawingObject, DrawingMeasurements, DrawingRow, DrawingObjectEdit, DrawingAuthoring, DrawingBranch, recognizedDrawingAuthoring} from './drawing.model';
import {DrawingToolsService} from './drawing-tools.service';

/** Quick is a paged semantic GeoJSON tree and typed inspector backed by the shared workspace selection. */
@Component({selector: 'drawing-quick', standalone: false, template: `
    @if (document; as doc) {
        <div class="quick-layout">
            <nav class="object-page" aria-label="Drawing objects">
                @for (row of rows; track row.id) {
                    <button pButton type="button" [text]="true" class="object-row" [class.selected]="documents.selectedObjectId === row.id && documents.activeId === mapId"
                        (click)="select(row)" (mouseenter)="hover.emit(row)" (mouseleave)="hover.emit(undefined)">
                        <i class="pi pi-map-marker" aria-hidden="true"></i><span>{{row.description || row.geometryType || 'Empty geometry'}}<small>{{row.geometryType}} · {{row.space || 'Imported'}}</small></span>
                    </button>
                }
                <div class="paging"><button pButton type="button" [text]="true" aria-label="Previous objects" [disabled]="offset === 0" (click)="page(-1)"><i class="pi pi-angle-left"></i></button>
                    <span>{{count ? offset + 1 : 0}}–{{offset + rows.length}} / {{count}}</span>
                    <button pButton type="button" [text]="true" aria-label="Next objects" [disabled]="offset + rows.length >= count" (click)="page(1)"><i class="pi pi-angle-right"></i></button></div>
            </nav>
            <section class="object-detail" aria-label="Object inspector">
                @if (selected; as object) {
                    <div class="detail-actions"><strong>{{branch?.row?.description || branch?.row?.geometryType}}</strong>
                        <button pButton type="button" [text]="true" [disabled]="disabled || !author" (click)="editView()">Edit in view</button>
                        <button pButton type="button" [text]="true" (click)="fit(object)">Fit</button></div>
                    @if (!author) { <p>Choose the space used for editing and measurements. Imported GeoJSON keeps its coordinate-linear path.</p> }
                    <label class="field">Space <p-select [options]="spaces" optionLabel="label" optionValue="value" placeholder="Choose space" appendTo="body"
                        [disabled]="disabled" [ngModel]="author?.space" (onChange)="setAuthor({space:$event.value})" ariaLabel="Authoring space"/></label>
                    @if (author?.space === '3d' && branch?.row?.heightState !== 'present') { <p>3D measurements need a height at every vertex. Assign missing heights below or choose 2D.</p>
                        <label class="field">Missing height (m) <input pInputText type="number" [(ngModel)]="missingHeight"/></label>
                        <button pButton type="button" [text]="true" [disabled]="disabled" (click)="apply([{type:'height',id:object.id,meters:missingHeight}])">Assign missing heights</button> }
                    <label class="field">Name <input pInputText [disabled]="disabled" [ngModel]="object.feature.properties?.['name'] || ''" (change)="property('name',$any($event.target).value)" (keydown.escape)="restoreField($event,object.feature.properties?.['name'] || '')" (keydown.enter)="commitField($event)"/></label>
                    <div class="field"><label for="drawing-object-color">Color</label>
                        <p-colorpicker [ngModel]="colorDraft" format="hex" appendTo="body" [overlayOptions]="{baseZIndex:31000}" [disabled]="disabled" [pt]="{preview:{'aria-label':'Object color'}}" (onChange)="pickColor($event)" (keydown.escape)="$event.stopPropagation()"/>
                        <input pInputText id="drawing-object-color" aria-label="Object color hex" [(ngModel)]="colorDraft" maxlength="7" [disabled]="disabled" (keydown.escape)="resetColor()"/>
                        <button pButton type="button" [text]="true" [disabled]="disabled || !validColor || colorDraft === object.feature.properties?.['color']" (click)="property('color',colorDraft)">Apply color</button></div>
                    <label class="field"><p-checkbox [binary]="true" [ngModel]="branch?.row?.visible !== false" [disabled]="disabled" ariaLabel="Object visible" (onChange)="apply([{type:'visibility',id:object.id,visible:$event.checked}])"/> Visible</label>
                    @if (author?.kind === 'annotation') {
                        <label class="field">Text <input pInputText [ngModel]="author?.text" [disabled]="disabled" (change)="setAuthor({text:$any($event.target).value})" (keydown.escape)="restoreField($event,author?.text)" (keydown.enter)="commitField($event)"/></label>
                        <label class="field">Text size (px) <input pInputText type="number" min="8" max="48" [disabled]="disabled" [ngModel]="author?.fontSize || 13" (change)="setAuthor({fontSize:+$any($event.target).value})" (keydown.escape)="restoreField($event,author?.fontSize || 13)" (keydown.enter)="commitField($event)"/></label>
                    }
                    @if (author && availableMeasurements.length) {
                        <fieldset><legend>Measurements</legend>
                            @for (item of availableMeasurements; track item.key) {
                                <label><p-checkbox [binary]="true" [disabled]="disabled" [ngModel]="measurements[item.key] || false" [ariaLabel]="item.label" (onChange)="measurement(item.key,$event.checked)"/> {{item.label}}</label>
                            }
                            <label class="field">Units <p-select [options]="units" optionLabel="label" optionValue="value" [ngModel]="author.unit || 'meters'" [disabled]="disabled" (onChange)="setAuthor({unit:$event.value})" appendTo="body" ariaLabel="Object measurement units"/></label>
                            @if (measurements.ticks) {
                                <label class="field">Interval ({{author.unit === 'miles' ? 'mi' : 'm'}}) <input pInputText type="number" min="0.000001" [disabled]="disabled" [ngModel]="interval" (change)="setMeasurements({intervalMeters:+$any($event.target).value * unitFactor})" (keydown.escape)="restoreField($event,interval)" (keydown.enter)="commitField($event)"/></label>
                                <label class="field">Marker <p-select [options]="markers" optionLabel="label" optionValue="value" [disabled]="disabled" [ngModel]="measurements.marker || 'point'" (onChange)="setMeasurements({marker:$event.value})" appendTo="body" ariaLabel="Interval marker style"/></label>
                            }
                        </fieldset>
                    }
                    @if (object.metrics; as metrics) {
                        <dl class="metrics">
                            @if (availableMeasurements.length) { <dt>Length</dt><dd>{{tools.format(metrics.lengthMeters, author?.unit)}}</dd> }
                            @if (measurements.area) { <dt>Area</dt><dd>{{tools.formatArea(metrics.areaSquareMeters, author?.unit)}}</dd> }
                            @if (measurements.angles) { <dt>Angles</dt><dd>@for (angle of metrics.anglesDegrees; track $index) { <span>{{angle === null ? 'Unavailable' : angle.toFixed(2) + '°'}} </span> }</dd> }
                        </dl>
                        @if ((metrics.angleCount || 0) > 100 && measurements.angles) { <p>Showing the first 100 vertex angles of {{metrics.angleCount}}.</p> }
                        @if (measurements.ticks) { <p>Markers follow the saved interval. At low zoom, a spaced subset is shown across the visible path.</p> }
                    }
                    @if (author?.kind === 'polyline' && selectedSegment !== undefined) {
                        <div class="detail-actions"><span>Segment {{selectedSegment + 1}}</span>
                            <button pButton type="button" [text]="true" [disabled]="disabled" (click)="curve(true)">Add curve handles</button>
                            <button pButton type="button" [text]="true" [disabled]="disabled" (click)="curve(false)">Straighten</button></div>
                    }
                    <div role="tree" aria-label="GeoJSON structure" (keydown)="treeKey($event)" (focusin)="treeFocus($event)">
                        @if (author && author.kind !== 'ordinary') {
                            <drawing-value label="Control vertices" path="/erdblick:drawing/points" [mapId]="mapId" [objectId]="object.id" [revision]="object.revision" [disabled]="disabled" (edit)="apply([$event])" (segment)="segment($event)"/>
                            @if (branch?.curveCount) { <drawing-value label="Curve handles" path="/erdblick:drawing/curves" [mapId]="mapId" [objectId]="object.id" [revision]="object.revision" [disabled]="disabled" (edit)="apply([$event])"/> }
                        } @else {
                            <drawing-value label="Geometry · parts and rings" path="/geometry" [geometryType]="branch?.row?.geometryType || ''" [mapId]="mapId" [objectId]="object.id" [revision]="object.revision" [disabled]="disabled" (edit)="apply([$event])" (segment)="segment($event)"/>
                        }
                        <drawing-value label="Properties" path="/properties" [mapId]="mapId" [objectId]="object.id" [revision]="object.revision" [disabled]="disabled" (edit)="apply([$event])"/>
                    </div>
                    @if (author && author.kind !== 'ordinary') { <button pButton type="button" [text]="true" [disabled]="disabled" (click)="apply([{type:'convert',id:object.id}])">Convert to sampled GeoJSON geometry</button> }
                } @else { <p>Select an object to inspect its geometry and properties.</p> }
            </section>
        </div>
    }
`, styles: [`.quick-layout{display:grid;grid-template-columns:minmax(10rem,25%) minmax(0,1fr);height:100%;min-height:0}.object-page,.object-detail{overflow:auto;min-width:0;padding:.5rem}.object-page{border-right:1px solid var(--p-content-border-color)}.object-row{width:100%;justify-content:flex-start;text-align:left;min-height:40px}.object-row span{overflow:hidden;text-overflow:ellipsis}.object-row small{display:block;color:var(--p-text-muted-color)}.selected{background:var(--p-highlight-background)}.paging,.detail-actions{display:flex;align-items:center;gap:.3rem;flex-wrap:wrap}.paging{justify-content:space-between;font-size:.8rem}.detail-actions strong{margin-right:auto}.field{display:flex;gap:.75rem;align-items:center;margin:.5rem 0}.field>input,.field>p-select{flex:1;min-width:0}fieldset{border:1px solid var(--p-content-border-color);border-radius:6px;padding:.5rem;display:flex;flex-wrap:wrap;gap:.75rem;margin:.75rem 0}fieldset label{display:flex;align-items:center;gap:.4rem}.metrics{display:grid;grid-template-columns:auto 1fr;gap:.3rem}.metrics dd{margin:0}.object-detail p{font-size:.85rem;color:var(--p-text-muted-color)}@media(max-width:600px){.quick-layout{grid-template-columns:1fr;grid-template-rows:minmax(5rem,25%) minmax(0,1fr)}.object-page{border-right:0;border-bottom:1px solid var(--p-content-border-color)}}`]})
export class DrawingQuickComponent implements OnChanges, OnDestroy {
    @Input() mapId = '';
    @Output() hover = new EventEmitter<DrawingRow | undefined>();
    @Output() editInView = new EventEmitter<DrawingObject>();
    rows: DrawingRow[] = []; selected?: DrawingObject; branch?: DrawingBranch; offset = 0;
    selectedSegment?: number;
    missingHeight = 0;
    colorDraft = '#ff8a24';
    private serial = 0; private signature = '';
    private readonly subscription: Subscription;
    readonly spaces = [{label:'2D · ellipsoid',value:'2d'},{label:'3D · ellipsoidal height',value:'3d'}];
    readonly units = [{label:'Meters',value:'meters'},{label:'Miles',value:'miles'}];
    readonly markers = [{label:'Points',value:'point'},{label:'Ticks',value:'tick'}];
    readonly measurementOptions: {key: 'distances' | 'angles' | 'area' | 'perimeter' | 'ticks'; label: string}[] = [
        {key:'distances',label:'Distances'},{key:'angles',label:'Angles'},{key:'area',label:'Area'}, {key:'perimeter',label:'Perimeter'},{key:'ticks',label:'Interval markers'}
    ];
    /** Observe the shared selection and accepted revision instead of retaining an independent target. */
    constructor(public readonly documents: DrawingDocumentsService, private readonly cdr: ChangeDetectorRef, public readonly tools: DrawingToolsService) {
        this.subscription = documents.changed.subscribe(() => { if (this.key !== this.signature) void this.refresh(); this.cdr.markForCheck(); });
    }
    get key(): string { return `${this.mapId}:${this.documents.sources.sources.get(this.mapId)?.summary.revision}:${this.documents.activeId}:${this.documents.selectedObjectId}:${this.documents.selectedPath}`; }
    get availableMeasurements() {
        const kind=this.author?.kind, type=this.branch?.row?.geometryType ?? '';
        const polygon=kind === 'polygon' || kind === 'ellipse' || type.includes('Polygon'), line=kind === 'polyline' || type.includes('LineString');
        return this.measurementOptions.filter(item => polygon ? ['area','perimeter','ticks'].includes(item.key) : line ? ['distances','angles','ticks'].includes(item.key) : false);
    }
    get document() { return this.documents.documents.get(this.mapId); }
    get count(): number { return this.documents.sources.sources.get(this.mapId)?.summary.rowCount ?? 0; }
    get author() { return recognizedDrawingAuthoring(this.selected?.feature['erdblick:drawing']); }
    get measurements(): DrawingMeasurements { return this.author?.measurements ?? {}; }
    get unitFactor(): number { return this.author?.unit === 'miles' ? 1609.344 : 1; }
    get interval(): number { return (this.measurements.intervalMeters ?? 100) / this.unitFactor; }
    get validColor(): boolean { return /^#[0-9a-f]{6}$/i.test(this.colorDraft); }
    /** Escape abandons only this field; Enter commits through its ordinary blur boundary. */
    restoreField(event:Event,value:unknown):void{event.preventDefault();event.stopPropagation();(event.target as HTMLInputElement).value=String(value??'');}
    /** Reuse change/blur validation rather than emitting a second history edit on Enter. */
    commitField(event:Event):void{event.preventDefault();event.stopPropagation();(event.target as HTMLInputElement).blur();}
    /** Color is a local form buffer until Apply, creating exactly one undoable edit. */
    pickColor(event: {value?: unknown; originalEvent: Event}): void { event.originalEvent.preventDefault(); if(typeof event.value === 'string')this.colorDraft=event.value.startsWith('#')?event.value:'#'+event.value; }
    /** Escape restores the accepted value without publishing an intermediate swatch. */
    resetColor(): void { this.colorDraft=String(this.selected?.feature.properties?.['color'] ?? '#ff8a24'); }
    get disabled(): boolean { return !this.document || !!this.document.error || this.document.busy || this.document.saving || !!this.documents.workspaceBusy; }
    /** Rebind the view without making an implicit workspace selection. */
    ngOnChanges(): void { this.hover.emit(undefined); this.offset=0; this.selected=undefined; void this.refresh(); }
    /** Read bounded rows and only the selected object's small inspector summary. */
    async refresh(): Promise<void> {
        const serial=++this.serial; this.signature=this.key;
        if (!this.document) return;
        try {
            const rows=await this.documents.sources.rows(this.mapId,this.offset,50);
            if (serial !== this.serial) return; this.rows=rows;
            const id=this.documents.activeId === this.mapId ? this.documents.selectedObjectId : '';
            const branch=id ? await this.documents.sources.branch(this.mapId,{id,count:1}) : undefined;
            if (serial !== this.serial) return;
            this.branch=branch; this.selected=branch?.object;
            this.resetColor();
            const segment=this.documents.selectedPath.match(/^\/erdblick:drawing\/points\/(\d+)$/);this.selectedSegment=segment?+segment[1]:undefined;
            if (branch?.object?.metrics?.warning) this.documents.notify('metrics',branch.object.metrics.warning);
        } catch (error) { if(serial === this.serial){this.selected=undefined;this.documents.notify('quick',String(error));} }
        this.cdr.markForCheck();
    }
    /** Selection is shared with the tray, map handles and history commands. */
    async select(row: DrawingRow): Promise<void> { this.selectedSegment=undefined; await this.documents.selectObject(this.mapId,row.id); }
    /** Full controls are requested only for an explicit edit-in-view operation. */
    async editView(): Promise<void> { if(!this.selected)return; try {await this.tools.editTarget(this.mapId,this.selected.id);} catch(error){this.documents.notify('edit',String(error));} }
    /** Fit the selected object's renderable geographic extent in its captured view. */
    fit(object: DrawingObject): void { void this.tools.fitObject(this.mapId,object.id,this.document!.viewId).catch(error=>this.documents.notify('fit',String(error))); }
    /** Bound list reads to one page at a time. */
    page(delta: number): void { this.offset=Math.max(0,this.offset+delta*50); void this.refresh(); }
    /** All typed and tree edits use the same native transaction and CodeMirror history. */
    async apply(operations: DrawingObjectEdit[]): Promise<void> {
        if(!this.document || this.disabled)return;
        try {await this.documents.objectEdit(this.document,operations,this.selected?.revision);await this.refresh();}
        catch(error){this.documents.notify('quick',String(error));}
    }
    /** Commit scalar object properties on blur/Enter instead of every keystroke. */
    property(key: string, value: string): void {if(this.selected)void this.apply([{type:'set',id:this.selected.id,path:'/properties/'+key,value}]);}
    /** Store display toggles separately from sampled geometry. */
    measurement(key: keyof DrawingMeasurements, checked: boolean): void { this.setMeasurements({[key]:checked}); }
    setMeasurements(value: Partial<DrawingMeasurements>): void {this.setAuthor({measurements:{...this.measurements,...value}});}
    /** Imported geometry requires a deliberate space choice before authoring flags. */
    setAuthor(value: Partial<DrawingAuthoring>): void {if(this.selected)void this.apply([{type:'author',id:this.selected.id,value}]);}
    /** Tree segment selection is a source address, never a free-form numeric segment field. */
    segment(value: {path:string;index:number}): void {this.selectedSegment=value.path === '/erdblick:drawing/points' ? value.index : undefined; if(this.selected)void this.documents.selectObject(this.mapId,this.selected.id,`${value.path}/${value.index}`);}
    /** Let the native evaluator create or remove controls using the object's interpolation. */
    curve(enabled: boolean): void {if(this.selected && this.selectedSegment !== undefined)void this.apply([{type:'curve',id:this.selected.id,index:this.selectedSegment,enabled}]);}
    /** Arrow navigation moves tree focus; Enter enters a leaf's ordinary editing control. */
    treeKey(event:KeyboardEvent):void {
        const target=event.target as HTMLElement,tree=event.currentTarget as HTMLElement,node=target.closest<HTMLElement>('[role="treeitem"]');
        if(!node)return;
        if(target.matches('input,textarea,[role="combobox"]')){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();node.focus();}return;}
        if(target.matches('button')&&!target.classList.contains('tree-toggle'))return;
        const nodes=Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(item=>item.offsetParent!==null),index=nodes.indexOf(node);
        const toggle=node.querySelector<HTMLButtonElement>(':scope > .tree-toggle');
        let next:HTMLElement|undefined;
        if(event.key==='ArrowDown')next=nodes[Math.min(nodes.length-1,index+1)];
        else if(event.key==='ArrowUp')next=nodes[Math.max(0,index-1)];
        else if(event.key==='Home')next=nodes[0];
        else if(event.key==='End')next=nodes.at(-1);
        else if(event.key==='ArrowRight'){if(toggle&&node.getAttribute('aria-expanded')==='false')toggle.click();else next=node.querySelector<HTMLElement>('[role="treeitem"]')??undefined;}
        else if(event.key==='ArrowLeft'){if(toggle&&node.getAttribute('aria-expanded')==='true')toggle.click();else next=node.parentElement?.closest<HTMLElement>('[role="treeitem"]')??undefined;}
        else if(event.key==='Enter'||event.key===' '){if(toggle)toggle.click();else next=node.querySelector<HTMLElement>('input,button')??undefined;}
        else return;
        event.preventDefault();event.stopPropagation();next?.focus();
    }
    /** One navigation tab stop; focus and hover never mutate the selected object or source. */
    treeFocus(event:FocusEvent):void {
        const tree=event.currentTarget as HTMLElement,target=event.target as HTMLElement,node=target.closest<HTMLElement>('[role="treeitem"]');
        for(const item of tree.querySelectorAll<HTMLElement>('[role="treeitem"],input'))item.tabIndex=item===node||item===target&&target.matches('input')?0:-1;
    }
    /** Retire pending reads and hover presentation on editor teardown. */
    ngOnDestroy(): void {++this.serial;this.hover.emit(undefined);this.subscription.unsubscribe();}
}
