/**
 * Validate browser/MCP responses against the manifest shipped with the tested
 * bundle. Importing controller declarations here would also load Angular and
 * the WASM factory into Playwright's Node process. Only the TypeScript types
 * are generated from the collected catalog; runtime validation uses the public JSON.
 */
import Ajv, { type SchemaObject } from "ajv";
import { readFileSync } from "node:fs";
import type { ViewerContract } from "../../../app/action/generated/viewer-contract";

type Actions = ViewerContract["actions"];
type Controls = ViewerContract["controls"];
type Parser<Value> = { parse(value: unknown): Value };

const catalog = JSON.parse(readFileSync("static/browser/web-mcp-actions.json", "utf8")) as {
    actions: Array<{ name: string; mutation: boolean; inputSchema: SchemaObject; outputSchema: SchemaObject }>;
    channels: Array<{ name: string; valueSchema: SchemaObject }>;
};
const ajv = new Ajv({ allErrors: true, strict: false });

/** Match the tests' parse convention while validating the deployed Draft-07 schema. */
function parser<Value>(schema: SchemaObject): Parser<Value> {
    const validate = ajv.compile(schema);
    return {
        parse(value) {
            if (!validate(value)) {
                throw new Error(`Viewer contract mismatch: ${ajv.errorsText(validate.errors)}`);
            }
            return value as Value;
        }
    };
}

export const viewerActions = Object.fromEntries(catalog.actions.map(action => [action.name, {
    mutation: action.mutation,
    inputSchema: parser(action.inputSchema),
    outputSchema: parser(action.outputSchema)
}])) as {
    [Name in keyof Actions]: {
        mutation: boolean;
        inputSchema: Parser<Actions[Name]["input"]>;
        outputSchema: Parser<Actions[Name]["output"]>;
    }
};

export const applicationControls = Object.fromEntries(catalog.channels.map(control => [control.name, {
    valueSchema: parser(control.valueSchema)
}])) as {
    [Name in keyof Controls]: { valueSchema: Parser<Controls[Name]["value"]> }
};

export const cameraViewStateSchema = applicationControls["view.camera"].valueSchema;

// The native screenshot adapter returns its image separately from its metadata.
const screenshotSchema = catalog.actions.find(action => action.name === "viewer_screenshot")!.outputSchema;
export const screenshotMetadataSchema = parser<Actions["viewer_screenshot"]["output"]["metadata"]>(
    screenshotSchema["properties"]["metadata"]
);
