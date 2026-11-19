import {describe, expect, it, vi} from 'vitest';
import {DrawingLayer} from '../../../../app/mapview/deck/drawing.layer';
import {ErdblickVectorLayer} from '../../../../app/mapview/deck/erdblick-vector.layer';

describe('Drawing scene publication', () => {
    it('notifies nested vector shells when material buffers arrive after initialization', () => {
        const layer = new DrawingLayer({id: 'drawing', scene: {} as never, flattenZ: false, drawingPass: 'geometry',
            disabledPickIndices: new Set(), drillPickEligible: true, navigationAnchorEligible: false});
        const vector = Object.create(ErdblickVectorLayer.prototype) as ErdblickVectorLayer;
        const changed = vi.spyOn(vector, 'sceneChanged').mockImplementation(() => {});
        vi.spyOn(layer, 'getSubLayers').mockReturnValue([vector]);
        layer.sceneChanged();
        expect(changed).toHaveBeenCalledOnce();
    });
});
