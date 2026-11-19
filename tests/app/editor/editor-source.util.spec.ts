import {describe, expect, it} from 'vitest';
import {EditorState} from '@codemirror/state';
import {applySourceChanges} from '../../../app/editor/editor-source.util';

describe('Exact source editing', () => {
    it('preserves untouched mixed endings and Unicode around normalized editor changes', () => {
        const source = '\ufeffa😀\r\nb\nc\rd\r\n';
        const state = EditorState.create({doc: source});
        const update = state.update({changes: [{from: 5, to: 6, insert: 'β'}, {from: 9, to: 10, insert: 'δ\nnew'}]});
        expect(applySourceChanges(source, update.changes)).toBe('\ufeffa😀\r\nβ\nc\rδ\r\nnew\r\n');
    });
    it('uses the original newline convention for newly inserted lines and retains the BOM', () => {
        const source = '\ufeff0 0 "café"\r\n';
        const state = EditorState.create({doc: source});
        const update = state.update({changes: {from: state.doc.length, insert: '1 1 next\n'}});
        expect(applySourceChanges(source, update.changes)).toBe(source + '1 1 next\r\n');
    });
});
