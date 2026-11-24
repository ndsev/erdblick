import {InspectionSelectionService} from '../inspection/inspection-selection.service';
import {drawingActions, drawingPositionSchema} from './drawing-action.util';
import {z} from 'zod';
import type {AppActionContributor, AppActionRegistration} from '../action/action-contributor.model';
import {Injectable, OnDestroy, Optional} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {coreLib} from '../integrations/wasm.adapter';
import {MapViewService, ViewRecalculationReason} from '../mapview/mapview.service';
import {MapViewState} from '../mapview/mapview.state';
import {DrawingDocumentsService} from './drawing-documents.service';
import {VirtualSourceService} from './virtual-source.service';
import {DrawingState} from './drawing.state';
import {EMPTY_DRAWING, DrawingPosition, DrawingAuthoring, DrawingPlane, DrawingObject, DrawingObjectEdit, recognizedDrawingAuthoring} from './drawing.model';

export type DrawingTool = 'select' | 'polyline' | 'distance' | 'area' | 'angle' | 'pen' | 'point' | 'polygon' | 'ellipse' | 'annotation';

/** One tool owns map clicks at a time, bound to a stable view identity. */
@Injectable({providedIn: 'root'})
export class DrawingToolsService implements OnDestroy, AppActionContributor {
    readonly changed = new Subject<void>();
    visible = false;
    active = false;
    clearing = false;
    viewId = '';
    points: DrawingPosition[] = [];
    cursor?: DrawingPosition;
    totalMeters = 0;
    tailMeters = 0;
    private readonly errors = {input: '', document: '', preview: ''};
    get error(): string { return this.errors.document || this.errors.preview || this.errors.input; }
    mode: DrawingTool = 'polyline';
    color = '#ff8a24';
    space: '2d' | '3d' = '2d';
    elevation = 0;
    snapGeometry = false;
    snapPoints = true;
    snapSegments = true;
    snapTolerance = 10;
    private starting?: Promise<void>;
    private transition?: Promise<void>;
    get preparing(): boolean { return !!this.starting || !!this.transition; }
    annotation = '';
    annotationPrompt = false;
    planeMethod: 'horizontal' | 'through' = 'through';
    projectSnapToPlane = false;
    snapTarget = '';
    private colorTimer?: ReturnType<typeof setTimeout>;
    private colorPending?:{mapId:string;id:string;color:string;revision:number};
    private colorWork?:Promise<void>;
    plane?: DrawingPlane;
    editing?: {mapId: string; object: DrawingObject};
    handles: {path: string; position: DrawingPosition}[] = [];
    private editingRefresh?: Promise<void>;
    private editGesture?: {path: string; start: DrawingPosition; position: DrawingPosition; revision: number; placement?: boolean};
    private focusedHandlePath='';
    definingPlane = false;
    private planePoints: DrawingPosition[] = [];
    private objectId?: string;
    private objectIdentity: string = crypto.randomUUID();
    shift = false;
    areaSquareMeters: number | null = null;
    angleDegrees: number | null = null;
    perimeterMeters = 0;
    private rawCursor?: DrawingPosition;
    private dragging = false;
    private committedId?: string;
    private previewId?: string;
    private queue = Promise.resolve();
    private previewQueue = Promise.resolve();
    private committedPending?: {text: string; generation: number};
    private previewPending?: {text: string; generation: number};
    private committedFlushing = false;
    private previewFlushing = false;
    private committedText = '';
    private previewText = '';
    private generation = 0;
    private closing?: Promise<void>;
    private clearingTask?: Promise<void>;
    private frame?: number;
    private readonly subscriptions = new Subscription();

    /** Install semantic input hooks without coupling Deck to an Angular document owner. */
    constructor(public readonly state: DrawingState, private readonly sources: VirtualSourceService,
                private readonly docs: DrawingDocumentsService, private readonly views: MapViewService,
                private readonly viewState: MapViewState, @Optional() private readonly inspection?: InspectionSelectionService) {
        this.subscriptions.add(this.changed.subscribe(() => views.drawingChanged.next()));
        views.drawingInput = {
            configuration: viewId => viewId === this.viewId && this.compatibleView ? {active: this.active || !!this.editing, placing: this.active, snap: this.snapGeometry,
                snapPoints: this.snapPoints, snapSegments: this.snapSegments, tolerance: this.snapTolerance,
                projectSnapToPlane:this.projectSnapToPlane,editedPosition:this.editGesture?.start,constrain:this.shift ? point=>this.snapped(point) : undefined,
                excludeFeatureId: this.editing?.object.id ? 'DrawingFeature.' + this.editing.object.id : undefined,
                excludeMapId: this.editing?.mapId, previewMapId: this.previewId,
                elevation: this.elevation, plane: this.definingPlane ? undefined : this.plane, handles: this.handles} : undefined,
            diagnostic: message => this.docs.notify('snap', message),
            snapTarget: target=>{if(this.snapTarget!==target){this.snapTarget=target;this.changed.next();}},
            select: (viewId,targets,position)=>this.selectPicked(viewId,targets,position),
            click: (viewId, point, shift) => this.click(viewId, point, shift),
            move: (viewId, point, shift) => this.move(viewId, point, shift),
            down: (viewId, point, shift, handle) => this.down(viewId, point, shift, handle),
            up: (viewId, point) => this.up(viewId, point),
            cancel: () => this.cancelGesture(),
            leave: viewId => { if (viewId === this.viewId) this.move(viewId, undefined); }
        };
        this.subscriptions.add(viewState.viewIdsState.subscribe(ids => {
            if (this.viewId && !ids.includes(this.viewId)) { this.finish(); this.docs.notify('view', 'The drawing view closed. Rebind the tray to a compatible view to continue.'); }
            const previewView = this.viewId;
            if (this.previewId && ids.includes(previewView) && sources.sources.has(this.previewId)) this.restrictView(this.previewId, previewView);
        }));
        this.subscriptions.add(sources.recovered.subscribe(id => {
            if (id === this.previewId) this.restrictView(id, this.viewId);
            if (id === this.editing?.mapId) { this.cancelGesture(); this.editing = undefined; this.handles = []; this.docs.notify('drag', 'Drawing recovered. Select the object again before dragging.'); }
        }));
        this.subscriptions.add(views.viewStateChanged.subscribe(reason => {
            if (reason !== ViewRecalculationReason.Viewport) return;
            if (this.active && !this.compatibleView) { this.finish(); this.docs.notify('view', 'Drawing paused: its authoring space differs from this view. Switch back to resume.'); }
            else if(this.compatibleView)this.docs.notify('view','');
            this.changed.next();
        }));
        this.subscriptions.add(docs.changed.subscribe(() => {
            if (this.editing && (!docs.documents.has(this.editing.mapId) || docs.activeId !== this.editing.mapId)) { this.cancelGesture(); this.editing = undefined; this.handles = []; }
            if (this.editing && !this.editGesture && this.sources.sources.get(this.editing.mapId)?.summary.revision !== this.editing.object.revision) void this.refreshEditing();
            if (!docs.trayVisible) this.highlight('');
        }));
        this.subscriptions.add(state.unit.subscribe(() => {
            if (this.points.length) { this.publishCommitted(); this.publishPreview(); }
            this.changed.next();
        }));
    }

