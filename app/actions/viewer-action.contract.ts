import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {
    appStateChannels, appStateOmissionSchema, appStateReadinessSchema,
    appStateTargetSchema, appStateValueSchema,
    appStateWritableChannels, appStateWritableTargetSchema, appStateWritableValueSchema
} from "../shared/app-state-channel.contract.js";
import {viewerOperations} from "./viewer-operation.contract.js";
import {viewerUiActions} from "./viewer-ui.contract.js";

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

/** Cross-field constraints are derived from channel definitions for BOTH validators. */
const assignmentConstraints = appStateWritableChannels.map(([name, channel]) => ({
    if: {properties: {target: {properties: {channel: {const: name}}}}},
    then: {properties: {value: viewerJsonSchema(channel.valueSchema)},
        ...("viewIndex" in channel.selectorSchema.shape || name === "app.focusedView" ? {required: ["viewLayoutRevision"]} : {})}
}));
const assignmentInputSchema = z.strictObject({
    target: appStateWritableTargetSchema, value: appStateWritableValueSchema, viewLayoutRevision: revisionSchema.optional()
}).superRefine((input, context) => {
    const channel = appStateChannels[input.target.channel];
    if (!channel.writable || !channel.valueSchema.safeParse(input.value).success) {
        context.addIssue({code: "custom", path: ["value"], message: "Value does not match the writable channel"});
    }
    if (("viewIndex" in input.target || input.target.channel === "app.focusedView") && input.viewLayoutRevision === undefined) {
        context.addIssue({code: "custom", path: ["viewLayoutRevision"], message: "View-scoped writes require a layout revision"});
    }
}).meta({allOf: assignmentConstraints});

/** Public metadata exported from the same definitions used by runtime handlers. */
export const appStateChannelDescriptorSchema = z.strictObject({
    name: channelNameSchema,
    description: z.string(),
    selectorSchema: z.record(z.string(), z.unknown()),
    valueSchema: z.record(z.string(), z.unknown()),
    readable: z.boolean(),
    writable: z.boolean(),
    persistence: z.enum(["runtime-summary", "url-and-local-storage", "local-storage", "mixed"]),
    synchronization: z.enum(["none", "follow-view-sync", "focus-target-and-follow-view-sync"])
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
        description: "Change settings directly: view.layer for layer visibility/level, view.styleOption for style options, view.layerPreset/view.mapPreset for presets, view.camera, view.background, and view.grid. Discover selectors/value schemas with viewer_describe_app_state. Assign one complete value through its application owner; view-scoped writes require the observed viewLayoutRevision and honor synchronization. Use runtime objects, not storage/URL encodings. Applied does not mean tiles have loaded or rendered.",
        permission: "viewer-control", mutation: true,
        inputSchema: assignmentInputSchema,
        outputSchema: z.strictObject({
            status: z.literal("applied"),
            target: appStateWritableTargetSchema,
            value: appStateWritableValueSchema,
            changed: z.boolean(),
            focusedView: revisionSchema,
            affectedViews: z.array(revisionSchema).max(100),
            viewLayoutRevision: revisionSchema,
            readiness: appStateReadinessSchema
        }).superRefine((output, context) => {
            if (!appStateChannels[output.target.channel].valueSchema.safeParse(output.value).success) {
                context.addIssue({code: "custom", path: ["value"], message: "Value does not match the channel"});
            }
        }).meta({allOf: assignmentConstraints})
    },
    ...viewerOperations,
    ...viewerUiActions
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
