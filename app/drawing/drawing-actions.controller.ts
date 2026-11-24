import {z} from 'zod';
import type {AppActionRegistration} from '../action/action-contributor.model';
import type {DrawingDocumentsService} from './drawing-documents.service';
import {drawingActions, drawingPositionSchema as position} from './drawing-action.util';
import {boundedCollection, rejectAction} from '../action/action.model';
import {registerDrawingTransfer} from './drawing-transfer.controller';
import {coreLib} from '../integrations/wasm.adapter';
import {ViewerActionFailure} from '../action/viewer-action-relay.contract';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const workspace = z.object({workspaceId:id,workspaceRevision:revision,members:z.array(z.object({mapId:id,revision,draftRevision:revision})).max(1000)});
const edit = z.discriminatedUnion('type', [
    z.object({type: z.literal('insert'), feature: z.object({type: z.literal('Feature'), geometry: z.unknown(), properties: z.record(z.string(), z.unknown()).nullable()}).catchall(z.unknown())}),
    z.object({type: z.literal('delete'), id}), z.object({type: z.literal('convert'), id}),
    z.object({type: z.literal('visibility'), id, visible: z.boolean()}),
    z.object({type: z.literal('author'), id, value: z.record(z.string(), z.unknown())}),
    z.object({type: z.literal('set'), id, path: z.string().max(4096), value: z.unknown(), preserveGeometry: z.boolean().optional()}),
    z.object({type:z.literal('setExact'),id,path:z.string().max(4096),text:z.string().max(8192)}),
    z.object({type:z.literal('height'),id,meters:z.number().finite()}),
    z.object({type:z.literal('curve'),id,index:revision,enabled:z.boolean()}),
    z.object({type: z.literal('remove'), id, path: z.string().max(4096)}),
    z.object({type: z.literal('insertVertex'), id, path: z.string().max(4096), index: revision, value: position.optional()}),
    z.object({type: z.literal('deleteVertex'), id, path: z.string().max(4096), index: revision})
]);

