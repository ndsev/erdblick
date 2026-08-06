import type {FeatureLayerStyle, HighlightMode} from
    "../../../build/libs/core/erdblick-core";

export type DeckRgba = [number, number, number, number];

/** Resolved, expression-free material shared by local and fetched interaction overlays. */
export interface DeckInteractionEffect {
    tint?: DeckRgba;
    tintMix: number;
    opacity: number;
    edgeWidth: number;
    haloColor?: DeckRgba;
    haloRadius: number;
    haloOpacity: number;
    /** Whether semantic boundaries may cast halo into another masked object. */
    interiorHalo?: boolean;
    stripeColor?: DeckRgba;
    stripeSpacing: number;
    stripeWidth: number;
    stripeOpacity: number;
    stripeAngle: number;
    stripeOffset: number;
    stripeSoftness: number;
}

interface RawInteractionEffect {
    tint?: unknown;
    tintMix?: unknown;
    opacity?: unknown;
    edgeWidth?: unknown;
    haloColor?: unknown;
    haloRadius?: unknown;
    haloOpacity?: unknown;
    stripeColor?: unknown;
    stripeSpacing?: unknown;
    stripeWidth?: unknown;
    stripeOpacity?: unknown;
    stripeAngle?: unknown;
    stripeOffset?: unknown;
    stripeSoftness?: unknown;
}

/** Resolves literal and style-option colors through the WASM style parser. */
export function resolveDeckInteractionEffect(
    style: FeatureLayerStyle,
    mode: HighlightMode,
    options: Readonly<Record<string, boolean | number | string>>
): DeckInteractionEffect | null {
    if (!style.supportsInteractionEffect(mode)) {
        return null;
    }
    const raw = style.interactionEffect(mode, options) as
        RawInteractionEffect | undefined;
    if (!raw) {
        return null;
    }
    return {
        tint: deckRgba(raw.tint),
        tintMix: boundedNumber(raw.tintMix, 1, 0, 1),
        opacity: boundedNumber(raw.opacity, 1, 0, 1),
        edgeWidth: boundedNumber(raw.edgeWidth, 0, 0),
        haloColor: deckRgba(raw.haloColor),
        haloRadius: boundedNumber(raw.haloRadius, 0, 0),
        haloOpacity: boundedNumber(raw.haloOpacity, 0, 0, 1),
        interiorHalo: true,
        stripeColor: deckRgba(raw.stripeColor),
        stripeSpacing: boundedNumber(raw.stripeSpacing, 0, 0),
        stripeWidth: boundedNumber(raw.stripeWidth, 0, 0),
        stripeOpacity: boundedNumber(raw.stripeOpacity, 0, 0, 1),
        stripeAngle: boundedNumber(raw.stripeAngle, 45,
            Number.NEGATIVE_INFINITY),
        stripeOffset: boundedNumber(raw.stripeOffset, 0,
            Number.NEGATIVE_INFINITY),
        stripeSoftness: boundedNumber(raw.stripeSoftness, 1, 0)
    };
}

/** Applies tint and opacity without changing the source array representation. */
export function interactionColor(
    source: ArrayLike<number>,
    offset: number,
    effect: DeckInteractionEffect,
    override?: DeckRgba
): DeckRgba {
    if (override) {
        return [
            override[0],
            override[1],
            override[2],
            Math.round(override[3] * effect.opacity)
        ];
    }
    const mix = effect.tint ? effect.tintMix : 0;
    const inverse = 1 - mix;
    return [
        Math.round(Number(source[offset] ?? 0) * inverse +
            Number(effect.tint?.[0] ?? 0) * mix),
        Math.round(Number(source[offset + 1] ?? 0) * inverse +
            Number(effect.tint?.[1] ?? 0) * mix),
        Math.round(Number(source[offset + 2] ?? 0) * inverse +
            Number(effect.tint?.[2] ?? 0) * mix),
        Math.round(Number(source[offset + 3] ?? 255) * effect.opacity *
            Number(effect.tint?.[3] ?? 255) / 255)
    ];
}

function deckRgba(value: unknown): DeckRgba | undefined {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
        return undefined;
    }
    const values = Array.from(value as ArrayLike<number>);
    if (values.length < 4 || values.slice(0, 4).some(item =>
        !Number.isFinite(Number(item)))) {
        return undefined;
    }
    return values.slice(0, 4).map(item =>
        Math.max(0, Math.min(255, Math.round(Number(item))))) as DeckRgba;
}

function boundedNumber(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum = Number.POSITIVE_INFINITY
): number {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.max(minimum, Math.min(maximum, numeric))
        : fallback;
}
