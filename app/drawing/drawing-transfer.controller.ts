import {z} from 'zod';
import type {AppActionRegistration} from '../action/action-contributor.model';
import type {DrawingDocumentsService} from './drawing-documents.service';
import {rejectAction} from '../action/action.model';

const encoder = new TextEncoder();
const maxBytes = 32*1024*1024;
const index = z.number().int().nonnegative();
const id = z.string().min(1).max(128);
/** Validate scalar Unicode chunks before UTF-8 encoding; offsets remain UTF-16 code units. */
function unicode(text: string): boolean {
    for(let i=0;i<text.length;++i){const value=text.charCodeAt(i);if(value>=0xD800&&value<=0xDBFF){const next=text.charCodeAt(++i);if(!(next>=0xDC00&&next<=0xDFFF))return false;}else if(value>=0xDC00&&value<=0xDFFF)return false;}
    return true;
}
/** A bounded transfer slot owns staging bytes and its commit cancellation signal. */
interface Transfer {mapId?:string;revision?:number;draftRevision?:number;name:string;total:number;text:string;bytes:number;expires:number;controller:AbortController;commit?:Promise<TransferResult>;result?:TransferResult;}
interface TransferResult {transferId:string;mapId?:string;offset:number;bytes:number;revision?:number;outcome:'staged'|'applied'|'not_applied';}

/** Large-source imports share native preparation, exact revision targets and transport byte budgets. */
export function registerDrawingTransfer(owner:DrawingDocumentsService,actions:AppActionRegistration):void {
    const transfers=new Map<string,Transfer>();
    const result=(transferId:string,transfer:Transfer,outcome:TransferResult['outcome']='staged'):TransferResult=>({transferId,offset:transfer.text.length,bytes:transfer.bytes,outcome,...(transfer.mapId?{mapId:transfer.mapId}:{})});
    actions.registerAction({name:'viewer_drawing_transfer',description:'Stage UTF-8-bounded GeoJSON using UTF-16 chunk offsets. begin declares total UTF-16 length; append must use the returned offset and complete Unicode scalars. Each transfer is limited to 32 MiB UTF-8, four slots and 64 MiB aggregate. Encoded append requests must fit 48 KiB. Slots expire after five minutes. Commit validates before publication; cancel waits for an in-flight commit and reports its actual outcome. Import does not change workspace selection.',mutation:true,
        inputSchema:z.strictObject({action:z.enum(['begin','append','commit','cancel','status']),transferId:id.optional(),mapId:id.optional(),revision:index.optional(),draftRevision:index.optional(),name:z.string().max(256).optional(),total:index.max(maxBytes).optional(),offset:index.optional(),text:z.string().max(16000).optional()}),
        outputSchema:z.object({transferId:id,mapId:id.optional(),offset:index,bytes:index,revision:index.optional(),outcome:z.enum(['staged','applied','not_applied'])})},async(input,signal)=>{
            for(const [key,value]of transfers)if(value.expires<Date.now()&&!value.commit)transfers.delete(key);
            if(input.action==='begin'){
                if(transfers.size>=4||input.total===undefined)rejectAction('Specify total UTF-16 length; at most four transfers can be open.','invalid_arguments','transfer_limit');
                if(input.mapId){const doc=owner.documents.get(input.mapId);if(!doc)rejectAction('Drawing not found.','not_available','missing_document');if(input.revision!==owner.sources.sources.get(doc.mapId)?.summary.revision||input.draftRevision!==doc.revision)rejectAction('Current accepted and draft revisions are required.','busy','stale_revision');}
                const transferId=crypto.randomUUID(),transfer:Transfer={mapId:input.mapId,revision:input.revision,draftRevision:input.draftRevision,name:input.name?.trim()||'Imported drawing',total:input.total,text:'',bytes:0,expires:Date.now()+300000,controller:new AbortController()};transfers.set(transferId,transfer);return result(transferId,transfer);
            }
            const transferId=input.transferId??'',transfer=transfers.get(transferId);if(!transfer)rejectAction('Transfer missing or expired.','not_available','missing_transfer');
            if(input.action==='cancel'){
                transfer.controller.abort();
                if(transfer.commit)try{await transfer.commit;}catch{/* The cancelled commit reports its own typed failure to its caller. */}
                const answer=transfer.result??result(transferId,transfer,'not_applied');transfers.delete(transferId);return answer;
            }
            if(input.action==='status')return transfer.result??result(transferId,transfer);
            if(transfer.result)return transfer.result;
            if(transfer.commit)return transfer.commit;
            if(input.action==='append'){
                if(input.offset!==transfer.text.length||input.text===undefined||transfer.text.length+input.text.length>transfer.total||!unicode(input.text))rejectAction('Unexpected offset, length or split Unicode scalar.','invalid_arguments','invalid_chunk');
                const bytes=encoder.encode(input.text).length,aggregate=[...transfers.values()].reduce((sum,item)=>sum+item.bytes,0);
                if(encoder.encode(JSON.stringify(input)).length>48*1024||transfer.bytes+bytes>maxBytes||aggregate+bytes>64*1024*1024)rejectAction('Transfer exceeds its UTF-8 byte budget.','invalid_arguments','transfer_limit');
                transfer.text+=input.text;transfer.bytes+=bytes;transfer.expires=Date.now()+300000;return result(transferId,transfer);
            }
            if(transfer.text.length!==transfer.total)rejectAction('Transfer is incomplete.','invalid_arguments','incomplete_transfer');
            signal?.throwIfAborted();
            const abort=()=>transfer.controller.abort();signal?.addEventListener('abort',abort,{once:true});
            transfer.commit=(async()=>{
                try{
                    let target;
                    if(transfer.mapId){target=owner.documents.get(transfer.mapId);if(!target)rejectAction('Drawing no longer exists.','not_available','missing_document');if(target.revision!==transfer.draftRevision)rejectAction('The raw draft changed.','busy','stale_revision');await owner.replaceSource(target,transfer.text,transfer.revision!,false,transfer.controller.signal);}
                    else{target=await owner.create('geojson',transfer.name,transfer.text,false,{openEditor:false,signal:transfer.controller.signal});owner.groupImported(target,transfer.text,false);}
                    transfer.result={...result(transferId,transfer,'applied'),mapId:target.mapId,revision:owner.sources.sources.get(target.mapId)!.summary.revision};return transfer.result;
                }finally{signal?.removeEventListener('abort',abort);transfer.commit=undefined;}
            })();
            return transfer.commit;
        });
}
