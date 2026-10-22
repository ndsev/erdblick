import {ViewerActionFailure, type ViewerActionError} from "./viewer-action-relay.contract";

/** Public failures omit supplied arguments and preserve the relay's stable error categories. */
export function rejectAction(
    message: string,
    code: ViewerActionError["code"] = "not_available",
    reason?: string
): never {
    throw new ViewerActionFailure({code, message, reason, outcome: "not_applied"});
}

/** Acknowledges synchronous owner work, not asynchronous loading or rendering. */
export function appliedAction(changed = true) {
    return {status: "applied" as const, changed};
}

/** Stops before copying or serializing an unbounded collection. */
export function collectActionItems<T>(
    source: Iterable<T>,
    limit = 100,
    byteLimit = 180000
): {
    items: T[];
    complete: boolean;
    reason?: "item_limit" | "byte_limit";
} {
    const items: T[] = [];
    const encoder = new TextEncoder();
    let bytes = 2;
    for (const item of source) {
        if (items.length >= limit) return {items, complete: false, reason: "item_limit"};
        const size = encoder.encode(JSON.stringify(item)).length + 1;
        if (bytes + size > byteLimit) return {items, complete: false, reason: "byte_limit"};
        items.push(item);
        bytes += size;
    }
    return {items, complete: true};
}

/** Pages a lazy metadata source, retaining the same bounded copy contract on every page. */
export function pageActionItems<T>(source: Iterable<T>, offset = 0, limit = 100) {
    const page = function* () {
        let index = 0;
        for (const item of source) if (index++ >= offset) yield item;
    };
    const result = collectActionItems(page(), limit);
    return {
        observedAt: new Date().toISOString(),
        ...result,
        ...(!result.complete && result.items.length ? {nextOffset: offset + result.items.length} : {})
    };
}
