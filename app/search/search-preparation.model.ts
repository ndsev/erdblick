/**
 * Confirmed input is prepared against immutable schemas before it can become
 * an executable search. These values cross the worker boundary and are also
 * exposed to MCP; they contain no service or native-object references.
 */
import {z} from "zod";
import type {FeatureSearchStyleRule} from "./search-definition.model";

const attributeOwnerSchema = z.object({
    mapId: z.string(),
    layerId: z.string(),
    featureType: z.string(),
    attrName: z.string(),
    attrLayerName: z.string(),
    queriedPaths: z.array(z.string()).optional()
});

/**
 * A temporary execution plan for one source. `expression` is the portable
 * query shown in the editor; `query` evaluates it at this branch's result
 * root. The artifact ID invalidates stale plans without qualifying the saved
 * expression or preventing preparation against another map's schema.
 */
export const preparedSearchBranchSchema = z.object({
    id: z.string().max(4096),
    label: z.string(),
    kind: z.enum(["attribute", "enum", "field", "expression"]),
    symbol: z.string().optional(),
    mapId: z.string(),
    layerId: z.string(),
    schemaId: z.string(),
    scope: z.enum(["feature", "attribute"]),
    expression: z.string(),
    query: z.string(),
    featureTypes: z.array(z.string()),
    attributeScopes: z.array(attributeOwnerSchema),
    matchedFieldNames: z.array(z.string()).optional(),
    matchedEnumValues: z.array(z.string()).optional()
});

export type PreparedSearchBranch = z.infer<typeof preparedSearchBranchSchema>;

/** Repeated occurrences of one meaning are presented as one choice. */
export interface SearchInterpretation {
    id: string;
    label: string;
    kind: PreparedSearchBranch["kind"];
    /** The exact query the user accepts, edits and can reuse on other maps. */
    query: string;
    branches: PreparedSearchBranch[];
}

/** The only ready search contains both resolved membership and its initial style. */
export interface SearchPreparation {
    signature: string;
    status: "preparing" | "waiting-for-schema" | "needs-choice" | "ready" | "invalid";
    /** Distinguishes schema interpretation from the subsequent initial-style calculation. */
    phase?: "interpretation" | "style";
    interpretations: SearchInterpretation[];
    selectedIds: string[];
    branches: PreparedSearchBranch[];
    initialStyles: FeatureSearchStyleRule[];
    error?: string;
}
