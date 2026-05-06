import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';
import {
    StyleSourceRef,
    StyleValidationIssue,
    StyleValidationReport
} from './style-validation.model';

const MAX_STYLE_VALIDATION_ISSUES = 500;

@Injectable({providedIn: 'root'})
/** Session-local store for style validation and runtime evaluation issues. */
export class StyleValidationReportService {
    readonly reports$ = new BehaviorSubject<StyleValidationIssue[]>([]);

    recordReport(report: StyleValidationReport, sourceOverride?: Partial<StyleSourceRef>): StyleValidationReport {
        const source = {...report.source, ...sourceOverride} as StyleSourceRef;
        const issues = report.issues.map(issue => ({
            ...issue,
            source: {...issue.source, ...source},
        }));
        this.appendIssues(issues);
        return {...report, source, issues};
    }

    recordIssue(issue: StyleValidationIssue): void {
        this.appendIssues([issue]);
    }

    clearForSource(sourceRef: Partial<StyleSourceRef>): void {
        const key = this.sourceKey(sourceRef);
        this.reports$.next(this.reports$.getValue().filter(issue => this.sourceKey(issue.source) !== key));
    }

    clearRuntimeIssuesForStyle(styleNameOrHash: string): void {
        this.reports$.next(this.reports$.getValue().filter(issue => {
            if (issue.phase !== 'runtime') {
                return true;
            }
            return issue.source.styleName !== styleNameOrHash && issue.source.sourceHash !== styleNameOrHash;
        }));
    }

    clearRuntimeDuplicates(): void {
        const seen = new Set<string>();
        const result: StyleValidationIssue[] = [];
        for (const issue of this.reports$.getValue()) {
            if (issue.phase !== 'runtime') {
                result.push(issue);
                continue;
            }
            const key = [
                issue.source.styleName,
                issue.source.sourceHash,
                issue.rulePath,
                issue.property,
                issue.expression,
                issue.message,
                issue.runtimeContext?.mapName,
                issue.runtimeContext?.layerName
            ].join('|');
            if (!seen.has(key)) {
                seen.add(key);
                result.push(issue);
            }
        }
        this.reports$.next(result);
    }

    formatIssueSummary(issue: StyleValidationIssue): string {
        const source = issue.source.url || issue.source.styleName || issue.source.configId || issue.source.sourceKind;
        const path = issue.rulePath || (issue.ruleIndex !== undefined ? `rules[${issue.ruleIndex}]` : '');
        const property = issue.property ? `.${issue.property}` : '';
        const location = issue.location?.line
            ? ` line ${issue.location.line}${issue.location.column ? `:${issue.location.column}` : ''}`
            : '';
        return `Style validation: ${source}${path ? ` ${path}${property}` : ''}${location}: ${issue.message}`;
    }

    private appendIssues(issues: StyleValidationIssue[]): void {
        if (!issues.length) {
            return;
        }
        const merged = [...this.reports$.getValue(), ...issues];
        this.reports$.next(merged.slice(-MAX_STYLE_VALIDATION_ISSUES));
    }

    private sourceKey(sourceRef: Partial<StyleSourceRef>): string {
        return sourceRef.url
            || sourceRef.sourceHash
            || sourceRef.styleName
            || sourceRef.configId
            || sourceRef.sourceKind
            || '<unknown-style-source>';
    }
}
