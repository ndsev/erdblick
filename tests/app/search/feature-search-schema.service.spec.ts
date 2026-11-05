import "@angular/compiler";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureSearchSchemaService } from "../../../app/search/feature-search-schema.service";
import type {
    SearchCompletionRequestMessage,
    SearchCompletionWorkerOutboundMessage
} from "../../../app/search/search-completion.worker.protocol";

/** Records worker traffic while retaining the actual owner state and cancellation implementation. */
class SchemaWorkerDouble {
    static instances: SchemaWorkerDouble[] = [];
    onmessage: ((event: {data: SearchCompletionWorkerOutboundMessage}) => void) | null = null;
    onerror: ((event: {message: string}) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { SchemaWorkerDouble.instances.push(this); }
}

/** Gives the worker owner catalog metadata without starting native parsing or transport. */
function createSchema() {
    const changes = new Subject<string>();
    const schema = new FeatureSearchSchemaService({layerStateChanged: changes, getDataSourceInfoJson: () => "{}"} as never);
    return {schema, changes};
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); SchemaWorkerDouble.instances = []; });

describe("Search completion owner", () => {
    it("constructs and observes the catalog without starting a worker", () => {
        vi.stubGlobal("Worker", SchemaWorkerDouble);
        const {schema, changes} = createSchema();
        schema.completionStateForOwner("editor");
        changes.next("datasources");
        expect(SchemaWorkerDouble.instances).toHaveLength(0);
        schema.ngOnDestroy();
    });

    it("isolates owner cancellation and retires timers and workers on destruction", () => {
        vi.useFakeTimers(); vi.stubGlobal("Worker", SchemaWorkerDouble);
        const {schema} = createSchema();
        schema.completeQueryForOwner("first", "road", 4);
        schema.completeQueryForOwner("second", "lane", 4);
        vi.runAllTimers();
        const worker = SchemaWorkerDouble.instances[0];
        const requests = worker.postMessage.mock.calls.map(call => call[0]).filter(
            (message): message is SearchCompletionRequestMessage => message.type === "SearchCompletionRequest");
        expect(requests.map(request => request.ownerId)).toEqual(["first", "second"]);
        schema.clearCurrentCompletion("first");
        for (const request of requests) {
            worker.onmessage?.({data: {
                type: "SearchCompletionResult", ownerId: request.ownerId, requestSerial: request.requestSerial,
                candidates: [{text: request.query, query: request.query, kind: "Field",
                    begin: 0, end: request.point, source: "schema", hint: ""}], done: true
            }});
        }
        expect(schema.completionStateForOwner("first").pending.getValue()).toBe(false);
        expect(schema.completionStateForOwner("first").candidateList).toEqual([]);
        expect(schema.completionStateForOwner("second").pending.getValue()).toBe(false);
        expect(schema.completionStateForOwner("second").candidateList.map(candidate => candidate.text)).toEqual(["lane"]);
        schema.completeQueryForOwner("queued", "new", 3);
        schema.ngOnDestroy();
        vi.runAllTimers();
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.postMessage.mock.calls.filter(call => call[0].type === "SearchCompletionRequest")).toHaveLength(2);
    });
});
