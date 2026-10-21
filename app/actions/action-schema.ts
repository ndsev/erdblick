import {z} from "zod";
import {viewIdSchema} from "../mapview/view-id";
import {boundedUnicodeString} from "../shared/unicode-string.js";

export const text = boundedUnicodeString(4096);
export const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tileId = z.number().int().min(-2147483648).max(2147483647);
export const limit = z.number().int().min(1).max(100).optional();
export const observed = {observedAt: z.string()};
export const bounded = {
    complete: z.boolean(),
    reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional()
};
export const view = {viewId: viewIdSchema};
export const applied = z.strictObject({status: z.literal("applied"), changed: z.boolean()});

export const APP_STATE_COLLECTION_LIMIT = 100;
export const APP_STATE_TEXT_LIMIT = 4096;
export const indexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const identifierSchema = boundedUnicodeString(APP_STATE_TEXT_LIMIT, true);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const styleOptionValueSchema = z.union([z.boolean(), z.number(), boundedUnicodeString(4096)]);

export const pageInput = {offset: count.max(100000).optional(), limit};
export const pageOutput = {...observed, ...bounded, nextOffset: count.optional()};
