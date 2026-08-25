import type {FeatureSearchStateEntry} from "../shared/feature-search-state";

/** Fully resolved definition shared by list ingestion and styled subset rendering. */
export interface FeatureSearchResolvedDefinition extends FeatureSearchStateEntry {
    concreteScope: "feature" | "attribute";
    backendQuery: string;
    resultFields: string[];
}

/** Extracts server-side result expressions needed by search list and style evaluation. */
export function featureSearchResultFields(
    definition: FeatureSearchStateEntry,
    concreteScope: "feature" | "attribute"
): string[] {
    const fields = new Set<string>();
    if (concreteScope === "attribute") {
        fields.add("$name");
    }
    for (const rule of definition.searchStyleRules ?? []) {
        for (const filter of rule.filter ?? []) {
            if (filter.field?.trim()) {
                fields.add(filter.field.trim());
            }
        }
        const color = rule.color;
        if ((color.mode === "gradient" || color.mode === "categories") &&
            color.field.trim()) {
            fields.add(color.field.trim());
        }
        if (rule.geometry.length === 1 && rule.geometry[0] === "label" && rule.labelExpression?.trim()) {
            fields.add(rule.labelExpression.trim());
        }
    }
    return Array.from(fields).sort();
}
