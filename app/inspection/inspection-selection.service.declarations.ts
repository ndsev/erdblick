import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {identifierSchema, indexSchema, colorSchema} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";

const count = indexSchema;

const inspectionTargetFields = {
    attributeIndex: count.optional().describe("Observed attribute index on the base feature; mutually exclusive with relationIndex and an ID suffix."),
    relationIndex: count.optional().describe("Observed relation index on the base feature; mutually exclusive with attributeIndex and an ID suffix."),
    validityIndex: count.optional().describe("Observed validity index; requires attributeIndex or relationIndex. For a relation, addresses targetValidity, not sourceValidity. Omit to select the whole attribute/relation.")
};

export const featureIdentitySchema = z.union([
    z.strictObject({...inspectionTargetFields, mapTileKey: identifierSchema, featureId: identifierSchema.describe("Full feature ID, including its feature-type prefix; copy an observed ID, not only its numeric parts.")}),
    z.strictObject({...inspectionTargetFields, mapId: identifierSchema, layerId: identifierSchema.optional(), featureId: identifierSchema.describe("Full feature ID beginning with its exact feature type, with source-specific ID parts separated by dots.")})
]);

export const inspectionActions = {
    inspect: {name: "viewer_inspect", 
        description: "Open feature/entity inspections in the ordinary UI. For an attribute validity, copy the base featureId plus attributeIndex and validityIndex from native extraction or search results. relationIndex similarly addresses a relation. Existing suffixed IDs remain supported; do not combine a suffix with numeric selectors. Returns panel IDs immediately; loading remains observable via app.selections. panelId must address an unlocked feature panel; newPanel opens one grouped panel. To distinguish groups (e.g. predecessors versus successors), call separately with newPanel:true and different color values. color requires newPanel:true and colors only that new panel. lock=true pins the resulting panels. Use mapget extraction for model content.",
        mutation: true,
        inputSchema: z.strictObject({features: z.array(featureIdentitySchema).min(1).max(50), lock: z.boolean().optional(),
            panelId: indexSchema.optional(), newPanel: z.boolean().optional(), color: colorSchema.optional()}),
        outputSchema: z.strictObject({status: z.literal("applied"), panelIds: z.array(indexSchema).max(50),
            features: z.array(z.strictObject({mapTileKey: identifierSchema, featureId: identifierSchema})).max(50), ...{complete: z.boolean(), reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional()}})
    },
    openSourceData: {name: "viewer_open_source_data", 
        description: "Open a source-data inspection at a lossless uint64 address. Use a native SourceData mapTileKey, or map/partition and a mapget-native source reference returned by extraction. The existing panel owns loading and reveals the reference.",
        mutation: true,
        inputSchema: z.strictObject({source: z.union([
            z.strictObject({mapTileKey: identifierSchema, address: z.string().regex(/^[0-9]+$/).max(20).optional()}),
            z.strictObject({mapId: identifierSchema, partition: z.union([
                z.strictObject({kind: z.literal("tile"), id: z.number().int().min(-2147483648).max(2147483647)}),
                z.strictObject({kind: z.literal("object"), id: z.string().regex(/^(0|[1-9][0-9]*)$/).max(20)})
            ]), reference: z.strictObject({layerId: identifierSchema, address: z.string().regex(/^[0-9]+$/).max(20), qualifier: boundedUnicodeString(4096).optional()})})
        ]), newPanel: z.boolean().optional()}),
        outputSchema: z.strictObject({status: z.literal("applied"), panelId: indexSchema, mapTileKey: identifierSchema})
    }
} as const;

/** Public controls registered by this service; internal slots remain private to persistence. */
export const inspectionControls = {
    selections: {
        name: "app.selections",
        
        description: "Inspection identities and panel/loading state, including undocked panels; never inspection trees.",
        selectorSchema: z.strictObject({panelId: indexSchema.optional()}),
        valueSchema: z.array(z.strictObject({
    panelId: indexSchema,
    locked: z.boolean(),
    undocked: z.boolean(),
    loading: z.boolean().nullable().describe("Feature resolution state; null when owned by a source-data panel."),
    features: z.array(z.strictObject({mapTileKey: identifierSchema, featureId: identifierSchema,
        mapId: identifierSchema.optional(), layerId: identifierSchema.optional(),
        partition: z.union([
            z.strictObject({kind: z.literal("tile"), id: z.number().int().min(-2147483648).max(2147483647)}),
            z.strictObject({kind: z.literal("object"), id: z.string().regex(/^[0-9]{1,20}$/)})
        ]).optional()
    }))
        .max(100),
    sourceData: z.strictObject({
        mapTileKey: identifierSchema,
        address: z.string().regex(/^[0-9]+$/).max(20).optional()
            .describe("Unsigned 64-bit address as a lossless decimal string.")
    }).optional()
})).max(100),
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    
    }
} as const;
