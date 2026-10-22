import { z } from "zod";
import { boundedUnicodeString, unicodePrefix } from "../shared/unicode-string";
import { ViewerActionError, ViewerActionFailure } from "./viewer-action-relay.contract";

/** Explicit action metadata. Registration never exposes an owner's other methods. */
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
    icon: string;
    iconType?: "prime" | "material";
    color: string;
    enabled: boolean;
    acceptsEmptyInput?: boolean;
    saveToHistory?: boolean;
    payload?: unknown;
    input: Input;
}

/** History is resolved again by the owning producer; saved callbacks are never replayed. */
export interface ActionCandidateHistory {
    id: string;
    payload?: unknown;
}

export interface RegisteredActionCandidate extends AppActionCandidate {
    action: string;
}

/** A public typed reader/writer, separate from internal persisted AppState values. */
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
export const VIEWER_ACTION_INVOCATION_BYTES = 64 * 1024;
export const VIEWER_ACTION_RESULT_BYTES = 256 * 1024;
export const VIEWER_ACTION_TARGET_LIMIT = 32;

export type ActionInput<Action extends AppAction> = z.infer<Action["inputSchema"]>;
export type ActionOutput<Action extends AppAction> = z.infer<Action["outputSchema"]>;
export type ControlSelector<Control extends AppControl> = z.infer<Control["selectorSchema"]>;
export type ControlValue<Control extends AppControl> = z.infer<Control["valueSchema"]>;

type GroupValue<Group> = Group extends Record<string, infer Value> ? Value : never;

/**
 * Compose named owner declarations without losing their input/output types.
 * Check before indexing: object spreads would silently hide duplicate wire names
 * from the build exporter, even though runtime registration later rejects them.
 */
export function composeDeclarations<const Groups extends readonly Record<string, { readonly name: string }>[]>(
    ...groups: Groups
): { [Declaration in GroupValue<Groups[number]> as Declaration["name"]]: Declaration } {
    const declarations = new Map<string, { readonly name: string }>();
    for (const group of groups) {
        for (const declaration of Object.values(group)) {
            if (declarations.has(declaration.name)) {
                throw new Error(`Duplicate declaration: ${declaration.name}`);
            }
            declarations.set(declaration.name, declaration);
        }
    }
    return Object.fromEntries(declarations) as {
        [Declaration in GroupValue<Groups[number]> as Declaration["name"]]: Declaration
    };
}

/** Stable boundary failures reveal no submitted values or private configuration. */
export function rejectAction(message: string, code: ViewerActionError["code"] = "not_available", reason?: string): never {
    throw new ViewerActionFailure({ code, message, reason, outcome: "not_applied" });
}

export function applied(changed = true) { return { status: "applied" as const, changed }; }

export function jsonByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Bounds iteration and serialization before copying a collection. */
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

/** Shared pagination for owner-specific discovery; the owner supplies only public metadata. */
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

/** One requested control's bounds and omission reason; no domain state is held here. */
export class ControlReadContext {
    reason?: "item_limit" | "byte_limit" | "text_limit";
    constructor(readonly byteLimit: number) { }

    collect<T>(source: Iterable<T>, byteLimit = this.byteLimit): T[] {
        const result = boundedCollection(source, 100, Math.min(byteLimit, this.byteLimit - 512));
        this.reason ??= result.reason;
        return result.items;
    }

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

export function discoveryResult<Item extends z.ZodType>(item: Item) {
    return z.strictObject({
        observedAt: z.string(), items: z.array(item).max(100), complete: z.boolean(),
        reason: z.enum(["item_limit", "byte_limit"]).optional(), nextOffset: indexSchema.optional()
    });
}
