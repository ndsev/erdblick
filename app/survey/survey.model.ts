/**
 * Configured survey banners and their deliberately small HTML vocabulary.
 * Invalid entries are omitted before the banner component receives them.
 */
import { z } from "zod";

/** One config-driven survey banner entry. */
export interface SurveyConfig {
    id: string;
    link: string;
    linkHtml: string;
    start?: string;
    end?: string;
    emoji?: string;
    background?: string;
}

export const SURVEY_CONFIG_SCHEMA = z.object({
    id: z.string().min(1),
    link: z.string().min(1),
    linkHtml: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    emoji: z.string().optional(),
    background: z.string().optional()
});

/** Server and frontend allow-list for HTML fragments allowed in survey banners. */
export function isAllowedSurveyLinkHtml(linkHtml: string): boolean {
    if (!linkHtml || linkHtml.length > 1024) {
        return false;
    }

    const lowered = linkHtml.toLowerCase();
    if (lowered.includes("javascript:") || lowered.includes("data:")) {
        return false;
    }

    const allowedOpenTags = new Set(["b", "strong", "i", "em", "small", "br"]);
    const allowedCloseTags = new Set(["b", "strong", "i", "em", "small"]);

    let cursor = 0;
    while (cursor < linkHtml.length) {
        const open = linkHtml.indexOf("<", cursor);
        if (open === -1) {
            break;
        }
        const close = linkHtml.indexOf(">", open + 1);
        if (close === -1) {
            return false;
        }

        let token = linkHtml.slice(open + 1, close).trim().toLowerCase();
        if (!token.length) {
            return false;
        }
        if (token.includes("=") || token.startsWith("!") || token.startsWith("?")) {
            return false;
        }

        if (token.startsWith("/")) {
            token = token.slice(1).trim();
            if (!token.length || /\s/.test(token) || !allowedCloseTags.has(token)) {
                return false;
            }
        } else {
            let selfClosing = false;
            if (token.endsWith("/")) {
                selfClosing = true;
                token = token.slice(0, -1).trim();
            }
            if (!token.length || /\s/.test(token) || !allowedOpenTags.has(token)) {
                return false;
            }
            if (selfClosing && token !== "br") {
                return false;
            }
        }

        cursor = close + 1;
    }

    return true;
}

/** Normalizes configured survey links. */
export function normalizeSurveys(rawSurveys: unknown[] | undefined): SurveyConfig[] {
    if (!Array.isArray(rawSurveys)) {
        return [];
    }

    const surveys: SurveyConfig[] = [];
    for (const rawSurvey of rawSurveys) {
        const parsed = SURVEY_CONFIG_SCHEMA.safeParse(rawSurvey);
        if (!parsed.success) {
            continue;
        }
        if (!isAllowedSurveyLinkHtml(parsed.data.linkHtml)) {
            continue;
        }
        surveys.push(parsed.data);
    }
    return surveys;
}
