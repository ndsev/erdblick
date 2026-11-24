import {ViewerActionFailure} from '../action/viewer-action-relay.contract';
import type {DrawingDocument, DrawingDocumentsService} from './drawing-documents.service';
import type {DrawingStorageService, StoredDrawingDocument} from './drawing-storage.service';
import type {DrawingWorkspaceTarget} from './drawing.model';

/** A collection save publishes storage once, then retires only superseded workspace members. */
export async function saveDrawingCollection(owner: DrawingDocumentsService, storage: DrawingStorageService,
    name: string, layout: 'one' | 'separate', target: DrawingWorkspaceTarget, signal?: AbortSignal): Promise<{members:DrawingDocument[];selection?:{mapId:string;id:string;path:string}}> {
    owner.assertWorkspace(target);
    const originals = target.members.map(member => owner.documents.get(member.mapId)!);
    if (!originals.length) throw new Error('There are no objects to save.');
    const counts=originals.map(doc=>owner.sources.sources.get(doc.mapId)!.summary.rowCount);
    if(layout==='separate'&&counts.reduce((sum,count)=>sum+count,0)>1000)throw new Error('A collection supports at most 1,000 documents. Save this working set as one unified document.');
    const activeIndex=originals.findIndex(doc=>doc.mapId===owner.activeId),selectedId=owner.selectedObjectId,path=owner.selectedPath;
    let ordinal=0;
    if(activeIndex>=0&&selectedId)ordinal=(await owner.sources.branch(owner.activeId,{id:selectedId,count:1})).row!.ordinal-1;
    const selectedOrdinal=counts.slice(0,Math.max(0,activeIndex)).reduce((sum,count)=>sum+count,0)+ordinal;
    const staged: DrawingDocument[] = [], locked: DrawingDocument[] = [];
    let committed = false;
    try {
        for (const doc of originals) {
            signal?.throwIfAborted();
            await doc.stopInput?.(); await doc.mutation;
            if (doc.error || doc.saving || doc.busy) throw new Error('Resolve document errors before saving.');
            if (doc.pendingObject) throw new Error('Resume or discard the incomplete object before saving. Finished objects are retained.');
            doc.saving = true; locked.push(doc);
            await owner.validate(doc);
            if (doc.error) throw new Error('Resolve document errors before saving.');
        }
        owner.assertWorkspace(target, false);
        if (originals.some((doc, index) => doc.revision !== target.members[index].draftRevision))
            throw new Error('Drawing changed during save; review it before retrying.');
        const validated = owner.captureWorkspace();
        const current = storage.collectionFor(originals[0].mapId);
        const sameMembers = current?.documents.length === originals.length && current.documents.every(member => originals.some(doc => doc.mapId === member.mapId));
        const oneObjectPerMember = originals.every(doc => owner.sources.sources.get(doc.mapId)?.summary.rowCount === 1);
        const keep = (layout === 'one' && originals.length === 1) ||
            (layout === 'separate' && sameMembers && current?.layout === layout && oneObjectPerMember);
        let members = originals;
        if (!keep) {
            const texts = await owner.sources.compose(originals.map(doc => doc.draft), layout === 'separate');
            for (let index = 0; index < texts.length; ++index) {
                signal?.throwIfAborted();
                staged.push(await owner.create('geojson', layout === 'one' ? name : `${name} ${index + 1}`, texts[index], true,
                    {openEditor: false, persist: false, staged:true, signal}));
            }
            members = staged;
        }
        signal?.throwIfAborted(); owner.assertWorkspace(validated);
        const id = sameMembers ? current!.id : crypto.randomUUID();
        const records = members.map((doc, index): StoredDrawingDocument => ({schemaVersion: 2, mapId: doc.mapId,
            name: layout === 'one' ? name : keep && doc.saved ? doc.name : `${name} ${index + 1}`,
            source: doc.draft, saved: true}));
        storage.saveCollection({schemaVersion: 1, id, name, layout, documents: records});
        committed = true;
        // Cancellation after this synchronous storage write cannot roll back the saved collection.
        for (const doc of originals) { clearTimeout(doc.storageTimer); doc.storagePending = false; doc.saving = false; }
        for (let index = 0; index < members.length; ++index) {
            const doc = members[index]; doc.name = records[index].name; doc.saved = true; doc.baseline = doc.draft;
            owner.sources.rename(doc.mapId, doc.name);
            owner.sources.publishSource(doc.mapId); doc.staged=false;
            clearTimeout(doc.storageTimer); doc.storagePending = false; doc.storageError = '';
        }
        if (!keep) for (const doc of originals) if (!doc.saved || (sameMembers && current?.documents.some(member => member.mapId === doc.mapId))) {
            try { await owner.remove(doc.mapId, false); }
            catch (error) { owner.notify('save-cleanup', 'The collection was saved. An old live document could not be released: ' + String(error)); }
        }
        let selection;
        if(activeIndex>=0){
            const target=keep?originals[activeIndex]:layout==='one'?members[0]:members[selectedOrdinal];
            if(target){const row=selectedId?(await owner.sources.rows(target.mapId,keep?ordinal:layout==='one'?selectedOrdinal:0,1))[0]:undefined;selection={mapId:target.mapId,id:row?.id??'',path};}
        }
        return {members,selection};
    } catch(error) {
        if(committed)throw new ViewerActionFailure({code:'internal_error',reason:'collection_publication',outcome:'applied',message:'The collection was saved, but its live presentation could not finish updating. Reload or list local documents before retrying: '+String(error)});
        throw error;
    } finally {
        if (!committed) for (const doc of staged) await owner.remove(doc.mapId, false);
        for (const doc of locked) doc.saving = false;
    }
}
