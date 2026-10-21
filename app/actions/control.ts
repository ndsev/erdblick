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
