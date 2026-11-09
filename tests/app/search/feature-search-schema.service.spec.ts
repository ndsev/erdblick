import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {FeatureSearchSchemaService} from "../../../app/search/feature-search-schema.service";
import {featureSearchStyleFieldInventorySchema, searchStyleFieldCandidates} from "../../../app/search/search.model";
import type {MapDataService} from "../../../app/mapdata/mapdata.service";
import type {
    SearchCompletionWorkerInboundMessage,
    SearchCompletionWorkerOutboundMessage
} from "../../../app/search/search-completion.worker.protocol";

/** A controllable boundary: receipt and successful native installation are separate events. */
class SchemaWorker {
    static instances: SchemaWorker[] = [];
    readonly messages: SearchCompletionWorkerInboundMessage[] = [];
    onmessage?: (event: MessageEvent<SearchCompletionWorkerOutboundMessage>) => void;
    onerror?: (event: ErrorEvent) => void;
    constructor() { SchemaWorker.instances.push(this); }
    postMessage(message: SearchCompletionWorkerInboundMessage): void { this.messages.push(message); }
    terminate(): void {}
    reply(message: SearchCompletionWorkerOutboundMessage): void {
        this.onmessage?.({data: message} as MessageEvent<SearchCompletionWorkerOutboundMessage>);
    }
}

/** Supplies metadata for two maps while allowing tests to withhold readiness independently. */
function fixture() {
    SchemaWorker.instances = [];
    vi.stubGlobal("Worker", SchemaWorker);
    const schemaReadinessError = vi.fn<() => string | undefined>(() => undefined);
    const generations = new Map([["A", 1], ["B", 1]]);
    const mapInfo = {
        layerStateChanged: new Subject<string>(),
        schemaReadinessError,
        generations,
        schemaScopeSignature: (ids = [...generations.keys()]) => JSON.stringify(ids.map(id => [id, generations.get(id)])),
        getDataSourceInfoJson: (ids = ["A", "B"]) => JSON.stringify(ids.map(mapId => ({mapId, generation: generations.get(mapId)}))),
        getSchemaArtifacts: (ids = ["A", "B"]) => ids.map(schemaId => ({schemaId, bytes: new Uint8Array([1])}))
    };
    return {service: new FeatureSearchSchemaService(mapInfo as unknown as MapDataService), mapInfo};
}

/** Complete one field enumeration after checking its configuration was already acknowledged. */
async function finishFields(worker: SchemaWorker, offset = 0): Promise<void> {
    const configuration = worker.messages[offset];
    expect(configuration.type).toBe("SearchCompletionDataSourceInfo");
    if (configuration.type !== "SearchCompletionDataSourceInfo") throw new Error("Missing configuration");
    worker.reply({type: "SearchCompletionDataSourceInfoReady", requestId: configuration.requestId});
    await vi.waitFor(() => expect(worker.messages[offset + 1]?.type).toBe("SearchStyleFieldsRequest"));
    const request = worker.messages[offset + 1];
    if (request.type !== "SearchStyleFieldsRequest") throw new Error("Missing request");
    worker.reply({type: "SearchStyleFieldsResult", requestId: request.requestId, inventory: emptyInventory});
}

const emptyInventory = {contexts: [], types: [], fields: [], branches: [], complete: true, incompleteReason: ""};

