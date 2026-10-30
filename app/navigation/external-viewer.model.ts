/**
 * External map-viewer configuration shared by loading and navigation.
 * Validate templates before offering them as omnibar or context-menu actions.
 */
import { z } from "zod";

/** One configured external map viewer shared by the context menu and search palette. */
export interface ExternalViewerConfig {
    id: string;
    name: string;
    urlTemplate: string;
}

export const EXTERNAL_VIEWER_SCHEMA = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    urlTemplate: z.string().min(1)
});

/** Validates external-viewer templates once so runtime actions only substitute coordinates. */
export function normalizeExternalViewers(rawViewers: unknown[] | undefined): ExternalViewerConfig[] {
    if (!rawViewers) {
        return [];
    }
    const viewers: ExternalViewerConfig[] = [];
    const seenIds = new Set<string>();
    rawViewers.forEach((rawViewer, index) => {
        const parsed = EXTERNAL_VIEWER_SCHEMA.safeParse(rawViewer);
        if (!parsed.success) {
            console.warn(`[ExternalViewerConfig] Ignoring invalid externalViewers entry ${index + 1}.`);
            return;
        }
        const viewer = {
            id: parsed.data.id.trim(),
            name: parsed.data.name.trim(),
            urlTemplate: parsed.data.urlTemplate.trim()
        };
        const sampleUrl = viewer.urlTemplate
            .replaceAll("{lat}", "0")
            .replaceAll("{lon}", "0");
        let protocol = "";
        try {
            protocol = new URL(sampleUrl).protocol;
        } catch {
            // The warning below also covers malformed and relative templates.
        }
        if (!viewer.id
            || !viewer.name
            || !viewer.urlTemplate.includes("{lat}")
            || !viewer.urlTemplate.includes("{lon}")
            || (protocol !== "http:" && protocol !== "https:")
            || seenIds.has(viewer.id)) {
            console.warn(
                `[ExternalViewerConfig] Ignoring external viewer '${viewer.id || index + 1}': ` +
                "expected a unique id and an HTTP(S) URL template containing {lat} and {lon}."
            );
            return;
        }
        seenIds.add(viewer.id);
        viewers.push(viewer);
    });
    return viewers;
}
