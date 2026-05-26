/**
 * Timing information emitted by the core search engine for one traced function.
 */
export interface TraceResult {
    name: string;
    calls: bigint;
    totalus: bigint;
    values: Array<string>;
}

/**
 * Human-facing query diagnostic emitted by simfil validation or execution.
 */
export interface DiagnosticsMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number},
    fix: null | string;
}

/**
 * One autocompletion suggestion produced for the current query and cursor position.
 */
export interface CompletionCandidate {
    text: string;
    kind: string;
    begin: number;
    end: number;
    query: string;
    source: string;
    hint: string;
}
