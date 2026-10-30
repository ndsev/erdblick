import {z} from "zod";

/** Bundled terms are versioned independently of deployment configuration. */
export const LOCATION_BOUNDARY_TERMS_REVISION = "1";
export const LOCATION_BOUNDARY_DISCLAIMER =
    "Location boundaries and place names reflect the source dataset and may be disputed or differ from other sources. " +
    "Their display does not imply recognition or endorsement of any territorial claim. " +
    "The highlighted areas are provided for navigation and visual context, not as authoritative boundary definitions.";

/** Matches the attribution supplied by mapget for built-in location results. */
export const WOF_LOCATION_ATTRIBUTION = {
    name: "Who's On First",
    url: "https://whosonfirst.org/",
    licenseUrl: "https://whosonfirst.org/docs/licenses/"
} as const;

export const locationBoundaryConsentSchema = z.object({
    decision: z.enum(["unseen", "disabled", "accepted"]),
    revision: z.string()
});
export type LocationBoundaryConsent = z.infer<typeof locationBoundaryConsentSchema>;

/** Only an explicit acceptance of the bundled revision enables boundaries. */
export function locationBoundaryConsentAccepted(consent: LocationBoundaryConsent): boolean {
    return consent.decision === "accepted" && consent.revision === LOCATION_BOUNDARY_TERMS_REVISION;
}
