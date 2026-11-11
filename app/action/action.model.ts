/**
 * Shared value contracts for the application's action and control surface.
 * Controllers declare their schemas beside the callbacks that perform the work;
 * the registry uses these shapes to validate MCP calls and omnibar selections.
 * A control is an explicitly exposed reader/writer, not an automatic projection
 * of every persisted AppState. Each pairs a public value schema with registered
 * callbacks. Shared request/result limits and value checks live here too.
 */
import { z } from "zod";
import { boundedUnicodeString, unicodePrefix } from "../utils/unicode-string.util";
import { ViewerActionError, ViewerActionFailure } from "./viewer-action-relay.contract";

/**
 * Explicit action metadata: its public description, mutation policy and argument/
 * result schemas. Registration never exposes an owner's other methods.
 */
export interface AppAction<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
    readonly name: string;
    readonly description: string;
    readonly mutation: boolean;

    /** Omitted means public MCP and optional omnibar exposure. Local producers opt out explicitly. */
    readonly exposure?: "omnibar";
    readonly inputSchema: Input;
    readonly outputSchema: Output;
}

/**
 * A live owner-produced omnibar choice carries typed action arguments and presentation.
 * Dispatch validates those arguments against the declaration immediately before
 * execution; the owner revalidates any captured identity or lifetime.
 */
export interface AppActionCandidate<Input = unknown> {
    id: string;
    name: string;
    label: string;
    bubbles?: AppActionBubble[];
    icon: string;
    iconType?: "prime" | "material";
    color: string;
    enabled: boolean;
    acceptsEmptyInput?: boolean;
    saveToHistory?: boolean;
    payload?: unknown;
    input: Input;
}

/**
 * Compact omnibar information: a named argument, a location source or a parse
 * error. A named bubble without a value shows a placeholder while typing.
 * Execution uses the candidate's typed input, independently of these labels.
 */
export interface AppActionBubble {
    name?: string;
    value?: string | number;
    optional?: boolean;
    tone?: "error";
}

/**
 * History is resolved again by the owning producer using its saved identity and
 * payload; saved callbacks are never replayed.
 */
export interface ActionCandidateHistory {
    id: string;
    payload?: unknown;
}

export interface RegisteredActionCandidate extends AppActionCandidate {
    action: string;
}

/**
 * A public typed reader/writer, separate from internal persisted AppState values.
 * Declares selector/value schemas and persistence/synchronization policy.
 */
export interface AppControl<Selector extends z.ZodObject = z.ZodObject, Value extends z.ZodType = z.ZodType> {
    readonly name: string;
    readonly description: string;
    readonly selectorSchema: Selector;
    readonly valueSchema: Value;
    readonly readable: boolean;
    readonly writable: boolean;
    readonly persistence: "runtime-summary" | "url-and-local-storage" | "local-storage" | "mixed";
    readonly synchronization: "none" | "follow-view-sync" | "focus-target-and-follow-view-sync";
}

export const indexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const identifierSchema = boundedUnicodeString(4096, true);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Application caps on encoded JSON arguments/results. The relay and local WebMCP
// adapter use the same limits; result producers reserve space for reply metadata.
export const VIEWER_ACTION_INVOCATION_BYTES = 64 * 1024;
export const VIEWER_ACTION_RESULT_BYTES = 256 * 1024;

// Bound the number of control reads included in one overview response.
export const VIEWER_ACTION_TARGET_LIMIT = 32;


/** Reject an action before applying it, using a caller-facing message and structured error code. */
export function rejectAction(message: string, code: ViewerActionError["code"] = "not_available", reason?: string): never {
    throw new ViewerActionFailure({ code, message, reason, outcome: "not_applied" });
}

/** Report a completed assignment and whether it changed the current value. */
export function applied(changed = true) { return { status: "applied" as const, changed }; }

/** Measure the UTF-8 encoding of a JSON value for the action response limit. */
export function jsonByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Collect an iterable until the item count or estimated JSON-array byte cap is reached.
 * Return the accepted prefix with complete=false and the limiting reason. Each
 * candidate is serialized to measure it; the cap bounds returned data, while the
 * iterator's work and an individual candidate's temporary encoding remain unbounded.
 */
export function boundedCollection<T>(source: Iterable<T>, limit = 100, byteLimit = 180000): {
    items: T[]; complete: boolean; reason?: "item_limit" | "byte_limit"
} {
    const items: T[] = [];
    let bytes = 2;

    for (const item of source) {
        if (items.length >= limit) return { items, complete: false, reason: "item_limit" };
        const size = jsonByteLength(item) + 1;
        if (bytes + size > byteLimit) return { items, complete: false, reason: "byte_limit" };
        items.push(item);
        bytes += size;
    }

    return { items, complete: true };
}

/**
 * Skip offset items and return a bounded page of public discovery metadata.
 * A nonempty truncated page includes nextOffset; an item too large to fit can
 * produce an empty incomplete page without a continuation. For stable ordering,
 * callers must supply an iterable whose order is consistent between requests.
 */
export function catalogPage<T>(source: Iterable<T>, input: { offset?: number; limit?: number }) {
    const offset = input.offset ?? 0;
    function* page() {
        let skipped = 0;
        for (const item of source) {
            if (skipped++ < offset) continue;
            yield item;
        }
    }
    const result = boundedCollection(page(), input.limit);
    return {
        observedAt: new Date().toISOString(), ...result,
        ...(!result.complete && result.items.length ? { nextOffset: offset + result.items.length } : {})
    };
}

/**
 * Per-control read limits and the first reason its returned value was shortened;
 * no domain state is held here.
 */
export class ControlReadContext {
    reason?: "item_limit" | "byte_limit" | "text_limit";
    constructor(readonly byteLimit: number) { }

    /** Collect up to 100 entries, reserving 512 bytes for the enclosing control result. */
    collect<T>(source: Iterable<T>, byteLimit = this.byteLimit): T[] {
        const result = boundedCollection(source, 100, Math.min(byteLimit, this.byteLimit - 512));
        this.reason ??= result.reason;
        return result.items;
    }

    /** Return a Unicode prefix and record text_limit when the original text was longer. */
    text(value: string, limit = 4096): string {
        const bounded = unicodePrefix(value, limit);
        if (bounded !== value) this.reason ??= "text_limit";
        return bounded;
    }
}

export const discoveryPageShape = {
    offset: indexSchema.max(100000).optional(),
    limit: z.number().int().min(1).max(100).optional()
};

/** Build the result schema shared by timestamped, bounded discovery pages. */
export function discoveryResult<Item extends z.ZodType>(item: Item) {
    return z.strictObject({
        observedAt: z.string(), items: z.array(item).max(100), complete: z.boolean(),
        reason: z.enum(["item_limit", "byte_limit"]).optional(), nextOffset: indexSchema.optional()
    });
}
