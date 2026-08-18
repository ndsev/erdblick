/** Minimal identity used to assign a stable inspection value-bubble presentation. */
export interface InspectionValueBubblePresentationSource {
    kind?: unknown;
    colorKey?: unknown;
    label?: unknown;
}

/** User-controlled discriminators shared by inspection and hover value bubbles. */
export interface InspectionValueBubblePresentationOptions {
    varyColors: boolean;
    varyOutlines: boolean;
    varyStriping: boolean;
}

const NON_VALIDITY_OUTLINES = [0, 1, 2, 3, 4, 5, 7];

/**
 * Returns the stable kind, palette, outline, and stripe classes for a value bubble.
 * The source key is deliberately independent from its display label so aliases do
 * not reshuffle the presentation.
 */
export function inspectionValueBubbleClasses(
    source: InspectionValueBubblePresentationSource,
    options: InspectionValueBubblePresentationOptions
): Record<string, boolean> {
    const kind = typeof source.kind === "string" && source.kind.length
        ? source.kind
        : "scalar";
    const classes: Record<string, boolean> = {
        [`inspection-value-bubble-${kind}`]: true
    };
    const hash = valueBubbleHash(source);
    if (options.varyColors) {
        classes[`inspection-value-bubble-color-${hash % 10}`] = true;
    }
    if (options.varyOutlines) {
        const outline = kind.startsWith("validity")
            ? 6
            : NON_VALIDITY_OUTLINES[Math.floor(hash / 10) % NON_VALIDITY_OUTLINES.length];
        classes[`inspection-value-bubble-outline-${outline}`] = true;
    }
    if (options.varyStriping) {
        classes[`inspection-value-bubble-stripe-${Math.floor(hash / 80) % 5}`] = true;
    }
    return classes;
}

/** Hashes the stable source identity with the same compact string hash used by the inspection tree. */
function valueBubbleHash(source: InspectionValueBubblePresentationSource): number {
    const key = `${source.colorKey ?? source.label ?? ""}`;
    let hash = 0;
    for (let index = 0; index < key.length; ++index) {
        hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
}
