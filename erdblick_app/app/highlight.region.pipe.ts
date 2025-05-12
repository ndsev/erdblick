import { Pipe, PipeTransform, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

@Pipe({
    name: 'highlightRegion'
})
export class HighlightRegion implements PipeTransform {
    constructor(private sanitizer: DomSanitizer) {}

    transform(value: string, start: number, size: number, epsilon: number): any {
        if (!value || start < 0 || size <= 0)
            return '';
        if (!epsilon || epsilon <= 0)
            epsilon = 1e6;

        const highlight = this.sanitizer.sanitize(SecurityContext.HTML, value.slice(start, Math.min(start + size, value.length)));
        const leading = value.slice(Math.max(0, start - epsilon), start);
        const trailing = value.slice(start + size, Math.min(start + size + epsilon, value.length));

        let result = leading + `<mark>${highlight}</mark>` + trailing;
        if (start - epsilon > 0)
            result = '&hellip;' + result;
        if (start + size + epsilon < value.length)
            result = result + '&hellip;';

        return this.sanitizer.bypassSecurityTrustHtml(result);
    }
}
