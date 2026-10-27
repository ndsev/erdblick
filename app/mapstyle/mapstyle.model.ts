/**
 * Built-in stylesheet bundle declarations supplied by deployment configuration.
 * Parsing is independent of the style controller and never loads a stylesheet.
 */
import { z } from "zod";

/** One built-in style bundle entry declared in `config.json`. */
export interface StyleConfigEntry {
    id?: string;
    url: string;
    additional?: boolean;
}

export const STYLE_CONFIG_ENTRY_SCHEMA = z.object({
    id: z.string().optional(),
    url: z.string().min(1),
    additional: z.boolean().optional()
});

/** Normalizes configured style entries. */
export function normalizeStyles(styles: Array<StyleConfigEntry | string> | undefined, additional: boolean): StyleConfigEntry[] {
    if (!Array.isArray(styles)) {
        return [];
    }

    const normalized: StyleConfigEntry[] = [];
    for (const entry of styles) {
        const parsed = STYLE_CONFIG_ENTRY_SCHEMA.safeParse(
            typeof entry === "string" ? { url: entry } : entry
        );
        if (!parsed.success) {
            continue;
        }
        normalized.push({
            ...parsed.data,
            additional
        });
    }
    return normalized;
}
