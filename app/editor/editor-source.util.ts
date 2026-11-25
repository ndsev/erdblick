import type {ChangeSet} from '@codemirror/state';

/** Apply normalized editor positions to exact source spans, retaining untouched mixed line endings. */
export function applySourceChanges(source: string, changes: ChangeSet): string {
    const parts: string[] = [];
    const newline = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    let normalizedOffset = 0, sourceOffset = 0, copied = 0;
    /** Convert increasing CodeMirror offsets without allocating a document-sized offset table. */
    const offset = (target: number): number => {
        while (normalizedOffset < target && sourceOffset < source.length) {
            if (source[sourceOffset] === '\r' && source[sourceOffset + 1] === '\n') ++sourceOffset;
            ++sourceOffset; ++normalizedOffset;
        }
        return sourceOffset;
    };
    changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
        const start = offset(from), end = offset(to);
        parts.push(source.slice(copied, start), inserted.sliceString(0, inserted.length, newline));
        copied = end;
    });
    parts.push(source.slice(copied));
    return parts.join('');
}
