import {describe, expect, it} from "vitest";
import fixtures from "../../test/viewer-actions/fixtures.json";
import {
    canonicalViewerContractJson, viewerActionCatalog, viewerActions,
    type ViewerActionName
} from "./viewer-action.contract";
import {viewerActionClientMessageSchema, viewerActionServerMessageSchema, viewerMcpInfoSchema} from "./viewer-action-relay.contract";
import {applicationControls} from "./application-controls";
import {describeControls} from "./app-action.service.declarations";
import {composeDeclarations} from "./app-action";
import {mapViewControls} from "../mapview/map-view.service.declarations";
const cameraViewStateSchema = mapViewControls.camera.valueSchema;

describe("viewer action shared contract fixtures", () => {
    for (const fixture of fixtures.actions) {
        it(fixture.name, () => {
            const action = viewerActions[fixture.action as ViewerActionName];
            expect(action.inputSchema.safeParse(fixture.arguments).success).toBe(fixture.valid);
        });
    }
    for (const fixture of fixtures.relay) {
        it(fixture.name, () => {
            const schema = fixture.direction === "client" ? viewerActionClientMessageSchema : viewerActionServerMessageSchema;
            expect(schema.safeParse(fixture.message).success).toBe(fixture.valid);
        });
    }
    for (const fixture of fixtures.canonical) {
        it("writes canonical keys literally, including numeric keys and Unicode", () => {
            expect(canonicalViewerContractJson(fixture.value)).toBe(fixture.json);
        });
    }
    for (const fixture of fixtures.info) {
        it(fixture.name, () => expect(viewerMcpInfoSchema.safeParse(fixture.value).success).toBe(fixture.valid));
    }
    for (const fixture of fixtures.results) {
        it(fixture.name, () => {
            expect(viewerActions[fixture.action as ViewerActionName].outputSchema.safeParse(fixture.value).success).toBe(fixture.valid);
        });
    }

    it("rejects duplicate owner declarations before manifest composition", () => {
        const projection = mapViewControls.projection;
        expect(() => composeDeclarations({first: projection}, {second: projection})).toThrow("Duplicate declaration: view.projection");
        const action = viewerActions.viewer_get_controls;
        expect(() => composeDeclarations({first: action, second: action})).toThrow("Duplicate declaration: viewer_get_controls");
    });

    it("bounds target work before any application access", () => {
        expect(viewerActions.viewer_get_controls.inputSchema.safeParse({
            targets: Array.from({length: 33}, () => ({control: "app.searches"}))
        }).success).toBe(false);
    });

    it.each([Number.NaN, Infinity, -Infinity, 0, -1])("rejects invalid scale-height %s", alt => {
        expect(cameraViewStateSchema.safeParse({
            destination: {lon: 11, lat: 48, alt},
            orientation: {heading: 0, pitch: -1, roll: 0}
        }).success).toBe(false);
    });

    it.each([Number.NaN, Infinity, -Infinity])("rejects non-finite camera offset %s", component => {
        expect(cameraViewStateSchema.safeParse({
            destination: {lon: 11, lat: 48, alt: 500},
            orientation: {heading: 0, pitch: -1, roll: 0},
            position: [0, component, 0]
        }).success).toBe(false);
    });

    it("exports camera offsets as fixed-size homogeneous arrays for MCP clients", () => {
        const catalog = viewerActionCatalog();
        const cameraSchema = {
            properties: {position: {type: "array", items: {type: "number"}, minItems: 3, maxItems: 3}},
            required: ["destination", "orientation"]
        };
        const setter = catalog.actions.find(action => action.name === "viewer_set_control");
        for (const schema of [setter!.inputSchema, setter!.outputSchema]) {
            const assignments = schema['allOf'] as Array<{if: {properties: {target: {properties: {control: {const: string}}}}}; then: unknown}>;
            expect(assignments.find(item => item.if.properties.target.properties.control.const === "view.camera")?.then)
                .toMatchObject({properties: {value: cameraSchema}});
        }
        expect(catalog.channels.find(channel => channel.name === "view.camera")?.valueSchema).toMatchObject(cameraSchema);
        // Discovery can succeed even when a client cannot expose a tuple schema to its model.
        expect(canonicalViewerContractJson(catalog)).not.toMatch(/"items":\[/);
    });

    it("does not accept a runtime value for the wrong channel", () => {
        expect(viewerActions.viewer_get_controls.outputSchema.safeParse({
            observedAt: "2026-09-29T00:00:00Z",
            values: [{target: {control: "view.camera", viewId: "view-0"}, value: []}], complete: true, omissions: []
        }).success).toBe(false);
        const input = viewerActions.viewer_set_control.inputSchema;
        const target = {control: "view.projection", viewId: "view-0"};
        expect(input.safeParse({target, value: "2d"}).success).toBe(true);
        expect(input.safeParse({target, value: []}).success).toBe(false);
        expect(input.safeParse({target: {control: "view.projection", viewIndex: 0}, value: "2d"}).success).toBe(false);
        expect(input.safeParse({target: {control: "view.projection", viewId: "constructor"}, value: "2d"}).success).toBe(false);
        expect(input.safeParse({target}).success).toBe(false);
    });

    it("publishes only explicit actions/channels with consistent permissions", () => {
        const catalog = viewerActionCatalog();
        expect(catalog.actions.map(action => action.name)).toEqual(Object.keys(viewerActions));
        expect(new Set(catalog.actions.map(action => action.name)).size).toBe(catalog.actions.length);
        expect(new Set(catalog.channels.map(channel => channel.name)).size).toBe(catalog.channels.length);
        expect(catalog.actions.every(action => action.permission === (action.mutation ? "viewer-control" : "viewer-read"))).toBe(true);
        expect(catalog.channels.filter(channel => channel.writable).map(channel => channel.name))
            .toEqual(Object.entries(applicationControls).filter(([, channel]) => channel.writable).map(([name]) => name));
        expect(catalog.actions).toHaveLength(32);
        expect(catalog.channels).toHaveLength(21);
        expect(catalog.actions.some(action => String(action.name) === "viewer_list_sessions")).toBe(false);
    });

    it("exports deterministic self-contained Draft-07 schemas without format-only validators", () => {
        const serialized = canonicalViewerContractJson(viewerActionCatalog());
        expect(serialized).toBe(canonicalViewerContractJson(viewerActionCatalog()));
        expect(serialized).not.toContain('"format":');
        expect(serialized).not.toContain('"$ref":');
        expect(serialized).not.toContain("catalogId");
        for (const action of viewerActionCatalog().actions) {
            expect(action.inputSchema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
            expect(action.inputSchema["additionalProperties"]).toBe(false);
        }
        const channels = describeControls();
        expect(channels.find(channel => channel.name === "view.camera")?.valueSchema["type"]).toBe("object");
    });

    it.each([undefined, Number.NaN, Infinity, new Date(), () => 1])("rejects non-JSON contract content", value => {
        expect(() => canonicalViewerContractJson({value})).toThrow(TypeError);
    });
});
