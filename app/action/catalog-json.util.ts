/**
 * Canonical catalog bytes shared by the Node exporter and native-compatibility
 * tests. Mapget fingerprints this exact representation: object keys are sorted,
 * array order is retained, and scalars use ECMAScript JSON spelling. Reject values
 * which JSON would silently omit or turn into null rather than hash a different
 * contract. This function contains no action definitions or runtime composition.
 */
export function canonicalViewerContractJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        const fields = Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
        );
        return `{${fields.join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
