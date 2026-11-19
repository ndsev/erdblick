import '@angular/compiler';
import {describe, expect, it, vi} from 'vitest';
import {Subject} from 'rxjs';
import {DrawingToolsService} from '../../../app/drawing/drawing-tools.service';
import {MapViewService} from '../../../app/mapview/mapview.service';
import {stateOwners, testPersistence} from '../../support/state-owners';

describe('Measurement update ownership', () => {
    it('coalesces pending history and retains its local document when closing after a failed update', async () => {
        const persistence = testPersistence(), {drawing: state, viewSettings} = stateOwners(persistence);
        let rejectFirst!: (error: Error) => void;
        const sources = {sources: new Map(), recovered: new Subject<string>(),
            create: vi.fn().mockResolvedValue(undefined), change: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue(undefined)};
        const doc = {mapId: 'drawing-measurement', stopInput: undefined};
        const docs = {documents: new Map([[doc.mapId, doc]]),
            create: vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
                .mockResolvedValue(doc), edit: vi.fn().mockResolvedValue(undefined)};
        const views = {viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(state, sources as never, docs as never, views, viewSettings);
        tools.start();
        const view = viewSettings.viewIdAt(0);
        views.drawingInput!.click(view, [0, 0]);
        views.drawingInput!.click(view, [1, 0]);
        views.drawingInput!.click(view, [2, 0]);
        expect(docs.create).toHaveBeenCalledTimes(1);
        rejectFirst(new Error('native vertex cap'));
        await vi.waitFor(() => expect(docs.edit).toHaveBeenCalledTimes(1));
        expect(JSON.parse(docs.edit.mock.calls[0][1].text).points).toEqual([[0, 0], [1, 0], [2, 0]]);
        expect(tools.error).toBe('');
        const visibility = vi.mocked(views.setMapLayerVisibility);
        visibility.mockClear(); sources.sources.set(doc.mapId, {});
        sources.recovered.next(doc.mapId);
        viewSettings.importViews(['0', '1']);
        expect(visibility).not.toHaveBeenCalled(); // Ordinary local visibility is user-owned after creation.
        tools.backspace(); tools.backspace(); tools.backspace(); tools.backspace();
        expect(tools.points).toEqual([]); expect(tools.totalMeters).toBe(0);
        await tools.close();
        expect(docs.documents.has(doc.mapId)).toBe(true);
        expect(sources.remove).not.toHaveBeenCalledWith(doc.mapId);
        tools.ngOnDestroy(); persistence.ngOnDestroy();
    });
});
