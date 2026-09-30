import {describe, expect, it} from "vitest";
import fixtures from "../../test/viewer-actions/fixtures.json";
import {
    canonicalViewerContractJson, describeAppStateChannels, viewerActionCatalog, viewerActions,
    type ViewerActionName
} from "./viewer-action.contract";
import {viewerActionClientMessageSchema, viewerActionServerMessageSchema, viewerMcpInfoSchema} from "./viewer-action-relay.contract";
import {cameraViewStateSchema} from "../shared/app-state-channel.contract";

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

    it("bounds target work before any application access", () => {
        expect(viewerActions.viewer_get_app_state.inputSchema.safeParse({
            targets: Array.from({length: 33}, () => ({channel: "app.searches"}))
        }).success).toBe(false);
    });

    it.each([Number.NaN, Infinity, -Infinity, 0, -1])("rejects invalid scale-height %s", alt => {
        expect(cameraViewStateSchema.safeParse({
            destination: {lon: 11, lat: 48, alt},
            orientation: {heading: 0, pitch: -1, roll: 0}
        }).success).toBe(false);
    });

    it("does not accept a runtime value for the wrong channel", () => {
        expect(viewerActions.viewer_get_app_state.outputSchema.safeParse({
            observedAt: "2026-09-29T00:00:00Z", viewLayoutRevision: 0,
            values: [{target: {channel: "view.camera", viewIndex: 0}, value: []}], complete: true, omissions: []
        }).success).toBe(false);
    });

    it("publishes only explicit actions/channels with consistent permissions", () => {
        const catalog = viewerActionCatalog();
        expect(catalog.actions.map(action => action.name)).toEqual(Object.keys(viewerActions));
        expect(new Set(catalog.actions.map(action => action.name)).size).toBe(catalog.actions.length);
        expect(new Set(catalog.channels.map(channel => channel.name)).size).toBe(catalog.channels.length);
        expect(catalog.actions.every(action => action.permission === (action.mutation ? "viewer-control" : "viewer-read"))).toBe(true);
        expect(catalog.channels.filter(channel => channel.writable).map(channel => channel.name)).toEqual(["view.camera"]);
        expect(catalog.actions.some(action => action.name === "viewer_list_sessions")).toBe(false);
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
        const channels = describeAppStateChannels();
        expect(channels.find(channel => channel.name === "view.camera")?.valueSchema["type"]).toBe("object");
    });

    it.each([undefined, Number.NaN, Infinity, new Date(), () => 1])("rejects non-JSON contract content", value => {
        expect(() => canonicalViewerContractJson({value})).toThrow(TypeError);
    });
});