/** Drawing domain declarations. Registration performs no worker, storage or renderer IO. */
export function registerDrawingActions(owner: DrawingDocumentsService, actions: AppActionRegistration): void {
    actions = drawingActions(actions);
    const doc = (mapId: string) => { const result = owner.documents.get(mapId); if (!result || result.staged) rejectAction('Drawing not found.', 'not_available', 'missing_document'); return result; };
    actions.registerAction({name: 'viewer_drawing_list', description: 'Page local drawings, unsaved recovery state and collection membership.', mutation: false,
        inputSchema: z.strictObject({offset: revision.default(0), count: z.number().int().min(1).max(100).default(50)}),
        outputSchema: z.object({workspace, activeId:z.string(), selectedObjectId:z.string(), capabilities:z.unknown(),total: revision, documents: z.array(z.object({mapId: id, name: z.string(), revision, draftRevision:revision, saved: z.boolean(), dirty: z.boolean(), editing: z.boolean(), projectionLimited: z.boolean(), collectionId: id.optional()}))})},
        input => { const values = [...owner.documents.values()].filter(doc=>!doc.staged); return {workspace:owner.captureWorkspace(),activeId:owner.activeId,selectedObjectId:owner.selectedObjectId,capabilities:JSON.parse(coreLib.drawingEvaluate(JSON.stringify({action:'capabilities'}))),total: values.length, documents: values.slice(input.offset,input.offset+input.count).map(d => ({mapId:d.mapId,name:d.name,
            revision:owner.sources.sources.get(d.mapId)!.summary.revision,draftRevision:d.revision,saved:d.saved,dirty:owner.dirty(d),editing:owner.activeId===d.mapId,
            projectionLimited:owner.sources.sources.get(d.mapId)!.summary.projectionLimited,collectionId:owner.collection(d.mapId)?.id}))}; });
    actions.registerAction({name: 'viewer_drawing_objects', description: 'Page logical objects in source order; generated measurements are excluded.', mutation: false,
        inputSchema: z.strictObject({mapId:id,offset:revision.default(0),count:z.number().int().min(1).max(100).default(50)}),
        outputSchema: z.object({revision, total:revision, rows:z.array(z.unknown()),nextOffset:revision.nullable()})}, async input => {
            doc(input.mapId); const current=owner.sources.sources.get(input.mapId)!.summary.revision; const rows=await owner.sources.rows(input.mapId,input.offset,input.count),summary=owner.sources.sources.get(input.mapId)!.summary;
            if (current !== summary.revision) throw new Error('Document changed during read; retry.');
            const bounded=boundedCollection(rows,input.count,160000);
            if(!bounded.items.length&&rows.length)rejectAction('Object metadata is too large for a page; use a chunked source read.','not_available','object_too_large');
            const end=input.offset+bounded.items.length;
            return {revision:summary.revision,total:summary.rowCount,rows:bounded.items,nextOffset:end<summary.rowCount?end:null};
        });
    actions.registerAction({name:'viewer_drawing_branch',description:'Page one semantic GeoJSON branch. Leaf text is exact JSON, preserving foreign 64-bit numbers. Root includes bounded inspector metadata and measurement availability; descendants are loaded explicitly.',mutation:false,
        inputSchema:z.strictObject({mapId:id,objectId:id,path:z.string().max(4096).default(''),revision,offset:revision.default(0),count:z.number().int().min(1).max(100).default(50)}),outputSchema:z.object({branch:z.unknown()})},async input=>{
            doc(input.mapId);return {branch:await owner.sources.branch(input.mapId,{id:input.objectId,path:input.path,revision:input.revision,offset:input.offset,count:input.count})};
        });
    actions.registerAction({name:'viewer_drawing_read',description:'Read a bounded UTF-16 source chunk (accepted GeoJSON or one object and metrics). Continue with nextOffset and the same revision. Source reads are lossless and can be used for export.',mutation:false,
        inputSchema:z.strictObject({mapId:id,objectId:id.optional(),offset:revision.default(0),length:z.number().int().min(1).max(16000).default(16000),portable:z.boolean().default(false),revision:revision.optional()}),
        outputSchema:z.object({revision,text:z.string(),nextOffset:revision.nullable(),total:revision})}, async input => {
            const d=doc(input.mapId), current=owner.sources.sources.get(d.mapId)!.summary.revision;
            if(input.revision!==undefined&&input.revision!==current)throw new Error('Stale document revision.');
            const source=input.objectId?JSON.stringify(await owner.sources.object(d.mapId,input.objectId)):input.portable?await owner.portableSource(d):owner.sources.sources.get(d.mapId)!.text;
            if (owner.sources.sources.get(d.mapId)!.summary.revision !== current) throw new Error('Document changed during read; retry.');
            // Do not split a surrogate pair. Offsets count UTF-16 code units, like JavaScript source edits.
            if (input.offset > source.length || (input.offset > 0 && /[\uD800-\uDBFF]/.test(source[input.offset-1]) && /[\uDC00-\uDFFF]/.test(source[input.offset] ?? ''))) rejectAction('Offset must be a source boundary returned by nextOffset.', 'invalid_arguments', 'invalid_offset');
            let end=Math.min(source.length,input.offset+input.length);if(end<source.length&&/[\uD800-\uDBFF]/.test(source[end-1])) { if(end===input.offset+1) ++end; else --end; }
            return {revision:current,text:source.slice(input.offset,end),nextOffset:end<source.length?end:null,total:source.length};
        });
    actions.registerAction({name:'viewer_drawing_edit',description:'Atomic revision-checked object edits: insert/delete, properties, vertices, curve handles, plane, visibility, measurements and annotations. One batch is one undo step.',mutation:true,
        inputSchema:z.strictObject({mapId:id,revision,operations:z.array(edit).min(1).max(1000)}),outputSchema:z.object({revision})}, async (input,signal)=>{
            await owner.objectEdit(doc(input.mapId),input.operations as import('./drawing.model').DrawingObjectEdit[],input.revision,false,signal);
            return {revision:owner.sources.sources.get(input.mapId)!.summary.revision};
        });
    actions.registerAction({name:'viewer_drawing_workspace',description:'Create a draft, open/select explicit documents, save/discard/close a captured workspace, or rename/delete a revision-checked document. Read viewer_drawing_list first for workspace and member revisions. Save is browser-local; export uses source reads.',mutation:true,
        inputSchema:z.strictObject({action:z.enum(['new','open','select','save','discard','close','delete','rename']),workspace:workspace.optional(),mapIds:z.array(id).max(1000).optional(),revision:revision.optional(),draftRevision:revision.optional(),name:z.string().max(256).optional(),layout:z.enum(['one','separate']).optional()}),
        outputSchema:z.object({mapIds:z.array(id),activeId:z.string(),workspace,saved:z.boolean().optional()})},async(input,signal)=>{
            let saved:boolean|undefined;
            if(['save','discard','close','select','open'].includes(input.action)){
                if(!input.workspace)rejectAction('Read and supply the current workspace and member revisions.','invalid_arguments','workspace_required');
                owner.assertWorkspace(input.workspace);
                if(input.mapIds&&['save','discard','close'].includes(input.action)&&JSON.stringify(input.mapIds)!==JSON.stringify(input.workspace.members.map(member=>member.mapId)))rejectAction('mapIds must match the captured workspace exactly.','invalid_arguments','workspace_mismatch');
            }
            if(input.action==='delete'||input.action==='rename'){
                if(input.mapIds?.length!==1)rejectAction('Specify exactly one document.','invalid_arguments','document_required');
                const target=doc(input.mapIds[0]);
                if(input.revision!==owner.sources.sources.get(target.mapId)!.summary.revision||input.draftRevision!==target.revision)rejectAction('Current accepted and draft revisions are required.','busy','stale_revision');
                if(input.action==='delete'){
                    await owner.remove(target.mapId,false,()=>{
                        signal?.throwIfAborted();
                        if(input.revision!==owner.sources.sources.get(target.mapId)?.summary.revision||input.draftRevision!==target.revision)
                            rejectAction('The delete target changed while edits were completing. Read its current revisions before retrying.','busy','stale_revision');
                    });
                    if(owner.documents.has(target.mapId))rejectAction(target.storageError||target.notice||'Document could not be deleted.','not_available','delete_failed');
                }
                else{if(!input.name?.trim())rejectAction('A name is required.','invalid_arguments','name_required');owner.rename(target,input.name);}
            }
            if(input.action==='new'){
                await owner.documents.get(owner.activeId)?.stopInput?.();signal?.throwIfAborted();
                const target=await owner.create('geojson','Untitled drawing',undefined,false,{openEditor:false,signal});owner.openTray([target.mapId]);
            }
            if(input.action==='open'){
                for(const mapId of input.mapIds??[])doc(mapId);
                await owner.documents.get(owner.activeId)?.stopInput?.();signal?.throwIfAborted();owner.assertWorkspace(input.workspace!);owner.openTray(input.mapIds??[]);
            }
            if(input.action==='select'){
                const mapId=input.mapIds?.[0];if(!mapId||input.mapIds?.length!==1||!owner.workingIds.includes(mapId))rejectAction('Select one member of the captured workspace.','invalid_arguments','document_required');
                await owner.selectDocument(mapId);
            }
            if(input.action==='save'){
                if(!input.name?.trim())rejectAction('A save name is required.','invalid_arguments','name_required');
                saved=await owner.saveWorkingSet(input.name,input.layout??'one',input.workspace!,signal);
                if(!saved)rejectAction(owner.lastSaveError||'Drawing was not saved.','not_available','save_failed');
            }
            if(input.action==='discard'&&!await owner.discardWorkingSet(input.workspace!,signal))
                throw new ViewerActionFailure({code:'not_available',reason:'discard_failed',outcome:'unknown',message:'Discard did not complete. Read the current workspace to inspect retained members before retrying.'});
            if(input.action==='close'){
                if(owner.workingDocuments.some(d=>owner.dirty(d)||d.pendingObject))rejectAction('Save or discard changes before closing.','not_available','unsaved_workspace');
                for(const member of owner.workingDocuments)await member.stopInput?.();owner.assertWorkspace(input.workspace!);signal?.throwIfAborted();owner.trayVisible=false;
            }
            owner.changed.next();return{mapIds:owner.workingIds,activeId:owner.activeId,workspace:owner.captureWorkspace(),...(saved===undefined?{}:{saved})};
        },()=>[
            {id:'drawing:new',name:'viewer_drawing_workspace',label:'New drawing',icon:'draw',iconType:'material',color:'#44a58e',enabled:true,input:{action:'new' as const}},
            ...[...owner.documents.values()].filter(doc=>!doc.staged).map(d=>({id:'drawing:open:'+d.mapId,name:'viewer_drawing_workspace',label:'Open drawing: '+d.name,icon:'draw',iconType:'material' as const,color:'#44a58e',enabled:true,input:{action:'open' as const,mapIds:[d.mapId],workspace:owner.captureWorkspace()}}))
        ]);
    actions.registerAction({name:'viewer_drawing_history',description:'Undo/redo one retained edit in an explicitly revision-checked document without changing the active workspace selection.',mutation:true,
        inputSchema:z.strictObject({mapId:id,revision,direction:z.enum(['undo','redo'])}),outputSchema:z.object({revision})},async(input,signal)=>{
            doc(input.mapId);await owner.history(input.direction,input.mapId,input.revision,signal);return{revision:owner.sources.sources.get(input.mapId)!.summary.revision};
        });
    registerDrawingTransfer(owner,actions);
}
