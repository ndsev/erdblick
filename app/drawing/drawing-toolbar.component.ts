import {DrawingDocumentsService} from './drawing-documents.service';
import {ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {ColorPicker, ColorPickerChangeEvent} from 'primeng/colorpicker';
import {Subscription} from 'rxjs';
import {DrawingTool, DrawingToolsService} from './drawing-tools.service';

/** Compact nonmodal map tools; contextual settings and the independent tray share one dock anchor. */
@Component({selector:'drawing-toolbar',standalone:false,template:`
    @if (tools.visible) {
        <div class="drawing-dock" [style.left.px]="position?.left" [style.top.px]="position?.top" [style.max-width.px]="availableWidth" [style.--tray-max-height]="trayHeight + 'px'" [style.--drawing-control-size]="availableWidth < 360 ? '24px' : availableWidth < 420 ? '28px' : '32px'" [class.compact]="availableWidth < 360" [class.docking]="docking">
            <section #bar class="drawing-toolbar" data-testid="drawing-toolbar" aria-label="Draw and measure">
                <div class="tool-strip" role="toolbar" aria-label="Drawing tools" (keydown)="navigate($event)" (focusin)="trackFocus($event)">
                    <button type="button" class="grip" [tabindex]="focusIndex === 0 ? 0 : -1" aria-label="Move drawing toolbar" pTooltip="Drag to move · Alt + Arrow keys move the toolbar" data-testid="drawing-toolbar-grip"
                        (pointerdown)="beginDrag($event)" (pointermove)="drag($event)" (pointerup)="endDrag($event)" (pointercancel)="endDrag($event)" (lostpointercapture)="endDrag($event)" (keydown)="moveWithKeyboard($event)"><span class="material-symbols-outlined">drag_indicator</span></button>
                    @for (item of modes; track item.id) {
                        <button type="button" [class.selected]="selectedMode === item.id" [disabled]="tools.clearing || tools.preparing || !!documents.workspaceBusy" [tabindex]="focusIndex === $index + 1 ? 0 : -1"
                            [attr.aria-label]="item.label" [attr.aria-pressed]="selectedMode === item.id" [pTooltip]="item.label" [attr.data-testid]="'drawing-tool-' + item.id" (click)="select(item.id)">
                            <span class="material-symbols-outlined" aria-hidden="true">{{item.icon}}</span></button>
                    }
                    <span class="separator"></span>
                    <button type="button" [tabindex]="focusIndex === 8 ? 0 : -1" [class.selected]="tools.snapGeometry" [attr.aria-pressed]="tools.snapGeometry" aria-label="Snap to geometry" pTooltip="Snap to points and lines · Shift constrains angles" (click)="snap()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 3h4v10a3 3 0 0 0 6 0V3h4v10a7 7 0 0 1-14 0Z M5 7h4 M15 7h4"/></svg></button>
                    <span class="color-control" [pTooltip]="tools.mode === 'select' ? 'Selected object color' : 'New object color'">
                        <p-colorpicker #colorPicker [tabindex]="focusIndex === 9 ? '0' : '-1'" [ngModel]="tools.color" format="hex" appendTo="body" [overlayOptions]="{baseZIndex:31000}"
                            [pt]="{preview:{'aria-label':tools.mode === 'select' ? 'Selected object color' : 'New object color',style:{width:'24px',height:'24px',padding:'0'}}}"
                            [disabled]="tools.clearing || !!documents.workspaceBusy" (onChange)="color($event)" (keydown.escape)="$event.stopPropagation()"/>
                    </span>
                    <button type="button" [tabindex]="focusIndex === 10 ? 0 : -1" aria-label="Drawing options" pTooltip="Measurements and options" data-testid="drawing-options-toggle" (click)="options.toggle($event)"><i class="pi pi-ellipsis-h"></i></button>
                    <button type="button" [tabindex]="focusIndex === 11 ? 0 : -1" aria-label="Close drawing toolbar" pTooltip="Close drawing workspace" data-testid="drawing-toolbar-close" (click)="tools.close()"><i class="pi pi-times"></i></button>
                </div>
                @if (tools.active || tools.points.length || tools.editing) {
                    <div class="measure-readout" data-testid="measurement-widget">
                        <span data-testid="drawing-status">{{tools.definingPlane ? tools.planePrompt : tools.mode === 'select' ? 'Edit vertices' : tools.active ? 'Placing ' + selectedLabel : 'Ready'}} · {{tools.space.toUpperCase()}}</span>
                        @if (tools.measurements.distances && !tools.editing) {
                            <span>Last <strong data-testid="measurement-segment">{{tools.format(tools.tailMeters)}}</strong></span>
                            <span>Total <strong data-testid="measurement-total">{{tools.format(tools.totalMeters + tools.tailMeters)}}</strong></span>
                        }
                        @if (tools.measurements.area && !tools.editing) {
                            <strong data-testid="measurement-area">{{tools.formatArea(tools.areaSquareMeters)}}</strong><span>Perimeter <strong data-testid="measurement-perimeter">{{tools.format(tools.perimeterMeters)}}</strong></span>
                        }
                        @if (tools.measurements.angles && !tools.editing) { <strong data-testid="measurement-angle">{{tools.angleDegrees === null ? 'Unavailable' : tools.angleDegrees.toFixed(2) + '°'}}</strong> }
                        @if (tools.editing; as editing) {
                            @if (tools.measurements.distances || tools.measurements.perimeter) { <strong>{{tools.format(editing.object.metrics?.lengthMeters, editing.object.feature['erdblick:drawing']?.unit)}}</strong> }
                            @if (tools.measurements.area) { <strong>{{tools.formatArea(editing.object.metrics?.areaSquareMeters, editing.object.feature['erdblick:drawing']?.unit)}}</strong> }
                        }
                        @if (tools.mode !== 'select' && !tools.definingPlane) { <span data-testid="measurement-points">{{tools.points.length}} positions</span> }
                        @if (tools.definingPlane) { <span>Elevation {{tools.elevation}} m</span><button type="button" aria-label="Undo plane anchor" [disabled]="!tools.planeAnchorCount" (click)="tools.undoPlaneAnchor()"><i class="pi pi-undo"></i></button><button type="button" aria-label="Cancel plane setup" (click)="tools.cancelGesture()"><i class="pi pi-times"></i></button> }
                        @if (tools.shift) { <span class="snap-indicator">45° constraint</span> }
                        @if (tools.snapTarget) { <span>{{tools.snapTarget}}</span> }
                        @if (tools.placingVertex) { <span>Click the vertex destination · Escape cancels</span> }
                        <span class="spacer"></span>
                        @if (tools.active) { <button type="button" aria-label="Finish drawing" pTooltip="Finish (Escape)" (click)="tools.finish()"><i class="pi pi-check"></i></button> }
                        @else if (tools.canResume) { <button type="button" aria-label="Resume drawing" (click)="tools.start()"><i class="pi pi-play"></i></button> }
                    </div>
                }
                @if (tools.annotationPrompt) {
                    <form class="annotation-input" (submit)="completeText($event,text.value)"><label for="drawing-text">Text</label>
                        <input #text pInputText id="drawing-text" [value]="tools.annotation" maxlength="4096" placeholder="Enter annotation" (input)="tools.previewAnnotation(text.value)" (keydown.escape)="cancelText($event)"/>
                        <button pButton type="submit" [text]="true" aria-label="Place annotation" icon="pi pi-check"></button>
                        <button pButton type="button" [text]="true" aria-label="Cancel annotation" icon="pi pi-times" (click)="tools.cancelGesture()"></button></form>
                }
                @if (!tools.compatibleView) { <div class="context-notice">Paused · choose a matching {{tools.space.toUpperCase()}} view. <button pButton type="button" [text]="true" (click)="tools.rebind()">Rebind</button></div> }
            </section>
            @if (documents.trayVisible) { <drawing-tray [collapsed]="tools.state.trayCollapsed.value"/> }
        </div>
        <p-popover #options appendTo="body" [baseZIndex]="30000" (onShow)="fitOptions()" (onHide)="focusOptions()">
            <div data-testid="drawing-options" class="tool-options" (keydown.escape)="$event.stopPropagation(); options.hide()">
                <strong>Measure with a shape</strong>
                <div class="preset-actions">@for (preset of presets; track preset.id) {
                    <button pButton type="button" [text]="true" [attr.data-testid]="'drawing-tool-' + preset.id" (click)="select(preset.id); options.hide()">{{preset.label}}</button>
                }</div>
                <label>Units for new objects <p-select [options]="units" optionLabel="label" optionValue="value" [ngModel]="tools.state.unit.value" (onChange)="tools.state.unit.next($event.value)" appendTo="body" [overlayOptions]="{baseZIndex:30010}" ariaLabel="New drawing measurement units"/></label>
                <label>Color (hex) <input pInputText aria-label="Drawing color hex" [value]="tools.color" maxlength="7" (change)="colorText($event)"/></label>
                <fieldset><legend>Geometry snapping</legend>
                    <label><p-checkbox [binary]="true" [(ngModel)]="tools.snapPoints" (onChange)="tools.changed.next()" ariaLabel="Snap to points"/> Points</label>
                    <label><p-checkbox [binary]="true" [(ngModel)]="tools.snapSegments" (onChange)="tools.changed.next()" ariaLabel="Snap to segments"/> Segments</label>
                    <label>Tolerance (px) <input pInputText type="number" min="2" max="30" [ngModel]="tools.snapTolerance" (change)="tolerance($event)"/></label>
                    <p>Hold Shift for 45° angles. Geometry targets must also satisfy that constraint.</p>
                </fieldset>
                @if (tools.space === '3d') {
                    <fieldset><legend>3D working surface</legend><label>Elevation (m) <input pInputText type="number" [ngModel]="tools.elevation" (change)="elevation($event)"/></label>
                        <p>WGS84 ellipsoidal height. Closed shapes need an explicit plane.</p>
                        <button pButton type="button" [text]="true" (click)="tools.beginPlane('horizontal');options.hide()">Horizontal plane · one anchor</button>
                        <button pButton type="button" [text]="true" (click)="tools.beginPlane('through');options.hide()">Three-anchor plane</button>
                        <label><p-checkbox [binary]="true" [(ngModel)]="tools.projectSnapToPlane" (onChange)="tools.changed.next()" ariaLabel="Project snapped targets onto plane"/> Project off-plane snap targets</label>
                    </fieldset>
                }
                <div class="workspace-actions">
                    @if (tools.editing) {
                        <button pButton type="button" [text]="true" [disabled]="!tools.selectedHandle || !tools.compatibleView" (click)="tools.placeSelectedVertex();options.hide()">Move selected vertex</button>
                        <button pButton type="button" [text]="true" [disabled]="!tools.selectedHandle" (click)="tools.deleteSelectedVertex();options.hide()">Delete selected vertex</button>
                    }
                    <button pButton type="button" [text]="true" (click)="tools.newDrawing();options.hide()">New object</button>
                    <button pButton type="button" [text]="true" [disabled]="!tools.points.length" (click)="tools.backspace()">Undo point (Backspace)</button>
                    <button pButton type="button" [text]="true" [disabled]="!tools.points.length" (click)="tools.clear()">Clear current object</button>
                    <button pButton type="button" [text]="true" (click)="documents.saveWorkspace();options.hide()">Save workspace</button>
                    <button pButton type="button" [text]="true" (click)="documents.requestSave();options.hide()">Save options…</button>
                    <button pButton type="button" [text]="true" (click)="toggleTray();options.hide()">{{documents.trayVisible ? 'Hide' : 'Show'}} Objects tray</button>
                    <button pButton type="button" [text]="true" (click)="snapTopRight();options.hide()">Dock at top-right</button>
                    <button pButton type="button" [text]="true" (click)="tools.state.traySize.next({width:320,height:260});options.hide()">Compact tray</button>
                    <button pButton type="button" [text]="true" (click)="tools.state.traySize.next({width:480,height:480});options.hide()">Large tray</button>
                </div>
            </div>
        </p-popover>
    }
`,styleUrls:['../scss/drawing-toolbar.component.scss']})
export class DrawingToolbarComponent implements OnDestroy {
    readonly modes:{id:DrawingTool;label:string;icon:string}[]=[{id:'select',label:'Select / edit',icon:'near_me'},{id:'polyline',label:'Polyline',icon:'polyline'},{id:'pen',label:'Free drawing',icon:'draw'},{id:'point',label:'Point',icon:'add_location_alt'},{id:'polygon',label:'Polygon',icon:'pentagon'},{id:'ellipse',label:'Ellipse',icon:'circle'},{id:'annotation',label:'Text annotation',icon:'title'}];
    readonly presets:{id:DrawingTool;label:string}[]=[{id:'distance',label:'Distance'},{id:'angle',label:'Angle'},{id:'area',label:'Area'}];
    readonly units=[{label:'Meters',value:'meters'},{label:'Miles',value:'miles'}];
    focusIndex=1;
    docking=false;
    position:{left:number;top:number}|null=null;
    availableWidth=window.innerWidth-16;
    trayHeight=320;
    private element?:HTMLElement;
    private observer?:ResizeObserver;
    private frame?:number;
    private session?:{pointerId:number;x:number;y:number;left:number;top:number;handle:HTMLElement};
    private readonly subscription:Subscription;
    @ViewChild('options') options?:Popover;
    @ViewChild('colorPicker') colorPicker?:ColorPicker;
    /** Dynamic annotation input receives keyboard focus as soon as placement creates it. */
    @ViewChild('text') set annotationInput(value:ElementRef<HTMLInputElement>|undefined){if(value)queueMicrotask(()=>value.nativeElement.focus());}
    /** Observe the toolbar size, including wrapping and browser zoom. */
    @ViewChild('bar') set bar(value:ElementRef<HTMLElement>|undefined){this.observer?.disconnect();this.element=value?.nativeElement;if(this.element){this.observer=new ResizeObserver(()=>this.scheduleLayout());this.observer.observe(this.element);if(this.element.parentElement)this.observer.observe(this.element.parentElement);this.scheduleLayout();}}
    /** Keep control and document state owned by their services. */
    constructor(public readonly tools:DrawingToolsService,public readonly documents:DrawingDocumentsService,private readonly cdr:ChangeDetectorRef){
        this.position=tools.state.toolbarPosition.value;
        this.subscription=tools.changed.subscribe(()=>{this.cdr.markForCheck();this.scheduleLayout();});
        this.subscription.add(documents.changed.subscribe(()=>{if(documents.trayVisible)tools.visible=true;this.cdr.markForCheck();this.scheduleLayout();}));
    }
    get selectedMode():DrawingTool{return ['distance','angle'].includes(this.tools.mode)?'polyline':this.tools.mode==='area'?'polygon':this.tools.mode;}
    get selectedLabel():string{return this.modes.find(item=>item.id===this.selectedMode)?.label.toLowerCase()??'';}
    /** Report failed tool transitions without an unhandled event promise. */
    async select(mode:DrawingTool):Promise<void>{try{await this.tools.select(mode);}catch(error){this.documents.notify('tool',String(error));}}
    /** Snap is independent of the held Shift angle constraint. */
    snap():void{this.tools.snapGeometry=!this.tools.snapGeometry;this.tools.changed.next();}
    /** Hiding the tray preserves its workspace and editing target. */
    toggleTray():void{this.documents.trayVisible=!this.documents.trayVisible;this.tools.highlight('');this.documents.changed.next();}
    /** Canonical PrimeNG picker keeps focus while dragging its spectrum. */
    color(event:ColorPickerChangeEvent):void{event.originalEvent.preventDefault();if(typeof event.value==='string')this.tools.setColor(event.value.startsWith('#')?event.value:'#'+event.value);}
    /** Exact color entry is available without manipulating the picker spectrum. */
    colorText(event:Event):void{const value=(event.target as HTMLInputElement).value;if(/^#[0-9a-f]{6}$/i.test(value))this.tools.setColor(value);else this.documents.notify('color','Enter a six-digit color such as #2266cc.');}
    /** Commit numeric settings only after editing has completed. */
    tolerance(event:Event):void{const value=+(event.target as HTMLInputElement).value;if(Number.isFinite(value)&&value>=2&&value<=30)this.tools.snapTolerance=value;else this.documents.notify('snap','Tolerance must be between 2 and 30 pixels.');this.tools.changed.next();}
    /** Ellipsoidal height is explicit for 3D placement. */
    elevation(event:Event):void{const value=+(event.target as HTMLInputElement).value;if(Number.isFinite(value))this.tools.elevation=value;this.tools.changed.next();}
    /** Place first, then enter the label in the contextual text control. */
    completeText(event:Event,text:string):void{event.preventDefault();this.tools.completeAnnotation(text);}
    /** Escape cancels the pending label without closing the entire workspace. */
    cancelText(event:Event):void{event.preventDefault();event.stopPropagation();this.tools.cancelGesture();}
    /** Return focus from the options popover to its invoking control. */
    focusOptions():void{this.element?.querySelector<HTMLButtonElement>('[data-testid="drawing-options-toggle"]')?.focus();}
    /** Keep the flipped PrimeNG popover inside the usable viewport, including its padding. */
    fitOptions():void {
        const panel=this.options?.container,target=this.options?.target as HTMLElement|undefined;
        if(!panel)return;
        const left=Math.max(8,Math.min(panel.offsetLeft-window.scrollX,window.innerWidth-panel.offsetWidth-8));
        const top=Math.max(48,Math.min(panel.offsetTop-window.scrollY,window.innerHeight-panel.offsetHeight-8));
        panel.style.left=(left+window.scrollX)+'px';panel.style.top=(top+window.scrollY)+'px';
        if(target)panel.style.setProperty('--p-popover-arrow-left',`calc(${target.getBoundingClientRect().left+target.offsetWidth/2-left}px - var(--p-popover-arrow-offset))`);
    }
    /** One animation frame batches owner-view resize and toolbar content changes. */
    private scheduleLayout():void{if(this.frame===undefined)this.frame=requestAnimationFrame(()=>{this.frame=undefined;this.keepInViewport();});}
    /** Reset the persistent dock preference. */
    snapTopRight():void{this.tools.state.toolbarPosition.next(null);this.keepInViewport();}
    /** Capture the grip so moving the toolbar cannot draw or pan. */
    beginDrag(event:PointerEvent):void{if(event.button!==0||this.session||!this.element)return;event.preventDefault();event.stopPropagation();this.options?.hide();this.colorPicker?.hide();const bounds=this.element.getBoundingClientRect(),handle=event.currentTarget as HTMLElement;this.session={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:bounds.left,top:bounds.top,handle};handle.setPointerCapture(event.pointerId);}
    /** Apply deltas to the captured starting bounds. */
    drag(event:PointerEvent):void{const session=this.session;if(!session||session.pointerId!==event.pointerId)return;this.place(session.left+event.clientX-session.x,session.top+event.clientY-session.y);const bounds=this.bounds();this.docking=!!this.position&&!!this.element&&Math.abs(this.position.left+this.dockWidth-bounds.right+8)<28&&Math.abs(this.position.top-bounds.top-8)<28;}
    /** Releasing near the owning view's corner activates the top-right dock. */
    endDrag(event?:PointerEvent):void{const session=this.session;if(!session||(event&&session.pointerId!==event.pointerId))return;this.session=undefined;if(session.handle.hasPointerCapture(session.pointerId))session.handle.releasePointerCapture(session.pointerId);const bounds=this.bounds();const docked=this.position&&this.element&&Math.abs(this.position.left+this.dockWidth-bounds.right+8)<28&&Math.abs(this.position.top-bounds.top-8)<28;this.docking=false;this.tools.state.toolbarPosition.next(docked?null:this.position);this.keepInViewport();}
    /** Moving the grip is available to keyboard users too. */
    moveWithKeyboard(event:KeyboardEvent):void{if(!this.element||!event.altKey||!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();const bounds=this.element.getBoundingClientRect(),step=event.shiftKey?40:10;this.place(bounds.left+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),bounds.top+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0));this.tools.state.toolbarPosition.next(this.position);}
    /** Roving focus follows toolbar convention and leaves typing to contextual inputs. */
    navigate(event:KeyboardEvent):void {
        if(event.defaultPrevented||event.altKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        const controls=Array.from(this.element!.querySelectorAll<HTMLElement>('.tool-strip button:not(:disabled),.tool-strip input:not(:disabled)'));
        const index=controls.indexOf(event.target as HTMLElement);
        if(index<0)return;
        const next=event.key==='Home'?0:event.key==='End'?controls.length-1:(index+(event.key==='ArrowLeft'?-1:1)+controls.length)%controls.length;
        event.preventDefault();event.stopPropagation();controls[next]?.focus();
    }
    /** Keep exactly one toolbar tab stop, including its picker and movable grip. */
    trackFocus(event:FocusEvent):void {
        const controls=Array.from(this.element!.querySelectorAll<HTMLElement>('.tool-strip button,.tool-strip input'));
        const index=controls.indexOf(event.target as HTMLElement);if(index>=0)this.focusIndex=index;
    }

    get dockWidth():number{return this.element?.parentElement?.offsetWidth??this.element?.offsetWidth??0;}
    /** Reserve the navigation column and bottom scale area inside the owning view. */
    private bounds():{left:number;top:number;right:number;bottom:number}{
        const view=this.tools.viewBounds;
        const controls=Math.ceil(parseFloat(getComputedStyle(document.documentElement).fontSize)*4)+8;
        return{left:Math.max(0,view?.left??0)+(this.tools.controlsOnLeft?controls:0),top:Math.max(40,view?.top??40),right:Math.min(window.innerWidth,view?.right??window.innerWidth)-(this.tools.controlsOnLeft?0:controls),bottom:Math.min(window.innerHeight,view?.bottom??window.innerHeight)-80};
    }
    /** Resizing or changing split-view layouts preserves reachability. */
    @HostListener('window:resize') keepInViewport():void{if(!this.element||this.session)return;const bounds=this.bounds();const saved=this.tools.state.toolbarPosition.value;this.place(saved?.left??bounds.right-this.dockWidth-8,saved?.top??bounds.top+8);}
    /** Size the separate tray within the space below the compact toolbar. */
    private place(left:number,top:number):void{if(!this.element)return;const bounds=this.bounds();this.availableWidth=Math.max(160,bounds.right-bounds.left-16);this.position={left:Math.max(bounds.left+8,Math.min(left,bounds.right-this.dockWidth-8)),top:Math.max(bounds.top+8,Math.min(top,bounds.bottom-this.element.offsetHeight-48))};this.trayHeight=Math.max(80,bounds.bottom-this.position.top-this.element.offsetHeight-16);this.cdr.markForCheck();}
    /** Retire pointer, observer and frame lifetimes on teardown. */
    ngOnDestroy():void{this.endDrag();this.observer?.disconnect();if(this.frame!==undefined)cancelAnimationFrame(this.frame);this.subscription.unsubscribe();}
}
