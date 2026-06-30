/** Converts inspection numeric values to Simfil numeric literals without quoting integer BigInts. */
export function inspectionSearchNumberLiteral(value: unknown): string | undefined {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed) &&
        Number.isFinite(Number(trimmed))
        ? trimmed
        : undefined;
}
