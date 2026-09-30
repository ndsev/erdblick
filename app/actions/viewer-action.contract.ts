import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {
    appStateChannels, appStateOmissionSchema, appStateReadinessSchema,
    appStateTargetSchema, appStateTargetSchemas, appStateValueSchema,
    cameraViewStateSchema
} from "../shared/app-state-channel.contract.js";

export const VIEWER_ACTION_INVOCATION_BYTES = 64 * 1024;
export const VIEWER_ACTION_RESULT_BYTES = 256 * 1024;
export const VIEWER_ACTION_TARGET_LIMIT = 32;

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const channelNameSchema = z.enum(Object.keys(appStateChannels) as [keyof typeof appStateChannels, ...Array<keyof typeof appStateChannels>]);
const observationShape = {observedAt: z.string(), viewLayoutRevision: revisionSchema};
const completenessShape = {
    complete: z.boolean(),
    omissions: z.array(appStateOmissionSchema).max(VIEWER_ACTION_TARGET_LIMIT)
};

/** Public metadata exported from the same definitions used by runtime handlers. */
export const appStateChannelDescriptorSchema = z.strictObject({
    name: channelNameSchema,
    description: z.string(),
    selectorSchema: z.record(z.string(), z.unknown()),
    valueSchema: z.record(z.string(), z.unknown()),
    readable: z.boolean(),
    writable: z.boolean(),
    persistence: z.enum(["runtime-summary", "url-and-local-storage"]),
    synchronization: z.enum(["none", "focus-target-and-follow-view-sync"])
});

/** Browser actions only: mapget owns viewer_list_sessions and adds clientId routing. */
export const viewerActions = {
    viewer_describe_app_state: {
        description: "Discover explicitly exposed application state channels, selectors, canonical value schemas and current view availability. Does not load map data.",
        permission: "viewer-read", mutation: false,
        inputSchema: z.strictObject({
            channels: z.array(channelNameSchema).max(VIEWER_ACTION_TARGET_LIMIT).optional(),
            prefix: boundedUnicodeString(128).optional()
        }),
        outputSchema: z.strictObject({
            ...observationShape,
            channels: z.array(appStateChannelDescriptorSchema).max(VIEWER_ACTION_TARGET_LIMIT),
            views: appStateChannels["app.views"].valueSchema,
            ...completenessShape
        })
    },
    viewer_get_app_state: {
        description: "Read selected state channels, or a bounded live overview when targets are omitted. Includes hidden/paused search definitions; excludes feature data and search results.",
        permission: "viewer-read", mutation: false,
        inputSchema: z.strictObject({targets: z.array(appStateTargetSchema).max(VIEWER_ACTION_TARGET_LIMIT).optional()}),
        outputSchema: z.strictObject({
            ...observationShape,
            values: z.array(appStateValueSchema).max(VIEWER_ACTION_TARGET_LIMIT),
            ...completenessShape
        })
    },
    viewer_set_app_state: {
        description: "Assign one writable channel through its application owner. Camera assignment is immediate, focuses the target, honors view synchronization and requires the observed viewLayoutRevision. Applied does not mean tiles have loaded or rendered.",
        permission: "viewer-control", mutation: true,
        inputSchema: z.strictObject({
            target: appStateTargetSchemas["view.camera"],
            value: cameraViewStateSchema,
            viewLayoutRevision: revisionSchema
        }),
        outputSchema: z.strictObject({
            status: z.literal("applied"),
            target: appStateTargetSchemas["view.camera"],
            value: cameraViewStateSchema,
            changed: z.boolean(),
            focusedView: revisionSchema,
            affectedViews: z.array(revisionSchema).max(100),
            viewLayoutRevision: revisionSchema,
            readiness: appStateReadinessSchema
        })
    }
} as const;

export type ViewerActionName = keyof typeof viewerActions;
export type ViewerActionInput<Name extends ViewerActionName> = z.infer<typeof viewerActions[Name]["inputSchema"]>;
export type ViewerActionOutput<Name extends ViewerActionName> = z.infer<typeof viewerActions[Name]["outputSchema"]>;

/** Produces self-contained Draft-07 schemas; unrepresentable validators fail the build. */
export function viewerJsonSchema(schema: z.ZodType): Record<string, unknown> {
    return z.toJSONSchema(schema, {target: "draft-07", io: "input", reused: "inline", cycles: "throw"});
}

/** Describes the explicit channel allowlist without Angular, WASM, storage or a viewer. */
export function describeAppStateChannels() {
    return Object.entries(appStateChannels).map(([name, channel]) => ({
        ...channel,
        name: name as keyof typeof appStateChannels,
        selectorSchema: viewerJsonSchema(channel.selectorSchema),
        valueSchema: viewerJsonSchema(channel.valueSchema)
    }));
}

/** Exports contract content only; the build adds its digest, never timestamps or tab state. */
export function viewerActionCatalog() {
    return {
        formatVersion: 1 as const,
        actions: Object.entries(viewerActions).map(([name, action]) => ({
            ...action,
            name,
            inputSchema: viewerJsonSchema(action.inputSchema),
            outputSchema: viewerJsonSchema(action.outputSchema)
        })),
        channels: describeAppStateChannels()
    };
}

/** Canonical contract bytes: sorted object keys, ordered arrays, ECMAScript JSON scalars. */
export function canonicalViewerContractJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
        ).join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
