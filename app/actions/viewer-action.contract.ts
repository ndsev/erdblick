/** Serialization rules for the native catalog boundary; no application composition lives here. */
export { VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT } from "./app-action";
export { viewerJsonSchema } from "./control-actions";

/** Canonical contract bytes: sorted object keys, ordered arrays, ECMAScript JSON scalars. */
export function canonicalViewerContractJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
        ).join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
