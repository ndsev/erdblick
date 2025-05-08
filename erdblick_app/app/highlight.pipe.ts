import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'highlight',
    standalone: false
})
export class HighlightSearch implements PipeTransform {
    transform(value: any, args: any): any {
        if (!args || !value || typeof value === 'object') {
            return value;
        }

        const re = new RegExp(String(args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return String(value).replace(re, '<mark>$&</mark>');
    }
}
