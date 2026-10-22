import {z} from "zod";
import type {ActionCatalog} from "./app-action";

export {VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT} from "./action-limits";

/** Produce the portable schema representation accepted by mapget and MCP clients. */
export function viewerJsonSchema(schema: z.ZodType): Record<string, unknown> {
    return z.toJSONSchema(schema, {target: "draft-07", io: "input", reused: "inline", cycles: "throw"});
}

/** Permissions come from mutation; no owner can promote a browser tool to native privileges. */
export function viewerActionCatalog(catalog: ActionCatalog) {
    return {
        formatVersion: 1 as const,
        actions: Object.values(catalog.publicActions).map((action) => ({
            name: action.name,
            description: action.description,
            mutation: action.mutation,
            permission: action.mutation ? "viewer-control" : "viewer-read",
            inputSchema: viewerJsonSchema(action.inputSchema),
            outputSchema: viewerJsonSchema(action.outputSchema)
        })),
        // formatVersion 1 calls this manifest field channels. Runtime APIs call them controls.
        channels: catalog.controlDeclarations.map((control) => ({
            ...control,
            selectorSchema: viewerJsonSchema(control.selectorSchema),
            valueSchema: viewerJsonSchema(control.valueSchema)
        }))
    };
}

/** Canonical contract bytes: sorted object keys, ordered arrays, ECMAScript JSON scalars. */
export function canonicalViewerContractJson(value: unknown): string {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
            )
            .join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
