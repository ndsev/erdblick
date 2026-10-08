import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";

export const VIEWER_ACTION_RELAY_VERSION = 1;
export const VIEWER_ACTION_CONTROL_FRAME_TYPE = 9;

const version = z.literal(VIEWER_ACTION_RELAY_VERSION);
const catalogId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const actionName = boundedUnicodeString(128, true);
const callId = boundedUnicodeString(128, true);
const label = boundedUnicodeString(120);
// Draft-07 uniqueItems and this runtime check describe the same string-array constraint.
const actions = z.array(actionName).max(64)
    .refine(names => new Set(names).size === names.length, "Action names must be unique")
    .meta({uniqueItems: true});
const registration = {version, catalogId, actions, label};
export const viewerClientIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const clientId = viewerClientIdSchema;

/** Application errors remain distinct from MCP authentication and tile-stream errors. */
export const viewerActionErrorSchema = z.strictObject({
    code: z.enum(["invalid_arguments", "not_available", "unsupported_action", "busy", "cancelled", "timeout", "disconnected", "internal_error"]),
    message: boundedUnicodeString(4096),
    reason: boundedUnicodeString(128).optional(),
    outcome: z.enum(["not_applied", "applied", "unknown"]).optional()
});

/** Server-to-browser messages carried as UTF-8 JSON in ActionControl VTLV frames. */
export const viewerActionServerMessageSchema = z.union([
    z.strictObject({type: z.literal("mapget.actions.registered"), version, clientId, catalogId}),
    z.strictObject({type: z.literal("mapget.actions.updated"), version, clientId, catalogId}),
    z.strictObject({
        type: z.literal("mapget.actions.invoke"), version, callId, action: actionName,
        arguments: z.record(z.string(), z.unknown()), timeoutMs: z.number().int().positive().max(2147483647)
    }),
    z.strictObject({type: z.literal("mapget.actions.cancel"), version, callId, reason: boundedUnicodeString(128)}),
    z.strictObject({
        type: z.literal("mapget.actions.error"), version,
        operation: z.enum(["register", "update"]), error: viewerActionErrorSchema
    })
]);

/** Browser-to-server controls are text JSON; results contain exactly one result OR error. */
export const viewerActionClientMessageSchema = z.union([
    z.strictObject({type: z.literal("mapget.actions.register"), ...registration}),
    z.strictObject({type: z.literal("mapget.actions.update"), ...registration}),
    z.strictObject({
        type: z.literal("mapget.actions.result"), version, callId, result: z.record(z.string(), z.unknown())
    }),
    z.strictObject({type: z.literal("mapget.actions.result"), version, callId, error: viewerActionErrorSchema})
]);

export type ViewerActionError = z.infer<typeof viewerActionErrorSchema>;
/** Typed application failure shared by domain and UI action owners. */
export class ViewerActionFailure extends Error {
    constructor(readonly detail: ViewerActionError) {
        super(detail.message);
    }
}
export type ViewerActionServerMessage = z.infer<typeof viewerActionServerMessageSchema>;
export type ViewerActionClientMessage = z.infer<typeof viewerActionClientMessageSchema>;

/** Public connection hints only; OAuth discovery and all authorization remain server-owned. */
export const viewerMcpInfoSchema = z.union([
    z.strictObject({enabled: z.literal(false)}),
    z.strictObject({
        enabled: z.literal(true), endpoint: boundedUnicodeString(4096, true),
        authentication: z.literal("local"), scopes: z.array(z.string()).length(0), catalogId: catalogId.optional()
    }),
    z.strictObject({
        enabled: z.literal(true), endpoint: boundedUnicodeString(4096, true),
        authentication: z.literal("oauth"), scopes: z.array(boundedUnicodeString(256, true)).max(64),
        oauthClientId: boundedUnicodeString(256, true).optional(), catalogId: catalogId.optional()
    })
]);

export type ViewerMcpInfo = z.infer<typeof viewerMcpInfoSchema>;