describe("compact style inventory", () => {
    it("retains exact enum ordinals at the native worker boundary", () => {
        const inventory = featureSearchStyleFieldInventorySchema.parse({
            contexts: [{mapId: "Map", layerId: "Road"}],
            types: [{valueKind: "enum", enumValues: ["UNKNOWN"], schemaType: {
                schemaId: "artifact", typeId: 7, typeName: "Direction",
                namedValues: [{name: "UNKNOWN", value: "UNKNOWN", valueType: "string",
                    rawValue: "18446744073709551615", role: "constant", meaning: "unknown",
                    deprecated: false, removed: false}]
            }}],
            fields: [{path: "attributes.direction", metadata: 0, contexts: [0]}],
            branches: [], complete: true, incompleteReason: ""
        });
        expect(searchStyleFieldCandidates(inventory)[0].schemaType?.namedValues[0]).toMatchObject({
            value: "UNKNOWN", rawValue: "18446744073709551615"
        });
    });

    it("shares exact metadata across paths and retains semantic array branches", () => {
        const inventory = featureSearchStyleFieldInventorySchema.parse({
            contexts: [{mapId: "Map", layerId: "Road", featureType: "Road"}],
            types: [{valueKind: "integer", enumValues: [],
                schemaType: {schemaId: "artifact", typeId: 7, typeName: "Width", namedValues: []}}],
            fields: [{path: "attributes.width", metadata: 0, contexts: [0]},
                {path: "attributes.samples.*.width", metadata: 0, contexts: [0]}],
            branches: [{path: ["attributes", "samples", {elements: true}],
                label: "attributes.samples.*", contexts: [0]}],
            complete: true, incompleteReason: ""
        });
        const candidates = searchStyleFieldCandidates(inventory);
        expect(candidates[0].schemaType).toBe(candidates[1].schemaType);
        expect(candidates[0].contexts[0]).toBe(inventory.contexts[0]);
        expect(inventory.branches[0].path[2]).toEqual({elements: true});
        expect(featureSearchStyleFieldInventorySchema.safeParse({...inventory,
            fields: [{path: "bad", metadata: 1, contexts: [0]}]}).success).toBe(false);
        expect(featureSearchStyleFieldInventorySchema.safeParse({...inventory,
            branches: [{path: [], label: "bad", contexts: [1]}]}).success).toBe(false);
    });
});

afterEach(() => vi.unstubAllGlobals());

