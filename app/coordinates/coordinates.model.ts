/**
 * Coordinate-panel deployment defaults and the optional legal-terms document.
 * The configuration loader fetches the document; CoordinatesPolicyService
 * decides whether coordinates can be shown after the user accepts its terms.
 */
import { z } from "zod";

/** Normalized coordinate-panel defaults and optional legal text. */
export interface CoordinatesConfig {
    enabledByDefault: boolean;
    legalTermsUrl: string | null;
    legalTerms: string | null;
    legalTermsError: string | null;
}

export const COORDINATES_LEGAL_TERMS_SCHEMA = z.object({
    "legal-terms": z.string().refine(value => value.trim().length > 0)
});

/** A configured terms document requires consent even when coordinates are enabled by default. */
export function normalizeCoordinatesConfig(enabled: boolean | undefined, termsUrl: string | undefined): CoordinatesConfig {
    const legalTermsUrl = termsUrl?.trim() || null;
    return {
        enabledByDefault: legalTermsUrl ? false : enabled ?? true,
        legalTermsUrl,
        legalTerms: null,
        legalTermsError: null
    };
}