    /** Select local geometry from the map through the same workspace target as the tray. */
    private async selectPicked(viewId:string, targets:{mapTileKey:string;featureId:string}[], position?:DrawingPosition):Promise<boolean>{
        if(!this.visible||this.mode!=='select'||viewId!==this.viewId)return false;
        for(const target of targets){
            const mapId=coreLib.parseMapPartitionKey(target.mapTileKey)[0];
            if(!this.docs.documents.has(mapId)||!target.featureId.startsWith('DrawingFeature.'))continue;
            const id=target.featureId.slice('DrawingFeature.'.length).split(':')[0];
            try{
                if(!this.docs.workingIds.includes(mapId))this.docs.openTray([...this.docs.workingIds,mapId]);
                await this.editTarget(mapId,id);
                const author=this.editing?.object.feature['erdblick:drawing'];
                if(position&&author?.kind==='polyline'){
                    const segment=JSON.parse(coreLib.drawingEvaluate(JSON.stringify({action:'segment',authoring:author,position})));
                    await this.docs.selectObject(mapId,id,'/erdblick:drawing/points/'+segment.index);
                }
            }catch(error){this.docs.notify('edit',String(error));}
            return true;
        }
        return false;
    }
    /** Refuse oversized handle transfers; Quick stays available for the complete paged geometry. */
    async editTarget(mapId:string,id:string):Promise<void>{
        const branch=await this.sources.branch(mapId,{id,count:1});
        if(branch.row?.space==='3d'&&branch.row.heightState!=='present'){await this.docs.selectObject(mapId,id);await this.docs.open(mapId);this.docs.notify('height','Assign missing ellipsoidal heights in Quick before editing in 3D.');return;}
        if((branch.controlCount||branch.row?.vertexCount||0)>10000){this.docs.notify('handles','This object has more than 10,000 handles. Select a coordinate in the paged Quick editor.');this.docs.open(mapId);return;}
        await this.editObject(mapId,(await this.sources.branch(mapId,{id,revision:branch.revision,editing:true,count:1})).object!);
    }
    /** Bind a bounded object's control handles to its captured compatible view. */
    async editObject(mapId: string, object: DrawingObject): Promise<void> {
        this.focusedHandlePath='';
        const author = recognizedDrawingAuthoring(object.feature['erdblick:drawing']);
        if (!author) { this.docs.open(mapId); this.docs.notify('edit', 'Choose 2D or 3D in Quick before editing imported geometry in the map.'); return; }
        if ((object.feature.geometry as {type?: string})?.type === 'GeometryCollection' && !author.points) this.docs.notify('handles','Choose a part in Quick when handles overlap.');
        await this.pause(); await this.docs.selectObject(mapId,object.id);
        this.mode = 'select';
        this.editing = {mapId, object}; this.visible = true; this.docs.trayVisible = true;
        const doc = this.docs.documents.get(mapId);
        if(doc)doc.stopInput=()=>this.pause();
        this.viewId = doc?.viewId || this.viewState.viewIdAt(this.viewState.focusedView);
        this.space = author.space;
        const color=object.feature.properties?.['color'];if(typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color))this.color=color;
        this.plane = this.space === '3d' ? author?.plane : undefined;
        this.restoreHandles();
        this.docs.notify('view',this.compatibleView?'':'Switch to a matching 2D/3D view to edit this object.');
    }
    /** Refresh handles after Quick/MCP/history edits; deleted objects cannot retain drag targets. */
    private refreshEditing(): Promise<void> {
        if (this.editingRefresh) return this.editingRefresh;
        const editing = this.editing;
        if (!editing) return Promise.resolve();
        return this.editingRefresh = (async () => {
            try {
                const object = (await this.sources.branch(editing.mapId, {id:editing.object.id,editing:true,count:1})).object!;
                if (this.editing !== editing || this.editGesture) return;
                this.editing = {...editing, object}; this.restoreHandles();
            } catch {
                if (this.editing === editing) { this.editing = undefined; this.handles = []; this.highlight(''); }
            } finally { this.editingRefresh = undefined; this.changed.next(); }
        })();
    }
    private restoreHandles(): void {
        this.handles = [];
        const feature = this.editing?.object.feature, author = recognizedDrawingAuthoring(feature?.['erdblick:drawing']);
        let limited = false;
        const collect = (value: unknown, path: string) => {
            if (this.handles.length >= 10000) { limited = true; return; }
            if (Array.isArray(value)) {
                if (value.length >= 2 && value.every(item => typeof item === 'number')) {
                    this.handles.push({path, position: value as DrawingPosition}); return;
                }
                const closed = value.length >= 4 && JSON.stringify(value[0]) === JSON.stringify(value.at(-1));
                value.forEach((child, index) => { if (!closed || index !== value.length - 1) collect(child, path + '/' + index); });
            } else if (value && typeof value === 'object') {
                for (const [key, child] of Object.entries(value)) if (key === 'coordinates' || key === 'geometries') collect(child, path + '/' + key);
            }
        };
        if (author?.points) {
            collect(author.points, '/erdblick:drawing/points');
            for (const [segment, controls] of Object.entries(author.curves ?? {})) collect(controls, '/erdblick:drawing/curves/' + segment);
        } else collect(feature?.geometry, '/geometry');
        this.docs.notify('handles', limited ? 'Only the first 10,000 edit handles are shown. All coordinates remain editable in Quick or Advanced.' : '');
        this.changed.next();
    }
    cancelGesture(): void {
        if (this.definingPlane) { this.definingPlane=false; this.planePoints=[]; this.restoreHandles(); this.finish(); return; }
        if (this.annotationPrompt) { void this.clear(); this.annotationPrompt=false; return; }
        this.editGesture = undefined; this.dragging = false; this.restoreHandles(); this.finish();
        if(this.editing&&this.sources.sources.get(this.editing.mapId)?.summary.revision!==this.editing.object.revision)void this.refreshEditing();
    }
    get viewBounds(): DOMRect | undefined { return this.views.drawingViewBounds.get(this.viewId)?.(); }
    get controlsOnLeft():boolean{return this.viewState.viewIds.length>1&&this.viewState.viewIds[0]===this.viewId;}

    private hoverTarget?: {mapTileKey: string; featureId: string};
    highlight(mapId: string, id?: string): void {
        const current = this.inspection?.hoverIdsTopic?.getValue();
        if (!id) {
            if (this.hoverTarget && current?.length === 1 && current[0].mapTileKey === this.hoverTarget.mapTileKey && current[0].featureId === this.hoverTarget.featureId) this.inspection?.setHoveredFeatures([]);
            this.hoverTarget = undefined; return;
        }
        this.hoverTarget = {mapTileKey:coreLib.createMapTileKey('Features',mapId,'Drawing','object/0'),featureId:'DrawingFeature.'+id};
        this.inspection?.setHoveredFeatures([this.hoverTarget]);
    }
    async fitObject(mapId: string, id: string, viewId: string): Promise<void> {
        const targetView=this.viewState.viewIds.indexOf(viewId); if(targetView<0)throw new Error('Drawing view no longer exists.');
        const object=(await this.sources.branch(mapId,{id,count:1})).object!, presentation=object.presentation;
        if (presentation?.projectionLimited) this.docs.notify('projection','Polar coordinates are preserved. Fit shows the part within the Web Mercator latitude limit.');
        if (!presentation?.bounds) throw new Error('This object has no geographic extent.');
        const [west,rawSouth,east,rawNorth]=presentation.bounds;
        const south=Math.max(-85.0511287798066,rawSouth), north=Math.min(85.0511287798066,rawNorth);
        if (south>north) throw new Error('The complete object lies beyond the Web Mercator viewing limit. Its source coordinates remain available in Quick.');
        this.views.moveToRectangleTopic.next({targetView,rectangle:{west,south,east,north}});
    }
    registerActions(actions: AppActionRegistration): void {
        actions = drawingActions(actions);
        actions.registerAction({name:'viewer_drawing_presentation',description:'Select handles, highlight or fit an object in an explicit view; show or collapse the Objects tray.',mutation:true,
            inputSchema:z.strictObject({action:z.enum(['select','highlight','fit','show','collapse']),viewId:z.string(),mapId:z.string().optional(),objectId:z.string().optional()}),outputSchema:z.object({viewId:z.string(),activeId:z.string()})},async input=>{
                if(!this.viewState.viewIds.includes(input.viewId))throw new Error('Drawing view no longer exists.');
                if(['select','highlight','fit'].includes(input.action)) {
                    if(!input.mapId||!input.objectId)throw new Error('Document and object identity are required.');
                    const object=(await this.sources.branch(input.mapId,{id:input.objectId,count:1})).object!;
                    if(input.action==='select'){this.docs.openTray([input.mapId]); const doc=this.docs.documents.get(input.mapId)!; doc.viewId=input.viewId;await this.editTarget(input.mapId,object.id);}
                    if(input.action==='highlight')this.highlight(input.mapId,input.objectId);
                    if(input.action==='fit')await this.fitObject(input.mapId,input.objectId,input.viewId);
                } else {this.docs.trayVisible=input.action==='show';this.visible=true;this.state.trayCollapsed.next(input.action==='collapse');if(input.action==='collapse')this.highlight('');}
                this.changed.next(); return {viewId:input.viewId,activeId:this.docs.activeId};
            });
        actions.registerAction({name: 'viewer_drawing_tool', description: 'Configure/start/finish the view-bound drawing tool, geometry snapping and working elevation. Shift remains angle snapping. Use viewer_drawing_edit for programmatic geometry.', mutation: true,
            inputSchema: z.strictObject({action: z.enum(['start', 'finish', 'configure', 'rebind']), mode: z.enum(['select','polyline','distance','area','angle','pen','point','polygon','ellipse','annotation']).optional(),
                viewId:z.string().optional(), unit:z.enum(['meters','miles']).optional(), snapPoints:z.boolean().optional(), snapSegments:z.boolean().optional(), tolerance:z.number().min(2).max(30).optional(),
                plane:z.discriminatedUnion('method',[z.object({method:z.literal('horizontal'),origin:drawingPositionSchema}),z.object({method:z.literal('through'),positions:z.array(drawingPositionSchema).length(3)})]).optional(),
                snap: z.boolean().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), elevation: z.number().finite().optional(), annotation: z.string().max(4096).optional()}),
            outputSchema: z.object({viewId: z.string(), space: z.enum(['2d','3d']), active: z.boolean(), snap: z.boolean()})}, async input => {
                const target=input.viewId??this.viewId;
                if((input.action==='start'||input.action==='rebind')&&!this.viewState.viewIds.includes(target))throw new Error('Specify an existing viewId.');
                if(input.viewId&&this.viewId&&input.viewId!==this.viewId&&input.action!=='rebind')throw new Error('The drawing belongs to a different view. Rebind explicitly.');
                const space=this.viewId?this.space:this.viewState.mode2dState.getValue(target)?'2d':'3d';
                if(input.action==='rebind'&&(this.viewState.mode2dState.getValue(target)?'2d':'3d')!==space)throw new Error('Incompatible authoring space.');
                if(input.mode&&this.points.length&&!this.completeShape)throw new Error('Finish or clear the incomplete object before switching tools.');
                // Validate every fallible composite field before changing configuration or starting input.
                let plane:DrawingPlane|undefined;
                if(input.plane){
                    if(space!=='3d')throw new Error('A physical plane requires 3D authoring space.');
                    plane=JSON.parse(coreLib.drawingPlane(JSON.stringify(input.plane.method==='through'?{action:'through',points:input.plane.positions}:{action:'horizontal',origin:input.plane.origin})));
                }
                if(input.viewId){this.viewId=target;this.space=space;}
                if(input.mode)await this.select(input.mode);
                if(plane)this.plane=plane;
                if(input.unit)this.state.unit.next(input.unit);
                if(input.snapPoints!==undefined)this.snapPoints=input.snapPoints;
                if(input.snapSegments!==undefined)this.snapSegments=input.snapSegments;
                if(input.tolerance!==undefined)this.snapTolerance=input.tolerance;
                if (input.snap !== undefined) this.snapGeometry = input.snap;
                if (input.color) this.setColor(input.color);
                if (input.elevation !== undefined) this.elevation = input.elevation;
                if (input.annotation !== undefined) this.annotation = input.annotation;
                if (input.action === 'start') this.start();
                if (input.action === 'finish') await this.pause();
                if (input.action === 'rebind') this.start();
                this.changed.next(); return {viewId: this.viewId, space: this.space, active: this.active, snap: this.snapGeometry};
            });
    }

    /** Fixed-point tools must be undone or restarted before accepting another position. */
    get canResume(): boolean {
        return this.mode !== 'select' && this.compatibleView && (!(this.mode === 'point' || this.mode === 'annotation') || this.points.length < 1) && (this.mode !== 'angle' || this.points.length < 3) && (this.mode !== 'ellipse' || this.points.length < 2);
    }

    /** Open the palette and resume incomplete input in its captured view. */
    start(): void {
        if (this.clearing) return;
        this.visible = true; this.docs.trayVisible = true;
        if (!this.viewId) { this.viewId = this.viewState.viewIdAt(this.viewState.focusedView); this.space = this.viewState.mode2dState.getValue(this.viewId) ? '2d' : '3d'; }
        this.active = this.canResume;
        if(this.compatibleView)this.docs.notify('view','');
        this.errors.input = '';
        void this.ensureDocument().then(() => this.recoverPending()).catch(error => this.fail(error));
        this.changed.next();
    }
    private ensureDocument(): Promise<void> {
        if (this.committedId && this.docs.documents.has(this.committedId)) return Promise.resolve();
        return this.starting ??= (async () => {
            let doc = this.docs.documents.get(this.docs.activeId);
            if (!doc || !this.docs.workingIds.includes(doc.mapId)) {
                doc = await this.docs.create('geojson', 'Untitled drawing', EMPTY_DRAWING, false, {openEditor: false});
                this.docs.openTray([doc.mapId]);
            }
            this.committedId = doc.mapId; doc.viewId = this.viewId; doc.stopInput = () => this.releaseDocumentInput(); this.restrictView(doc.mapId);
        })().finally(() => { this.starting = undefined; this.changed.next(); });
    }
    private recoverPending(): void {
        const pending = this.docs.documents.get(this.committedId ?? '')?.pendingObject;
        if (!pending || this.points.length) return;
        this.mode = pending.mode; this.color = pending.color; this.objectIdentity = pending.identity;
        const author = pending.authoring as unknown as DrawingAuthoring;
        this.points = (author.points ?? []).map(point => [...point]); this.space = author.space;
        this.plane = author.plane; this.annotation = author.text ?? '';
        this.annotationPrompt=this.mode==='annotation';
        this.active = this.compatibleView && !this.annotationPrompt; this.recalculate(); this.changed.next();
    }
    private async persistPending(): Promise<void> {
        await this.ensureDocument(); const doc = this.docs.documents.get(this.committedId ?? '');
        if (!doc) return;
        doc.pendingObject = this.mode !== 'select' && this.points.length && !this.completeShape ? {mode: this.mode, color: this.color, identity: this.objectIdentity, authoring: this.authoring() as unknown as NonNullable<typeof doc.pendingObject>['authoring']} : undefined;
        this.docs.persist(doc);
    }

    /** A tool switch retains finished objects in the same working document. */
    select(mode: DrawingTool): Promise<void> {
        return this.transition ??= this.selectMode(mode).finally(()=>{this.transition=undefined;this.changed.next();});
    }
    /** Serialize asynchronous tool changes so pending source creation cannot swallow the next gesture. */
    private async selectMode(mode: DrawingTool): Promise<void> {
        if (this.clearing) return;
        if (mode === this.mode && this.active) return;
        if (this.points.length && !this.completeShape) { this.docs.notify('incomplete', 'Finish or clear the incomplete object before switching tools.'); return; }
        await this.pause();
        if (mode === 'select') {
            this.mode=mode; this.active=false;
            if(!this.viewId){this.viewId=this.viewState.viewIdAt(this.viewState.focusedView);this.space=this.viewState.mode2dState.getValue(this.viewId)?'2d':'3d';}
            if (this.docs.selectedObjectId) await this.editTarget(this.docs.activeId,this.docs.selectedObjectId);
            this.changed.next(); return;
        }
        await this.newDrawing(mode);
    }
    /** Start another result of the selected kind without removing the previous source. */
    async newDrawing(mode = this.mode): Promise<void> {
        this.finish(); await this.starting; await this.queue;
        const old = this.docs.documents.get(this.committedId ?? '');
        if (old?.pendingObject) { this.docs.notify('incomplete', 'Finish or clear the incomplete object before starting another.'); return; }
        this.mode = mode === 'select' ? 'polyline' : mode;
        this.annotation=''; this.annotationPrompt=false;
        this.editing = undefined; this.handles = []; this.committedId = this.docs.activeId || undefined;
        this.objectId = undefined; this.objectIdentity = crypto.randomUUID(); this.committedText = '';
        this.points = []; this.cursor = undefined; this.rawCursor = undefined; this.plane = undefined;
        if(this.viewState.viewIds.includes(this.viewId))this.space=this.viewState.mode2dState.getValue(this.viewId)?'2d':'3d';
        this.totalMeters = 0; this.tailMeters = 0; this.areaSquareMeters = 0; this.perimeterMeters = 0; this.angleDegrees = 0;
        this.start();
    }
    get compatibleView(): boolean { return !this.viewId || !this.views.renderViewFor?.(this.viewId)?.isFirstPersonViewActive() && (this.viewState.mode2dState.getValue(this.viewId) ? '2d' : '3d') === this.space; }
    rebind(): void {
        const target = this.viewState.viewIdAt(this.viewState.focusedView);
        if ((this.viewState.mode2dState.getValue(target) ? '2d' : '3d') !== this.space) { this.docs.notify('view', 'Choose a view matching the object’s authoring space.'); return; }
        this.viewId = target; this.docs.notify('view', ''); this.start();
    }
    async pause(): Promise<void> { this.finish(); await this.flushColor(); await this.starting; await this.clearingTask; await this.queue; await this.previewQueue; }
    private async releaseDocumentInput(): Promise<void> {
        await this.pause();
        const doc = this.docs.documents.get(this.committedId ?? ''); if (doc) doc.stopInput = undefined;
        this.committedId = undefined; this.objectId = undefined; this.points = []; this.cursor = undefined;
        this.committedText = ''; this.totalMeters = 0; this.changed.next();
    }
    beginPlane(method: 'horizontal' | 'through' = 'through'): void {
        if (this.space !== '3d') return;
        this.finish(); this.planeMethod=method; this.definingPlane = true; this.planePoints = []; this.active = true; this.changed.next();
    }
    get selectedHandle(){return this.editing&&this.handles.find(handle=>handle.path===this.docs.selectedPath);}
    get canDeleteFocusedVertex():boolean{return !!this.selectedHandle&&this.focusedHandlePath===this.docs.selectedPath;}
    get placingVertex():boolean{return !!this.editGesture?.placement;}
    /** Select then click a destination offers the same validated edit without dragging. */
    placeSelectedVertex():void{
        const handle=this.selectedHandle;
        if(!handle||!this.editing||!this.compatibleView)return;
        this.editGesture={path:handle.path,start:handle.position,position:handle.position,revision:this.editing.object.revision,placement:true};
        this.changed.next();
    }
    /** Delete only the selected coordinate; native validation preserves minimum sizes and closure. */
    async deleteSelectedVertex():Promise<void>{
        const handle=this.selectedHandle,editing=this.editing;if(!handle||!editing)return;
        const doc=this.docs.documents.get(editing.mapId);if(!doc)return;
        const match=handle.path.match(/^(.*)\/(\d+)$/),curve=handle.path.match(/^\/erdblick:drawing\/curves\/(\d+)\//);
        const operation:DrawingObjectEdit=curve?{type:'curve',id:editing.object.id,index:+curve[1],enabled:false}:match?{type:'deleteVertex',id:editing.object.id,path:match[1],index:+match[2]}:{type:'delete',id:editing.object.id};
        try{await this.docs.objectEdit(doc,[operation],editing.object.revision);}
        catch(error){this.docs.notify('edit',String(error));}
    }
    /** Store an explicitly selected plane on an existing object; validation never moves its vertices. */
    private async applyEditingPlane(plane:DrawingPlane):Promise<void>{
        const editing=this.editing,doc=editing&&this.docs.documents.get(editing.mapId);if(!editing||!doc)return;
        this.active=false;
        try{await this.docs.objectEdit(doc,[{type:'author',id:editing.object.id,value:{plane}}],editing.object.revision);await this.editTarget(editing.mapId,editing.object.id);}
        catch(error){this.plane=recognizedDrawingAuthoring(editing.object.feature['erdblick:drawing'])?.plane;this.restoreHandles();this.docs.notify('plane',String(error));}
    }
    get planePrompt(): string { return ['Choose plane origin', 'Choose second plane anchor', 'Choose third plane anchor'][this.planePoints.length] ?? 'Choose plane origin'; }
    get planeAnchorCount(): number { return this.planePoints.length; }
    /** Remove only the last setup anchor, leaving the previous working plane intact. */
    undoPlaneAnchor(): void { this.planePoints.pop(); this.showPlaneAnchors(); }
    /** Temporary anchor handles explain setup without adding document objects. */
    private showPlaneAnchors(): void {
        this.handles=this.planePoints.map((position,index)=>({path:'plane-anchor/'+index,position}));
        this.changed.next();
    }
    get measurements() { return this.editing?.object.feature['erdblick:drawing']?.measurements ?? this.authoring().measurements ?? {}; }
    private authoring(points = this.points): DrawingAuthoring {
        const kind = this.mode === 'distance' || this.mode === 'angle' || this.mode === 'pen' || this.mode === 'select' ? 'polyline' : this.mode === 'area' ? 'polygon' : this.mode;
        return {version: 1, kind, space: this.space, points, plane: this.plane, unit: this.state.unit.value,
            ...(kind === 'annotation' ? {text: this.annotation} : {}),
            measurements: {distances: this.mode === 'distance', angles: this.mode === 'angle', area: this.mode === 'area', perimeter: this.mode === 'area'}};
    }
    private get completeShape(): boolean { return (this.mode !== 'annotation' || (!this.annotationPrompt && !!this.annotation.trim())) && this.points.length >= (this.mode === 'point' || this.mode === 'annotation' ? 1 : this.mode === 'area' || this.mode === 'polygon' ? 3 : 2); }
    /** Style is stored with generated GeoJSON so exported drawings retain the chosen color. */
    setColor(color: string): void {
        if (!/^#[0-9a-f]{6}$/i.test(color)) return;
        this.color = color;
        if (this.mode === 'select' && this.docs.selectedObjectId) {
            const mapId=this.docs.activeId,id=this.docs.selectedObjectId,revision=this.sources.sources.get(mapId)?.summary.revision;
            clearTimeout(this.colorTimer);
            if(revision!==undefined)this.colorPending={mapId,id,color,revision};
            this.colorTimer=setTimeout(()=>void this.flushColor(),180);
        } else this.publishCommitted();
        this.publishPreview(); this.changed.next();
    }
    /** Flush a picker gesture as one history edit before Save, Close or target changes. */
    private async flushColor():Promise<void>{
        clearTimeout(this.colorTimer);
        const pending=this.colorPending;this.colorPending=undefined;
        await this.colorWork;
        if(!pending)return;
        const doc=this.docs.documents.get(pending.mapId);if(!doc)return;
        this.colorWork=this.docs.objectEdit(doc,[{type:'set',id:pending.id,path:'/properties/color',value:pending.color}],pending.revision,true).catch(error=>this.docs.notify('color',String(error)));
        await this.colorWork;this.colorWork=undefined;
    }
    /** Reproject a stationary cursor immediately when the Shift key changes. */
    setShift(shift: boolean): void { this.shift = shift; this.move(this.viewId, this.rawCursor, shift); this.changed.next(); }
    /** Losing window focus clears snapping and finishes only an in-flight pen stroke. */
    blur(): void { this.setShift(false); if (this.dragging) this.finish(); }
    private snapped(point: DrawingPosition): DrawingPosition {
        const origin = this.editGesture?.start ?? this.points.at(-1);
        if (this.shift && origin && this.plane) {
            return JSON.parse(coreLib.drawingPlane(JSON.stringify({action:'snap',plane:this.plane,origin,position:point})));
        }
        return this.shift && origin ? ([...JSON.parse(coreLib.drawingSnap(origin[0], origin[1], point[0], point[1])), ...(this.space === '3d' ? [point[2] ?? this.elevation] : [])] as DrawingPosition) : point;
    }
    /** A 2D drag changes horizontal coordinates without discarding imported altitude. */
    private dragPosition(point: DrawingPosition, start: DrawingPosition): DrawingPosition {
        return this.space === '2d' ? (start[2] !== undefined ? [point[0], point[1], start[2]] : [point[0], point[1]]) : point;
    }
    /** Freehand strokes capture the pointer while ordinary tools leave map navigation available. */
    private down(viewId: string, point: DrawingPosition, shift = false, handle?: string): boolean {
        if(this.editGesture?.placement&&viewId===this.viewId&&this.compatibleView){this.move(viewId,point,shift);return true;}
        if (this.editing && handle && viewId === this.viewId && this.compatibleView) {
            const value = this.handles.find(item => item.path === handle)!;
            this.editGesture = {path: handle, start: value.position, position: value.position, revision: this.editing.object.revision};
            return true;
        }
        if (!this.active || this.clearing || this.viewId !== viewId || this.mode !== 'pen') return false;
        this.shift = shift; this.dragging = true; this.appendPoint(this.snapped(point)); return true;
    }
    private up(viewId: string, point?: DrawingPosition): void {
        if (viewId === this.viewId && this.editGesture && this.editing) {
            const gesture = this.editGesture, editing = this.editing; this.editGesture = undefined; this.publishPreview();
            const doc = this.docs.documents.get(editing.mapId);
            if (gesture.position.every((value,index)=>value===gesture.start[index])) {
                void this.docs.selectObject(editing.mapId,editing.object.id,gesture.path).then(()=>{if(this.editing===editing){this.focusedHandlePath=gesture.path;this.changed.next();}}).catch(error=>this.docs.notify('edit',String(error)));
                this.restoreHandles();return;
            }
            if (doc) void this.docs.objectEdit(doc, [{type: 'set', id: editing.object.id, path: gesture.path, value: gesture.position}], gesture.revision)
                .then(async () => this.editTarget(editing.mapId, editing.object.id))
                .catch(error => { this.docs.notify('drag', String(error)); this.restoreHandles();void this.refreshEditing(); });
            return;
        }
        if (!this.dragging || viewId !== this.viewId) return;
        if (point) this.appendPoint(this.snapped(point));
        this.dragging = false; this.finish();
    }

    /** Consume tool clicks before feature inspection, while preserving unrelated view input. */
    private click(viewId: string, point: DrawingPosition, shift = false): boolean {
        if (!this.active || this.viewId !== viewId) return false;
        if (this.definingPlane) {
            this.planePoints.push(point);
            if (this.planePoints.length === (this.planeMethod === 'horizontal' ? 1 : 3)) {
                try { this.plane = JSON.parse(coreLib.drawingPlane(JSON.stringify(this.planeMethod === 'horizontal' ? {action:'horizontal',origin:point} : {action: 'through', points: this.planePoints}))); this.definingPlane = false; this.planePoints=[]; this.docs.notify('plane','');if(this.editing)void this.applyEditingPlane(this.plane!); }
                catch (error) { this.docs.notify('plane', String(error)); this.planePoints = []; }
            }
            this.showPlaneAnchors(); return true;
        }
        if (this.clearing || this.mode === 'pen') return true;
        this.shift = shift;
        if (this.space === '3d' && ['area','polygon','ellipse'].includes(this.mode) && !this.plane) {this.docs.notify('plane','Choose Horizontal plane or Three-anchor plane in Drawing options before placing a 3D shape.');return true;}
        this.appendPoint(this.snapped(point));
        if (this.mode === 'annotation') this.annotationPrompt=true;
        if ((this.mode === 'point' || this.mode === 'annotation') || (this.mode === 'angle' && this.points.length === 3) || (this.mode === 'ellipse' && this.points.length === 2)) this.finish();
        return true;
    }

    private appendPoint(point: DrawingPosition): void {
        if (this.points.length >= 10000) { this.errors.input = 'Drawing is limited to 10,000 positions.'; this.docs.notify('input', this.errors.input); this.changed.next(); return; }
        if (!this.compatibleView) { this.finish(); return; }
        point = this.space === '3d' ? [point[0], point[1], point[2] ?? this.elevation] : [point[0], point[1]];
        if (this.space === '3d' && ['area', 'polygon', 'ellipse'].includes(this.mode)) {
            if (!this.plane) { this.docs.notify('plane','Choose a working plane before placing a 3D shape.'); return; }
            const local = JSON.parse(coreLib.drawingPlane(JSON.stringify({action:'local',plane:this.plane,position:point})));
            if (Math.abs(local[2]) > .01) { this.docs.notify('plane','The snapped target is outside the working plane. Enable explicit projection or choose another target.'); return; }
        }
        const previous = this.points.at(-1);
        if (previous && this.distance(previous, point) < 0.001) return;
        if (previous) this.totalMeters += this.distance(previous, point);
        this.points.push(point); this.cursor = point; void this.persistPending().catch(error => this.fail(error));
        this.recalculate(); this.publishCommitted(); this.publishPreview(); this.changed.next();
    }

    /** Place the text only after the user supplies its label; cancelling leaves no placeholder feature. */
    completeAnnotation(text: string): void {
        if (!text.trim()) return;
        this.annotation=text; this.annotationPrompt=false; this.publishCommitted(); void this.persistPending().catch(error=>this.fail(error)); this.finish();
    }
    /** Coalesce pointer work and keep the preview independent of the document worker. */
    private move(viewId: string, point?: DrawingPosition, shift = this.shift): void {
        if (viewId === this.viewId && this.editGesture && point) {
            this.shift=shift;
            point = this.dragPosition(this.snapped(point), this.editGesture.start); this.editGesture.position = point;
            const handle = this.handles.find(item => item.path === this.editGesture!.path); if (handle) handle.position = point;
            this.publishPreview(); this.changed.next(); return;
        }
        if (!this.active || this.viewId !== viewId) return;
        this.shift = shift; this.rawCursor = point;
        this.cursor = point ? this.snapped(point) : undefined;
        if (this.frame === undefined) this.frame = requestAnimationFrame(() => {
            this.frame = undefined;
            if (this.dragging && this.cursor) {
                const previous = this.points.at(-1);
                const index = this.viewState.viewIds.indexOf(this.viewId);
                const threshold = index < 0 ? 1 : this.viewState.getCameraPosition(index).height / Math.max(1, window.innerHeight) * 2;
                if (!previous || this.distance(previous, this.cursor) >= threshold) this.appendPoint(this.cursor);
            }
            this.recalculate(); this.publishPreview(); this.changed.next();
        });
    }
    /** Preview pending text through the native label path without inserting a document object. */
    previewAnnotation(text: string): void {
        this.annotation=text; this.publishPreview(); void this.persistPending().catch(error=>this.fail(error));
    }
    /** Length is incremental; native geodesics supply polygon area and the vertex angle. */
    private recalculate(): void {
        this.tailMeters = this.cursor && this.points.length ? this.distance(this.points.at(-1)!, this.cursor) : 0;
        const points = this.active && this.cursor && this.tailMeters > 0 ? [...this.points, this.cursor] : this.points;
        if (points.length >= (['area','polygon'].includes(this.mode) ? 3 : 2) && !['point','annotation','select'].includes(this.mode)) {
            try {
                const evaluated = JSON.parse(coreLib.drawingEvaluate(JSON.stringify({authoring: this.authoring(points)})));
                const metrics = evaluated.metrics;
                this.totalMeters = metrics.lengthMeters - this.tailMeters;
                this.areaSquareMeters = metrics.areaSquareMeters ?? null; this.perimeterMeters = metrics.perimeterMeters;
                this.angleDegrees = metrics.anglesDegrees.at(-1) ?? null;
                this.docs.notify('metrics', metrics.warning ?? '');
            } catch (error) { this.docs.notify('metrics', String(error)); }
        } else { this.areaSquareMeters=null; this.angleDegrees=null; this.docs.notify('metrics', ''); }
    }

    /** ESC ends input and removes the cursor tail without committing it. */
    finish(): void {
        this.active = false; this.dragging = false; this.cursor = undefined; this.rawCursor = undefined; this.tailMeters = 0;
        this.recalculate(); this.publishPreview(); this.changed.next();
    }
    /** Backspace repeatedly removes the last committed position, including the final one. */
    backspace(): void {
        if (this.definingPlane) { this.undoPlaneAnchor(); return; }
        if (this.clearing) return;
        this.errors.input = '';
        const last = this.points.pop(), previous = this.points.at(-1);
        if (last && previous) this.totalMeters = Math.max(0, this.totalMeters - this.distance(previous, last));
        else this.totalMeters = 0;
        if (this.rawCursor) this.cursor = this.snapped(this.rawCursor);
        this.recalculate();
        void this.persistPending().catch(error => this.fail(error)); this.publishCommitted(); this.publishPreview(); this.changed.next();
    }
    /** Clear committed geometry through the same persistent GeoJSON document. */
    clear(): Promise<void> {
        if (this.closing) return this.closing;
        return this.clearingTask ??= this.clearMeasurement().finally(() => { this.clearingTask = undefined; });
    }
    private async clearMeasurement(): Promise<void> {
        this.dragging = false;
        this.clearing = true;
        ++this.generation;
        this.committedPending = undefined; this.previewPending = undefined;
        await Promise.all([this.starting, this.queue, this.previewQueue]);
        this.points = []; this.cursor = undefined; this.rawCursor = undefined; this.totalMeters = 0; this.tailMeters = 0;
        this.areaSquareMeters = 0; this.angleDegrees = 0; this.perimeterMeters = 0;
        const doc = this.committedId ? this.docs.documents.get(this.committedId) : undefined;
        this.errors.input = ''; this.docs.notify('incomplete', '');
        if (doc) { doc.pendingObject = undefined; this.docs.persist(doc); }
        if (doc && this.objectId) await this.docs.objectEdit(doc, [{type: 'delete', id: this.objectId}], undefined, true)
            .then(() => { this.errors.document = ''; }).catch(error => this.fail(error));
        if (this.previewId) await this.sources.remove(this.previewId)
            .then(() => { this.errors.preview = ''; }).catch(error => this.fail(error, 'preview'));
        this.previewId = undefined; this.committedText = ''; this.previewText = '';
        this.objectId = undefined; this.objectIdentity = crypto.randomUUID();
        this.clearing = false; this.changed.next();
    }
    /** Closing retains the local result and releases only cursor/input ownership. */
    async close(): Promise<void> {
        await this.pause();
        if (!this.docs.requestClose()) { this.finish(); return; }
        return this.closing ??= this.closeMeasurement().finally(() => { this.closing = undefined; });
    }
    private async closeMeasurement(): Promise<void> {
        this.finish(); this.visible = false; this.editing = undefined; this.handles = []; this.changed.next();
        await this.clearingTask;
        this.clearing = true;
        await Promise.all([this.queue, this.previewQueue]);
        ++this.generation;
        const doc = this.committedId ? this.docs.documents.get(this.committedId) : undefined;
        if (doc) doc.stopInput = undefined;
        if (this.previewId) await this.sources.remove(this.previewId).catch(error => this.fail(error, 'preview'));
        this.committedId = undefined; this.previewId = undefined;
        this.committedPending = undefined; this.previewPending = undefined;
        this.committedText = ''; this.previewText = '';
        this.points = []; this.cursor = undefined; this.rawCursor = undefined; this.totalMeters = 0; this.tailMeters = 0;
        this.areaSquareMeters = 0; this.angleDegrees = 0; this.perimeterMeters = 0;
        this.viewId = ''; this.clearing = false; this.errors.input = ''; this.errors.document = ''; this.errors.preview = ''; this.docs.notify('preview', ''); this.changed.next();
    }
    /** Protect a click waiting for its first document or latest native geometry during page exit. */
    get pendingUpdates(): boolean { return !!this.starting || this.committedFlushing || !!this.committedPending || !!this.clearingTask; }

    /** Display unit changes never modify geometry or accumulated meter values. */
    format(meters: number | null | undefined, unit = this.state.unit.value): string {
        if (meters == null || !Number.isFinite(meters)) return 'Unavailable';
        return (unit === 'miles' ? meters / 1609.344 : meters).toLocaleString(undefined,
            {maximumFractionDigits: unit === 'miles' ? 4 : 2}) + (unit === 'miles' ? ' mi' : ' m');
    }
    /** Area follows the configured distance unit squared. */
    formatArea(area: number | null | undefined, unit = this.state.unit.value): string {
        if (area == null || !Number.isFinite(area)) return 'Unavailable';
        const miles = unit === 'miles';
        return (area / (miles ? 1609.344 ** 2 : 1)).toLocaleString(undefined, {maximumFractionDigits: miles ? 4 : 2}) + (miles ? ' mi²' : ' m²');
    }
    /** Accurate inverse geodesic shared with the native measurement path sampler. */
    private distance(a: DrawingPosition, b: DrawingPosition): number {
        if (this.space === '2d') return coreLib.drawingDistance(a[0], a[1], b[0], b[1]);
        return JSON.parse(coreLib.drawingEvaluate(JSON.stringify({authoring: {version: 1, kind: 'polyline', space: '3d', points: [a, b],...(this.plane?{plane:this.plane}:{})}}))).metrics.lengthMeters;
    }
    /** Only transient controls cross the preview lane; the shared evaluator samples the shape. */
    private renderSource(points: DrawingPosition[]): string {
        const last = this.points.at(-1);
        const hasTail = this.cursor && (!last || this.cursor.some((value, index) => value !== (last[index] ?? 0)));
        const complete = hasTail ? [...this.points, this.cursor!] : this.points;
        const minimum = this.mode === 'ellipse' ? 2 : 3;
        const shape = ['polygon','area','ellipse'].includes(this.mode) && complete.length >= minimum;
        return JSON.stringify({points, ...(shape ? {authoring:this.authoring(complete)} : {})});
    }

    /** Serialize click/history mutations, skipping superseded generations after Clear. */
    private publishCommitted(): void {
        if (!this.completeShape && !this.objectId && !this.committedFlushing) return;
        if (this.clearing || (!this.points.length && !this.committedId && !this.committedFlushing)) return;
        const text = JSON.stringify(this.authoring()), generation = this.generation;
        if (text === this.committedText) return;
        this.committedText = text; this.committedPending = {text, generation};
        if (this.committedFlushing) return;
        this.committedFlushing = true;
        this.queue = this.flushCommitted().catch(error => { this.committedText = ''; this.fail(error); })
            .finally(() => { this.committedFlushing = false; });
    }

    /** Keep only the newest queued click/camera revision while a native history rebuild is running. */
    private async flushCommitted(): Promise<void> {
        while (this.committedPending) {
            const {text, generation} = this.committedPending; this.committedPending = undefined;
            if (generation !== this.generation) continue;
            try {
                const authoring: DrawingAuthoring = JSON.parse(text);
                const minimum = ['point', 'annotation'].includes(authoring.kind) ? 1 : authoring.kind === 'polygon' ? 3 : 2;
                if ((authoring.points?.length ?? 0) < minimum) {
                    const doc = this.docs.documents.get(this.committedId ?? '');
                    if (doc && this.objectId) await this.docs.objectEdit(doc, [{type: 'delete', id: this.objectId}], undefined, true);
                    this.objectId = undefined; continue;
                }
                await this.ensureDocument();
                const doc = this.docs.documents.get(this.committedId!)!;
                doc.pendingObject = undefined;
                if (this.objectId) await this.docs.objectEdit(doc, [
                    {type: 'author', id: this.objectId, value: authoring},
                    {type: 'set', id: this.objectId, path: '/properties/color', value: this.color}
                ], undefined, true);
                else {
                    await this.docs.objectEdit(doc, [{type: 'insert', feature: {type: 'Feature', geometry: null,
                        properties: {color: this.color, name: authoring.kind === 'annotation' ? this.annotation : authoring.kind},
                        'erdblick:object': this.objectIdentity, 'erdblick:drawing': authoring}}], undefined, true);
                    const count = this.sources.sources.get(doc.mapId)!.summary.rowCount;
                    this.objectId = (await this.sources.rows(doc.mapId, count - 1, 1))[0]?.id;
                    if (this.objectId && this.docs.activeId === doc.mapId) await this.docs.selectObject(doc.mapId,this.objectId);
                }
                if (this.errors.document) { this.errors.document = ''; this.docs.notify('document', ''); this.changed.next(); }
            } catch (error) {
                if (!this.committedPending) this.committedText = '';
                this.fail(error);
            }
        }
    }
    /** The preview lane uses a separate native owner in the UI heap, with at most two positions. */
    private publishPreview(): void {
        if (this.clearing) return;
        const gesture = this.editGesture, editing = this.editing;
        let feature;
        if (this.annotationPrompt && this.annotation.trim() && this.points[0]) feature={type:'Feature',geometry:{type:'Point',coordinates:this.points[0]},properties:{color:this.color,preview:true,role:'measurement-label',label:this.annotation}};
        if (gesture && editing) {
            feature = structuredClone(editing.object.feature);
            const keys = gesture.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
            let target: any = feature; for (const key of keys.slice(0, -1)) target = target[key];
            target[keys.at(-1)!] = gesture.position;
            const authoring = recognizedDrawingAuthoring(feature['erdblick:drawing']);
            if (authoring && authoring.kind !== 'ordinary') { try { feature.geometry = JSON.parse(coreLib.drawingEvaluate(JSON.stringify({authoring}))).geometry; } catch { feature = undefined; } }
        }
        const point = this.active && this.cursor && this.points.at(-1) ? this.cursor : undefined;
        if (!feature && !point && !this.previewId && !this.previewFlushing) return;
        const text = feature ? JSON.stringify({feature}) : this.renderSource(point ? [this.points.at(-1)!, point] : []), generation = this.generation;
        if (text === this.previewText) return;
        this.previewText = text; this.previewPending = {text, generation};
        if (this.previewFlushing) return;
        this.previewFlushing = true;
        this.previewQueue = this.flushPreview().catch(error => { this.previewText = ''; this.fail(error, 'preview'); })
            .finally(() => { this.previewFlushing = false; });
    }

    /** Bound cursor work to one executing and one newest pending revision. */
    private async flushPreview(): Promise<void> {
        while (this.previewPending) {
            const {text, generation} = this.previewPending; this.previewPending = undefined;
            if (generation !== this.generation) continue;
            try {
                if (!this.previewId) {
                    const id = 'drawing-' + crypto.randomUUID();
                    await this.sources.create(id, EMPTY_DRAWING, 'Measurement preview', true);
                    this.previewId = id;
                }
                const request = JSON.parse(text);
                let preview = EMPTY_DRAWING;
                if (request.feature) { delete request.feature['erdblick:drawing']; preview = JSON.stringify({type: 'FeatureCollection', features: [request.feature]}); }
                else if (request.points.length >= 2) {
                    const evaluated = JSON.parse(coreLib.drawingEvaluate(JSON.stringify({authoring: request.authoring ?? {version: 1, kind: 'polyline', space: this.space, points: request.points}})));
                    preview = JSON.stringify({type: 'FeatureCollection', features: [{type: 'Feature', geometry: evaluated.geometry, properties: {color: this.color, preview: true, role: 'cursor-segment'}}]});
                }
                await this.sources.change({type: 'replace', mapId: this.previewId, text: preview});
                this.restrictView(this.previewId, this.viewId);
                if (this.errors.preview) { this.errors.preview = ''; this.docs.notify('preview', ''); this.changed.next(); }
            } catch (error) {
                if (!this.previewPending) this.previewText = '';
                this.fail(error, 'preview');
            }
        }
    }
    /** New measurements and live previews begin in their captured view. */
    private restrictView(mapId: string, targetView = this.viewId): void {
        this.viewState.viewIds.forEach((id, index) => this.views.setMapLayerVisibility(index, mapId, 'Drawing', id === targetView));
    }
    /** Report native/worker failures in the widget without dropping the editable point history. */
    private fail(error: unknown, lane: 'document' | 'preview' = 'document'): void {
        this.errors[lane] = error instanceof Error ? error.message : String(error); this.docs.notify(lane, this.errors[lane]); this.changed.next();
    }
    /** Release callbacks and pending animation work with the application. */
    ngOnDestroy(): void {
        clearTimeout(this.colorTimer); this.colorPending=undefined;
        this.views.drawingInput = undefined; this.subscriptions.unsubscribe();
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.changed.complete();
    }
}
