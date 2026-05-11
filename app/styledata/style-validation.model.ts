export type StyleValidationSeverity = 'info' | 'warning' | 'error';
export type StyleValidationPhase = 'fetch' | 'yaml' | 'schema' | 'simfil' | 'runtime';
export type StyleValidationImpact =
    | 'stylesheet-failed'
    | 'rule-skipped'
    | 'property-fallback'
    | 'option-skipped'
    | 'runtime-sample-skipped';

export type StyleSourceKind = 'base' | 'additional' | 'imported' | 'modified-builtin' | 'editor';

export interface StyleSourceRef {
    configId?: string;
    styleName?: string;
    url?: string;
    sourceKind: StyleSourceKind;
    sourceHash?: string;
}

export interface StyleSourceLocation {
    line?: number;
    column?: number;
    offset?: number;
    length?: number;
}

export interface StyleValidationIssue {
    id: string;
    at: number;
    severity: StyleValidationSeverity;
    phase: StyleValidationPhase;
    impact: StyleValidationImpact;
    source: StyleSourceRef;
    message: string;
    detail?: string;
    ruleIndex?: number;
    rulePath?: string;
    property?: string;
    expression?: string;
    location?: StyleSourceLocation;
    runtimeContext?: {
        mapName?: string;
        layerName?: string;
        tileKey?: string;
        featureId?: string;
        renderPath?: 'main-thread' | 'worker';
    };
}

export interface StyleValidationReport {
    source: StyleSourceRef;
    valid: boolean;
    loadable: boolean;
    loadedRuleCount: number;
    skippedRuleCount: number;
    failedWholeStyleSheet: boolean;
    issues: StyleValidationIssue[];
}
