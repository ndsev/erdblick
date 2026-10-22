import type {z} from "zod";
import {unicodePrefix} from "../shared/unicode-string";
import {collectActionItems} from "./action-utils";

/** A public control is an explicit owner interface, not a discoverable stored slot. */
export interface ControlDeclaration<Selector extends z.ZodObject = z.ZodObject, Value extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    selectorSchema: Selector;
    valueSchema: Value;
    readable: boolean;
    writable: boolean;
    persistence: "runtime-summary" | "url-and-local-storage" | "local-storage" | "mixed";
    synchronization: "none" | "follow-view-sync" | "focus-target-and-follow-view-sync";
}

const controlMetadata = Symbol("viewer control");

/**
 * A control describes a deliberate public projection, such as a view's camera or
 * inspection preferences. It owns no state: its reader and setter use the same
 * feature operations as the UI. Persistence codecs are a separate representation.
 */
export interface Control {
    readonly [controlMetadata]: true;
    readonly declaration: ControlDeclaration;
    read(selector: unknown, context: ControlReadContext): unknown;
    readonly write?: (selector: unknown, value: unknown) => void;
    readonly overview?: () => Record<string, unknown>[];
}

/**
 * Declare the schema beside the projection it validates. A store feature exposes
 * this as a property through withProps; the catalog discovers it automatically.
 * Readers receive a copy budget so large searches and inspections stay bounded.
 */
export function control<Selector extends z.ZodObject, Value extends z.ZodType>(
    declaration: ControlDeclaration<Selector, Value>,
    binding: {
        read: (selector: z.output<Selector>, context: ControlReadContext) => z.input<Value>;
        write?: (selector: z.output<Selector>, value: z.output<Value>) => void;
        overview?: () => z.input<Selector>[];
    }
): Control {
    if (declaration.writable !== !!binding.write) {
        throw new Error(`Control write contract mismatch: ${declaration.name}`);
    }
    const write = binding.write;
    return {
        [controlMetadata]: true,
        declaration,
        read: (selector, context) => binding.read(declaration.selectorSchema.parse(selector), context),
        write: write
            ? (selector, value) => write(declaration.selectorSchema.parse(selector), declaration.valueSchema.parse(value))
            : undefined,
        overview: binding.overview
    };
}

/** Recognize only explicitly declared controls, without inspecting application values. */
export function isControl(value: unknown): value is Control {
    return !!value && typeof value === "object" && controlMetadata in value;
}

/** Each read has its own copying/text budget; owners stop iteration before large data is materialized. */
export class ControlReadContext {
    reason?: "item_limit" | "byte_limit" | "text_limit";
    constructor(readonly budget = 180000) {}
    items<T>(source: Iterable<T>, bytes = this.budget): T[] {
        const result = collectActionItems(source, 100, Math.min(bytes, this.budget));
        this.reason ??= result.reason;
        return result.items;
    }
    text(value: string, limit = 4096): string {
        const bounded = unicodePrefix(value, limit);
        if (bounded !== value) this.reason ??= "text_limit";
        return bounded;
    }
}
