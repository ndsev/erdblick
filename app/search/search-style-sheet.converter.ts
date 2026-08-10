import {dump} from "js-yaml";

import {SearchStyleConfigurationV1} from "../shared/search-style-configuration-state";
import {buildFeatureSearchSyntheticRule} from "./feature-search-style";

const SUPPORTED_SEARCH_STYLE_OPERATORS = new Set(["=", "!=", "<", "<=", ">", ">=", "contains"]);

export interface GeneratedSearchStyleSheet {
    configurationId: string;
    configurationRevision: number;
    styleId: string;
    filename: string;
    source: string;
}

/** Raised when canonical conversion would otherwise silently change unsupported rule data. */
export class SearchStyleConversionError extends Error {
    constructor(readonly issues: string[]) {
        super(issues.join(" "));
        this.name = "SearchStyleConversionError";
    }
}

/** Converts one reusable JSON configuration into its deterministic native YAML projection. */
export function convertSearchStyleConfigurationToYaml(
    configuration: SearchStyleConfigurationV1
): GeneratedSearchStyleSheet {
    assertCanonicalSearchStyleRules(configuration);
    const styleId = canonicalSearchStyleId(configuration);
    const document = {
        name: styleId,
        version: 2,
        default: false,
        rules: [buildFeatureSearchSyntheticRule(configuration.rules, "feature", false)]
    };
    return {
        configurationId: configuration.id,
        configurationRevision: configuration.revision,
        styleId,
        filename: canonicalSearchStyleFilename(configuration),
        source: dump(document, {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        })
    };
}

/** Returns the stable native stylesheet name for a saved search configuration. */
export function canonicalSearchStyleId(configuration: Pick<SearchStyleConfigurationV1, "id" | "name">): string {
    return `Search Styles/${configuration.name}/${shortConfigurationId(configuration.id)}`;
}

/** Returns the deterministic export filename independently of conversion success. */
export function canonicalSearchStyleFilename(
    configuration: Pick<SearchStyleConfigurationV1, "id" | "name">
): string {
    return `${fileSafeName(configuration.name)}-${shortConfigurationId(configuration.id)}.yaml`;
}

/** Rejects values that the shared runtime builder would have to coerce or silently disable. */
function assertCanonicalSearchStyleRules(configuration: SearchStyleConfigurationV1): void {
    const issues: string[] = [];
    configuration.rules.forEach((rule, ruleIndex) => {
        rule.filter.forEach((filter, filterIndex) => {
            const path = `Rule ${ruleIndex + 1}, filter ${filterIndex + 1}`;
            if (!filter.customExpression && !SUPPORTED_SEARCH_STYLE_OPERATORS.has(filter.op)) {
                issues.push(`${path} uses unsupported operator “${filter.op}”.`);
            }
            if (!filter.customExpression && !isSearchStyleScalar(filter.value)) {
                issues.push(`${path} has a non-scalar comparison value.`);
            }
        });
        if (rule.color.mode === "gradient") {
            rule.color.stops.forEach((stop, stopIndex) => {
                if (typeof stop.value !== "number" || !Number.isFinite(stop.value)) {
                    issues.push(`Rule ${ruleIndex + 1}, gradient stop ${stopIndex + 1} must have a finite numeric value.`);
                }
            });
        } else if (rule.color.mode === "categories") {
            rule.color.stops.forEach((stop, stopIndex) => {
                if (!isSearchStyleScalar(stop.value)) {
                    issues.push(`Rule ${ruleIndex + 1}, category stop ${stopIndex + 1} has a non-scalar value.`);
                }
            });
        }
    });
    if (issues.length) {
        throw new SearchStyleConversionError(issues);
    }
}

function isSearchStyleScalar(value: unknown): value is string | number | boolean | null {
    return value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value));
}

function shortConfigurationId(id: string): string {
    const compact = id.replace(/^search_style_/, "").replace(/[^a-zA-Z0-9]/g, "");
    return (compact || "style").slice(0, 12);
}

function fileSafeName(name: string): string {
    const result = name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return result || "search-style";
}