describe("schema worker admission", () => {
    it("browses all prepared owners with one schema installation and reuses them across predicates", async () => {
        const {service} = fixture();
        const branches = ["A", "B"].map(mapId => ({
            mapId, layerId: "Road", scope: "attribute" as const, query: 'warningSign == "ANIMALS"',
            id: mapId, label: mapId, kind: "expression" as const, schemaId: mapId,
            expression: 'warningSign == "ANIMALS"', featureTypes: ["Road"],
            attributeScopes: ["WARNING_SIGN", "MOVABLE_WARNING_SIGN"].map(attrName => ({
                mapId, layerId: "Road", featureType: "Road", attrLayerName: "Rules", attrName
            })), matchedFieldNames: [], matchedEnumValues: ["ANIMALS"]
        }));
        const fields = service.requestPreparedSearchStyleFields(branches, {recursive: true, values: "scalar"});
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        expect(worker.messages[0]).toMatchObject({schemas: [{schemaId: "A"}, {schemaId: "B"}]});
        await finishFields(worker);
        expect(worker.messages[1]).toMatchObject({query: "", scope: "attribute",
            selectedMapLayers: [{mapId: "A", layerId: "Road"}, {mapId: "B", layerId: "Road"}],
            options: {preparedContexts: branches.flatMap(branch => branch.attributeScopes)}
        });
        expect(await fields).toEqual(emptyInventory);
        await service.requestPreparedSearchStyleFields(branches.map(branch => ({...branch,
            query: 'warningSign == "SPEED_LIMIT"'})), {recursive: true, values: "scalar"});
        expect(worker.messages).toHaveLength(2);
    });

    it("cancels an obsolete completion, releases its lane on acknowledgement, and skips queued prefixes", async () => {
        const {service} = fixture();
        const first = vi.fn(), skipped = vi.fn(), latest = vi.fn();
        const request = (requestSerial: number, query: string) => ({
            type: "SearchCompletionRequest" as const, ownerId: "omnibar", requestSerial, query, point: query.length,
            options: {limit: 15, timeoutMs: 35, selectedMapLayers: [{mapId: "A", layerId: "Road"}]}
        });
        service.requestCompletion(request(1, "S"), first);
        const worker = SchemaWorker.instances[0];
        await vi.waitFor(() => expect(worker.messages.some(message => message.type === "SearchCompletionDataSourceInfo")).toBe(true));
        const configuration = worker.messages.find(message => message.type === "SearchCompletionDataSourceInfo")!;
        worker.reply({type: "SearchCompletionDataSourceInfoReady", requestId: configuration.requestId});
        await vi.waitFor(() => expect(worker.messages.some(message => message.type === "SearchCompletionRequest")).toBe(true));
        service.requestCompletion(request(2, "SP"), skipped);
        service.requestCompletion(request(3, "SPE"), latest);
        expect(worker.messages.at(-1)).toEqual({type: "SearchCompletionCancel", ownerId: "omnibar"});
        worker.reply({type: "SearchCompletionResult", ownerId: "omnibar", requestSerial: 1, candidates: [], done: true});
        await vi.waitFor(() => expect(worker.messages.filter(message => message.type === "SearchCompletionRequest")).toHaveLength(2));
        expect(worker.messages.filter(message => message.type === "SearchCompletionRequest").map(message => message.query))
            .toEqual(["S", "SPE"]);
        expect(first).not.toHaveBeenCalled();
        expect(skipped).toHaveBeenCalledWith(expect.objectContaining({done: true, candidates: []}));
        worker.reply({type: "SearchCompletionResult", ownerId: "omnibar", requestSerial: 3, candidates: [], done: true});
        expect(latest).toHaveBeenCalledWith(expect.objectContaining({requestSerial: 3, done: true}));
    });

    it("coalesces feature inventories across predicates while retaining type and branch selection", async () => {
        const {service} = fixture();
        const scope = [{mapId: "A", layerId: "Road"}];
        const options = {selectedFeatureTypes: ["Road"], path: ["attributes"], recursive: false};
        const first = service.requestSearchStyleFields("false", "feature", scope, options);
        const second = service.requestSearchStyleFields("speed > 10", "feature", scope, options);
        expect(second).toBe(first);
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        await finishFields(worker);
        expect(worker.messages[1]).toMatchObject({options: {
            selectedFeatureTypes: ["Road"], path: ["attributes"], recursive: false, values: "scalar"
        }});
        await first;
        expect(await service.requestSearchStyleFields("true", "feature", scope, options)).toBe(emptyInventory);
        expect(worker.messages).toHaveLength(2);
        const next = service.requestSearchStyleFields("true", "feature", scope, {...options, selectedFeatureTypes: ["Building"]});
        await vi.waitFor(() => expect(worker.messages).toHaveLength(3));
        const request = worker.messages[2];
        if (request.type !== "SearchStyleFieldsRequest") throw new Error("Missing request");
        worker.reply({type: "SearchStyleFieldsResult", requestId: request.requestId, inventory: emptyInventory});
        await next;
    });

    it("keeps attribute inventories dependent on their predicate's semantic owners", async () => {
        const {service} = fixture();
        const first = service.requestSearchStyleFields("speed", "attribute");
        const second = service.requestSearchStyleFields("height", "attribute");
        expect(first).not.toBe(second);
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        await finishFields(worker);
        await first;
        await vi.waitFor(() => expect(worker.messages).toHaveLength(3));
        const request = worker.messages[2];
        if (request.type !== "SearchStyleFieldsRequest") throw new Error("Missing request");
        expect(request.query).toBe("height");
        worker.reply({type: "SearchStyleFieldsResult", requestId: request.requestId, inventory: emptyInventory});
        await second;
    });
    it("installs only requested maps and waits for native acknowledgement", async () => {
        const {service} = fixture();
        const fields = service.requestSearchStyleFields("true", "feature", [{mapId: "A", layerId: "Road"}]);
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        expect(worker.messages[0]).toMatchObject({schemas: [{schemaId: "A"}]});
        await finishFields(worker);
        expect(await fields).toEqual(emptyInventory);
    });

    it("serializes different source scopes through the complete query", async () => {
        const {service} = fixture();
        const first = service.requestSearchStyleFields("true", "feature", [{mapId: "A", layerId: "Road"}]);
        const second = service.requestSearchStyleFields("true", "feature", [{mapId: "B", layerId: "Road"}]);
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        await finishFields(worker);
        await first;
        await vi.waitFor(() => expect(worker.messages).toHaveLength(3));
        expect(worker.messages[2]).toMatchObject({schemas: [{schemaId: "B"}]});
        await finishFields(worker, 2);
        await second;
    });

    it("reports schema installation failure without dispatching or caching an empty answer", async () => {
        const {service} = fixture();
        const fields = service.requestSearchStyleFields("true", "feature");
        const failure = expect(fields).rejects.toThrow("Identity mismatch");
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        const configuration = worker.messages[0];
        if (configuration.type !== "SearchCompletionDataSourceInfo") throw new Error("Missing configuration");
        worker.reply({type: "SearchCompletionDataSourceInfoReady", requestId: configuration.requestId, error: "Identity mismatch"});
        await failure;
        expect(worker.messages).toHaveLength(1);
        const retry = service.requestSearchStyleFields("true", "feature");
        await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
        await finishFields(worker, 1);
        await retry;
    });

    it("keeps a pending source distinct from a schema containing no fields", async () => {
        const {service, mapInfo} = fixture();
        mapInfo.schemaReadinessError.mockReturnValue("A: schema loading");
        await expect(service.requestSearchStyleFields("true", "feature")).rejects.toThrow("schema loading");
        expect(SchemaWorker.instances[0].messages).toEqual([]);
    });

    it("ignores unrelated source progress and additions during installation", async () => {
        const {service, mapInfo} = fixture();
        const scope = [{mapId: "A", layerId: "Road"}];
        const signature = service.searchScopeAnalysisSignature("true", "feature", scope);
        const fields = service.requestSearchStyleFields("true", "feature", scope);
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        mapInfo.layerStateChanged.next("datasources");
        mapInfo.generations.set("C", 1);
        mapInfo.layerStateChanged.next("datasources");
        expect(service.searchScopeAnalysisSignature("true", "feature", scope)).toBe(signature);
        await finishFields(SchemaWorker.instances[0]);
        expect(await fields).toEqual(emptyInventory);
    });

    it("rejects an old installation acknowledgement after source replacement", async () => {
        const {service, mapInfo} = fixture();
        const fields = service.requestSearchStyleFields("true", "feature", [{mapId: "A", layerId: "Road"}]);
        const failure = expect(fields).rejects.toThrow("schema changed");
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        const configuration = worker.messages[0];
        if (configuration.type !== "SearchCompletionDataSourceInfo") throw new Error("Missing configuration");
        mapInfo.generations.set("A", 2);
        mapInfo.layerStateChanged.next("datasources");
        worker.reply({type: "SearchCompletionDataSourceInfoReady", requestId: configuration.requestId});
        await failure;
        expect(worker.messages).toHaveLength(1);
    });

    it("rejects fields returned by a superseded graph and does not cache them", async () => {
        const {service, mapInfo} = fixture();
        const scope = [{mapId: "A", layerId: "Road"}];
        const fields = service.requestSearchStyleFields("true", "feature", scope);
        const failure = expect(fields).rejects.toThrow("schema changed");
        await vi.waitFor(() => expect(SchemaWorker.instances[0]?.messages).toHaveLength(1));
        const worker = SchemaWorker.instances[0];
        const configuration = worker.messages[0];
        if (configuration.type !== "SearchCompletionDataSourceInfo") throw new Error("Missing configuration");
        worker.reply({type: "SearchCompletionDataSourceInfoReady", requestId: configuration.requestId});
        await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
        const query = worker.messages[1];
        if (query.type !== "SearchStyleFieldsRequest") throw new Error("Missing query");
        mapInfo.generations.set("A", 2);
        mapInfo.layerStateChanged.next("datasources");
        worker.reply({type: "SearchStyleFieldsResult", requestId: query.requestId, inventory: emptyInventory});
        await failure;
        const retry = service.requestSearchStyleFields("true", "feature", scope);
        await vi.waitFor(() => expect(worker.messages).toHaveLength(3));
        await finishFields(worker, 2);
        expect(await retry).toEqual(emptyInventory);
    });
});
