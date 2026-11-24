import {ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DrawingDocumentsService} from './drawing-documents.service';
import {DrawingToolsService} from './drawing-tools.service';
import {DrawingRow} from './drawing.model';

/** One windowed list spans every document in the working set; Quick owns the detailed inspector. */
@Component({selector:'drawing-tray',standalone:false,template:`
    <section class="objects-tray" aria-label="Objects tray" data-testid="drawing-objects-tray" #tray
        [style.width.px]="tools.state.traySize.value.width" [style.height.px]="collapsed ? null : tools.state.traySize.value.height"
        [class.collapsed]="collapsed" (pointerup)="saveSize(tray)">
        <header><button pButton type="button" [text]="true" [attr.aria-expanded]="!collapsed" aria-label="Toggle Objects tray" (click)="toggle()"><i [class]="collapsed ? 'pi pi-chevron-right' : 'pi pi-chevron-down'"></i></button>
            <strong>Objects <small>{{objectCount}}</small></strong>
            <button pButton type="button" [text]="true" icon="pi pi-search" aria-label="Find workspace objects" [attr.aria-expanded]="filterVisible" (click)="toggleFilter()"></button>
            <button pButton type="button" [text]="true" icon="pi pi-undo" aria-label="Undo drawing edit" [disabled]="!documents.canHistory('undo')" (click)="history('undo')"></button>
            <button pButton type="button" [text]="true" aria-label="Redo drawing edit" [disabled]="!documents.canHistory('redo')" (click)="history('redo')"><i class="pi pi-undo" style="transform:scaleX(-1)" aria-hidden="true"></i></button>
            <button pButton type="button" [text]="true" icon="pi pi-save" aria-label="Save workspace" [disabled]="!!documents.workspaceBusy || !documents.workingIds.length" (click)="save()"></button>
        </header>
        @if (!collapsed) {
            <div class="tray-body">
            <div class="tray-target" aria-live="polite">Editing {{documents.documents.get(documents.activeId)?.name || 'No document'}}
                <button pButton type="button" [text]="true" [disabled]="!documents.activeId" (click)="documents.open(documents.activeId)">Editor</button></div>
            <div class="tray-add"><p-select [options]="available" optionLabel="name" optionValue="mapId" placeholder="Add document or collection…" [ngModel]="null"
                [disabled]="!!documents.workspaceBusy" appendTo="body" ariaLabel="Add document to Objects tray" (onChange)="add($event.value)"/></div>
            @if (filterVisible) { <div class="tray-add"><input pInputText aria-label="Find workspace objects by name or type" placeholder="Find by name or geometry type" [value]="query" (input)="filter($any($event.target).value)" style="width:100%"/><small>{{searchStatus}}</small></div> }
            <div #viewport class="tray-viewport" role="grid" aria-label="Workspace objects" [attr.aria-rowcount]="totalRows" [attr.aria-activedescendant]="focusedKey || null" tabindex="0" (scroll)="windowRows()" (keydown)="navigate($event)">
                <div [style.height.px]="totalRows * rowHeight" class="tray-spacer" role="rowgroup">
                    @for (item of visible; track item.key) {
                        <div [id]="item.key" class="tray-row" [class.document-row]="!item.row" [class.selected]="selected(item)" [class.focused]="focusedKey === item.key"
                            [style.top.px]="item.index * rowHeight" role="row" [attr.aria-rowindex]="item.index + 1" [attr.aria-selected]="selected(item)"
                            (mouseenter)="hover(item)" (mouseleave)="tools.highlight('')">
                            <div role="gridcell" style="display:contents">
                            @if (!item.row) {
                                <button type="button" class="row-main" [attr.aria-label]="'Edit document ' + item.name" (click)="choose(item)"><i class="pi pi-file" aria-hidden="true"></i><span>{{item.name}}{{item.dirty ? ' · unsaved' : ''}}</span></button>
                                <button type="button" [attr.aria-label]="'Remove ' + item.name + ' from tray'" (click)="removeDocument(item.mapId)"><i class="pi pi-minus"></i></button>
                            } @else {
                                <button type="button" class="row-main" (click)="choose(item)" (dblclick)="properties(item)"><i [class]="icon(item.row)" aria-hidden="true"></i><span>{{item.row.description || item.row.geometryType || 'Empty geometry'}}</span></button>
                                <button type="button" [disabled]="busy(item.mapId)" [attr.aria-label]="item.row.visible === false ? 'Show object' : 'Hide object'" (click)="visibility(item)"><i [class]="item.row.visible === false ? 'pi pi-eye-slash' : 'pi pi-eye'"></i></button>
                                <button type="button" [disabled]="busy(item.mapId)" aria-label="Edit object in map" (click)="edit(item)"><i class="pi pi-pencil"></i></button>
                                <button type="button" aria-label="Object properties" (click)="properties(item)"><i class="pi pi-sliders-h"></i></button>
                                <button type="button" [disabled]="busy(item.mapId)" aria-label="Delete object" (click)="remove(item)"><i class="pi pi-trash"></i></button>
                            }
                            </div>
                        </div>
                    }
                </div>
                @if (!objectCount) { <p class="tray-add">Choose a drawing tool, or add a document to begin.</p> }
            </div>
            </div>
            <footer><span>{{storageStatus}}</span>
                <button type="button" aria-label="Resize Objects tray" (keydown)="resize($event)" title="Arrow keys resize">↔ ↕</button></footer>
        }
    </section>
`,styles:[`:host{display:block;max-width:100%}.objects-tray{display:flex;flex-direction:column;resize:both;overflow:hidden;min-width:min(280px,100%);min-height:min(160px,var(--tray-max-height,60vh));max-width:100%;max-height:var(--tray-max-height,60vh);border:1px solid var(--p-content-border-color);border-radius:6px;background:var(--p-content-background);box-shadow:0 2px 10px #0003}.objects-tray.collapsed{resize:none;min-height:0}.tray-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto}.objects-tray>header,.objects-tray>footer,.tray-target,.tray-add{flex-shrink:0}header{display:flex;align-items:center;gap:.25rem;padding:.2rem}header strong{flex:1}small{color:var(--p-text-muted-color);font-weight:400}header button{width:32px;height:32px;padding:.2rem}.tray-target{display:flex;align-items:center;padding:0 .6rem;font-size:.8rem;background:var(--p-highlight-background);gap:.5rem}.tray-target button{margin-left:auto}.tray-add{padding:.3rem}.tray-add p-select{width:100%;font-size:.8rem}.tray-viewport{flex:1;min-height:36px;overflow:auto;position:relative}.tray-spacer{position:relative}.tray-row{display:flex;align-items:center;position:absolute;height:36px;left:0;right:0;padding:0 .25rem;gap:.1rem;border-bottom:1px solid var(--p-content-border-color)}.tray-row button{background:transparent;color:inherit;border:0;border-radius:4px;min-width:30px;min-height:30px;padding:.3rem;cursor:pointer}.tray-row button:hover{background:var(--p-content-hover-background)}.tray-row .row-main{flex:1;display:flex;align-items:center;gap:.4rem;min-width:0;text-align:left}.row-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.document-row{font-weight:600;background:var(--p-content-hover-background)}.selected{background:var(--p-highlight-background);color:var(--p-highlight-color)}.focused{outline:2px solid var(--p-primary-color);outline-offset:-2px}footer{display:flex;justify-content:space-between;font-size:.75rem;color:var(--p-text-muted-color);padding:.25rem .5rem}footer button{background:transparent;border:0;color:inherit;min-width:32px;min-height:24px;cursor:nwse-resize}`]})
export class DrawingTrayComponent implements OnDestroy {
    @Input() collapsed=false;
    @ViewChild('viewport') viewport?:ElementRef<HTMLElement>;
    readonly rowHeight=36;
    visible:TrayRow[]=[];
    focusedKey='';
    filterVisible=false;
    query='';
    searchStatus='';
    private matches:TrayRow[]=[];
    private searchRevision='';
    private filterTimer?:ReturnType<typeof setTimeout>;
    private serial=0;
    private signature='';
    private readonly subscription:Subscription;
    /** Document changes invalidate only the visible window, not a full 100,000-object model. */
    constructor(public readonly documents:DrawingDocumentsService,public readonly tools:DrawingToolsService,private readonly cdr:ChangeDetectorRef){
        this.subscription=documents.changed.subscribe(()=>{const key=documents.workingIds.map(id=>id+':'+documents.sources.sources.get(id)?.summary.revision+':'+documents.documents.get(id)?.name+':'+documents.dirty(documents.documents.get(id)!)).join('|');if(key!==this.signature){this.signature=key;void this.windowRows();}this.cdr.markForCheck();});
        queueMicrotask(()=>void this.windowRows());
    }
    get available(){return [...this.documents.documents.values()].filter(doc=>!doc.staged&&!this.documents.workingIds.includes(doc.mapId));}
    get objectCount():number{return this.documents.workingIds.reduce((count,id)=>count+(this.documents.sources.sources.get(id)?.summary.rowCount??0),0);}
    get totalRows():number{return this.query.trim()?this.matches.length:this.objectCount+this.documents.workingIds.length;}
    get storageStatus():string{
        if(this.documents.workspaceBusy)return 'Saving…';
        const members=this.documents.workingDocuments;
        if(members.some(doc=>doc.storageError))return 'Browser recovery unavailable';
        return members.length&&members.every(doc=>doc.saved&&!this.documents.dirty(doc))?'Saved in this browser':'Draft kept in this browser';
    }
    /** Search is optional and does not retain an unbounded second copy of the object catalog. */
    toggleFilter():void{this.filterVisible=!this.filterVisible;if(!this.filterVisible)this.filter('');}
    /** Debounce input and invalidate older native pages before reading a new query. */
    filter(query:string):void{this.query=query;this.searchRevision='';++this.serial;clearTimeout(this.filterTimer);if(this.viewport)this.viewport.nativeElement.scrollTop=0;this.filterTimer=setTimeout(()=>void this.windowRows(),180);}
    /** Bound search to 100 matches and 10,000 inspected rows, with an explicit qualification. */
    private async search(serial:number):Promise<void>{
        const query=this.query.trim().toLocaleLowerCase(),output:TrayRow[]=[];let scanned=0,matches=0;
        this.searchStatus='Searching…';
        for(const doc of this.documents.workingDocuments){
            let header=false;
            const count=this.documents.sources.sources.get(doc.mapId)?.summary.rowCount??0;
            for(let offset=0;offset<count&&scanned<10000&&matches<100;offset+=100){
                const rows=await this.documents.sources.rows(doc.mapId,offset,100);
                if(serial!==this.serial)return;
                for(const row of rows){
                    ++scanned;if(!`${doc.name} ${row.description} ${row.geometryType}`.toLocaleLowerCase().includes(query))continue;
                    if(!header){output.push({key:'tray-'+doc.mapId,index:output.length,mapId:doc.mapId,name:doc.name,dirty:this.documents.dirty(doc)});header=true;}
                    output.push({key:'tray-'+doc.mapId+'-'+row.id,index:output.length,mapId:doc.mapId,name:doc.name,row});if(++matches===100)break;
                }
            }
            if(scanned>=10000||matches>=100)break;
        }
        if(serial!==this.serial)return;
        this.matches=output;this.searchRevision=this.signature+query;
        this.searchStatus=`${matches} matches`+(matches===100?' · first 100 shown':scanned<this.objectCount?' · searched the first 10,000 objects':'');
    }
    /** Read only rows intersecting the viewport, with a small overscan on either side. */
    async windowRows():Promise<void>{
        const serial=++this.serial, element=this.viewport?.nativeElement;
        if(this.query.trim()){
            try{if(this.searchRevision!==this.signature+this.query.trim().toLocaleLowerCase())await this.search(serial);}catch(error){this.documents.notify('tray',String(error));}
            if(serial!==this.serial)return;
            const start=Math.max(0,Math.floor((element?.scrollTop??0)/this.rowHeight)-4);
            this.visible=this.matches.slice(start,start+Math.ceil((element?.clientHeight||320)/this.rowHeight)+8);this.cdr.markForCheck();return;
        }
        const start=Math.max(0,Math.floor((element?.scrollTop??0)/this.rowHeight)-4),end=Math.min(this.totalRows,start+Math.ceil((element?.clientHeight||320)/this.rowHeight)+8);
        const output:TrayRow[]=[];let base=0;
        for(const doc of this.documents.workingDocuments){
            const count=this.documents.sources.sources.get(doc.mapId)?.summary.rowCount??0;
            if(base>=start&&base<end)output.push({key:'tray-'+doc.mapId,index:base,mapId:doc.mapId,name:doc.name,dirty:this.documents.dirty(doc)});
            const offset=Math.max(0,start-base-1),length=Math.max(0,Math.min(count,end-base-1)-offset);
            if(length)try{const rows=await this.documents.sources.rows(doc.mapId,offset,Math.min(length,100));for(let i=0;i<rows.length;++i)output.push({key:'tray-'+doc.mapId+'-'+rows[i].id,index:base+1+offset+i,mapId:doc.mapId,name:doc.name,row:rows[i]});}catch(error){this.documents.notify('tray',String(error));}
            base+=count+1;
        }
        if(serial!==this.serial)return;this.visible=output;this.cdr.markForCheck();
    }
    /** Collapse releases hover while preserving membership and source selection. */
    toggle():void{this.collapsed=!this.collapsed;this.tools.state.trayCollapsed.next(this.collapsed);this.tools.highlight('');if(!this.collapsed)queueMicrotask(()=>void this.windowRows());}
    /** Geometry type has an icon while object text remains its accessible name. */
    icon(row:DrawingRow):string{return row.kind==='annotation'?'pi pi-comment':row.geometryType.includes('Polygon')?'pi pi-stop':row.geometryType.includes('Line')?'pi pi-minus':'pi pi-map-marker';}
    selected(item:TrayRow):boolean{return this.documents.activeId===item.mapId&&(!item.row||this.documents.selectedObjectId===item.row.id);}
    busy(mapId:string):boolean{const doc=this.documents.documents.get(mapId);return !doc||doc.busy||doc.saving||!!doc.error||!!this.documents.workspaceBusy;}
    /** Hover does not select, edit or change the history target. */
    hover(item:TrayRow):void{this.tools.highlight(item.mapId,item.row?.visible===false?undefined:item.row?.id);}
    /** Deliberately change the editing target through the one document owner. */
    async choose(item:TrayRow):Promise<void>{this.focusedKey=item.key;try{await this.documents.selectObject(item.mapId,item.row?.id??'');}catch(error){this.documents.notify('tray',String(error));}}
    /** Read controls only after the user requests direct map editing. */
    async edit(item:TrayRow):Promise<void>{if(!item.row)return;try{await this.choose(item);await this.tools.editTarget(item.mapId,item.row.id);}catch(error){this.documents.notify('edit',String(error));}}
    /** Open the shared Quick inspector for naming, measurements, color and geometry settings. */
    async properties(item:TrayRow):Promise<void>{try{await this.choose(item);await this.documents.open(item.mapId);}catch(error){this.documents.notify('quick',String(error));}}
    /** Object deletion is reversible through the shared undo command. */
    async remove(item:TrayRow):Promise<void>{
        if(!item.row)return;
        const focus=this.viewport?.nativeElement.ownerDocument.activeElement;
        this.tools.highlight('');
        try{await this.choose(item);await this.documents.objectEdit(this.documents.documents.get(item.mapId)!,[{type:'delete',id:item.row.id}]);await this.restoreRowFocus(item.index,focus);}
        catch(error){this.documents.notify('tray',String(error));}
    }
    /** Visibility belongs to the source object and participates in history. */
    async visibility(item:TrayRow):Promise<void>{if(!item.row)return;try{await this.documents.objectEdit(this.documents.documents.get(item.mapId)!,[{type:'visibility',id:item.row.id,visible:item.row.visible===false}]);}catch(error){this.documents.notify('tray',String(error));}}
    /** Add the complete collection without silently changing the current editing member. */
    async add(id:string):Promise<void>{try{await this.documents.documents.get(this.documents.activeId)?.stopInput?.();this.documents.openTray([...this.documents.workingIds,id]);}catch(error){this.documents.notify('tray',String(error));}}
    /** Removing a member from the tray keeps its saved document and recovery data. */
    async removeDocument(id:string):Promise<void>{
        const index=this.visible.find(item=>item.mapId===id)?.index??0,focus=this.viewport?.nativeElement.ownerDocument.activeElement;
        try{await this.documents.removeFromWorkspace(id);await this.restoreRowFocus(index,focus);}
        catch(error){this.documents.notify('tray',String(error));}
    }
    /** Keep keyboard focus on a surviving row without stealing focus from a subsequent user action. */
    private async restoreRowFocus(index:number,previous:Element|null|undefined):Promise<void>{
        const viewport=this.viewport?.nativeElement;if(!viewport)return;
        await this.windowRows();
        index=Math.max(0,Math.min(index,this.totalRows-1));
        viewport.scrollTop=Math.min(viewport.scrollTop,Math.max(0,this.totalRows*this.rowHeight-viewport.clientHeight));
        if(index*this.rowHeight<viewport.scrollTop)viewport.scrollTop=index*this.rowHeight;
        await this.windowRows();
        this.focusedKey=this.visible.find(row=>row.index===index)?.key??'';
        const current=viewport.ownerDocument.activeElement;
        if(current===previous||current===viewport.ownerDocument.body)viewport.focus();
        this.cdr.markForCheck();
    }
    /** Save the working set, directly on subsequent saves with an unchanged layout. */
    async save():Promise<void>{try{await this.documents.saveWorkspace();}catch(error){this.documents.notify('save',String(error));}}
    /** Undo/redo uses the explicitly highlighted document. */
    async history(direction:'undo'|'redo'):Promise<void>{try{await this.documents.history(direction);}catch(error){this.documents.notify('history',String(error));}}
    /** Persist only user-chosen dimensions, never source or viewport state. */
    saveSize(element:HTMLElement):void{if(!this.collapsed)this.tools.state.traySize.next({width:Math.max(280,Math.min(1600,element.offsetWidth)),height:Math.max(160,Math.min(1200,element.offsetHeight))});void this.windowRows();}
    /** Offer resizing without pointer precision. */
    resize(event:KeyboardEvent):void{if(!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();const size=this.tools.state.traySize.value;this.tools.state.traySize.next({width:Math.max(280,Math.min(1600,size.width+(event.key==='ArrowRight'?20:event.key==='ArrowLeft'?-20:0))),height:Math.max(160,Math.min(1200,size.height+(event.key==='ArrowDown'?20:event.key==='ArrowUp'?-20:0)))});void this.windowRows();}
    /** Arrow navigation moves focus; Enter deliberately changes the selection. */
    async navigate(event:KeyboardEvent):Promise<void>{
        if(event.target!==this.viewport?.nativeElement)return;
        const current=this.visible.find(row=>row.key===this.focusedKey)??this.visible[0];if(!current)return;
        if(event.key==='Enter'){event.preventDefault();await this.choose(current);return;}
        if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
        event.preventDefault();const index=Math.max(0,Math.min(this.totalRows-1,event.key==='Home'?0:event.key==='End'?this.totalRows-1:current.index+(event.key==='ArrowDown'?1:-1)));
        const viewport=this.viewport!.nativeElement;if(index*this.rowHeight<viewport.scrollTop)viewport.scrollTop=index*this.rowHeight;else if((index+1)*this.rowHeight>viewport.scrollTop+viewport.clientHeight)viewport.scrollTop=(index+1)*this.rowHeight-viewport.clientHeight;
        await this.windowRows();const next=this.visible.find(row=>row.index===index);if(next){this.focusedKey=next.key;this.hover(next);this.cdr.markForCheck();}
    }
    /** Retire outstanding pages and only this surface's hover. */
    ngOnDestroy():void{++this.serial;clearTimeout(this.filterTimer);this.tools.highlight('');this.subscription.unsubscribe();}
}
/** Fixed-height virtual row; headers and objects share a stable workspace-relative index. */
interface TrayRow{key:string;index:number;mapId:string;name:string;dirty?:boolean;row?:DrawingRow;}
