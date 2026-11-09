import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'highlight',
    standalone: false
})
/** Highlights all literal matches of the current filter text in a tree cell. */
export class HighlightSearch implements PipeTransform {
    /** Preserve falsy/object values; stringify other primitives and mark case-insensitive matches. */
    transform(value: any, args: any): any {
        if (!args || !value || typeof value === 'object') {
            return value;
        }

        const re = new RegExp(String(args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return String(value).replace(re, '<mark>$&</mark>');
    }
}
