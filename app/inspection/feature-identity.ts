/** Validates feature references shared by inspection, navigation and tile requests. */
import { z } from "zod";
import { identifierSchema, indexSchema } from "../action/action.model";

const count = indexSchema;

const inspectionTargetFields = {
    attributeIndex: count.optional().describe("Observed attribute index on the base feature; mutually exclusive with relationIndex and an ID suffix."),
    relationIndex: count.optional().describe("Observed relation index on the base feature; mutually exclusive with attributeIndex and an ID suffix."),
    validityIndex: count.optional().describe("Observed validity index; requires attributeIndex or relationIndex. For a relation, addresses targetValidity, not sourceValidity. Omit to select the whole attribute/relation.")
};

export const featureIdentitySchema = z.union([
    z.strictObject({
        ...inspectionTargetFields,
        mapTileKey: identifierSchema,
        featureId: identifierSchema.describe("Full feature ID, including its feature-type prefix; copy an observed ID, not only its numeric parts.")
    }),
    z.strictObject({
        ...inspectionTargetFields,
        mapId: identifierSchema,
        layerId: identifierSchema.optional(),
        featureId: identifierSchema.describe("Full feature ID beginning with its exact feature type, with source-specific ID parts separated by dots.")
    })
]);
