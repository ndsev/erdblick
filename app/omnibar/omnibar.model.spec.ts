import { describe, expect, it } from "vitest";
import { testPersistence } from "../../test/state-owners";
import { OmnibarModel } from "./omnibar.model";

describe("omnibar model persistence", () => {
    it("restores legacy entries and valid neighbours using the deployed history key", () => {
        const model = new OmnibarModel(testPersistence());
        model.historyState.deserialize(JSON.stringify([
            [2, "48.1, 11.2"],
            ["features", " true "],
            { invalid: true },
            { version: 2, actionId: "features", input: "true" }
        ]));
        expect(model.historyState.name).toBe("searchHistory");
        expect(model.historyState.value).toEqual([
            [2, "48.1, 11.2"],
            { version: 2, actionId: "features", input: "true" }
        ]);
        model.historyState.deserialize('["features","false"]');
        expect(model.historyState.value).toEqual([{ version: 2, actionId: "features", input: "false" }]);
        model.historyState.deserialize('[["features","valid neighbour"],"malformed entry"]');
        expect(model.historyState.value).toEqual([{ version: 2, actionId: "features", input: "valid neighbour" }]);
        model.historyState.deserialize('[[0.5,"invalid numeric identity"],["features","valid neighbour"]]');
        expect(model.historyState.value).toEqual([{ version: 2, actionId: "features", input: "valid neighbour" }]);
    });

    it("round-trips command payloads without compacting booleans or publishing history in links", () => {
        const model = new OmnibarModel(testPersistence());
        const entry = {
            version: 2 as const,
            actionId: "features",
            input: "true",
            payload: { selectedMapLayersManual: true, enabled: false }
        };
        model.remember(entry);
        const saved = model.historyState.serialize(false)!['searchHistory'] as string;
        expect(JSON.parse(saved)).toEqual([entry]);
        const restored = new OmnibarModel(testPersistence());
        restored.historyState.deserialize(saved);
        expect(restored.historyState.value).toEqual([entry]);
        expect(restored.historyState.serialize(true)).toBeUndefined();
        expect(restored.historyState.isSnapshotState()).toBe(false);
        expect(restored.historyState.isConfigDefaultState()).toBe(false);
    });

    it("keeps recent commands first, bounds history, and publishes resets to consumers", () => {
        const model = new OmnibarModel(testPersistence());
        model.replaceHistory(Array.from({ length: 110 }, (_, index) => ({
            version: 2, actionId: "features", input: String(index)
        })));
        model.remember({ version: 2, actionId: "features", input: "5", actionName: "Updated name" });
        expect(model.historyState.value).toHaveLength(100);
        expect(model.historyState.value[0]).toMatchObject({ input: "5", actionName: "Updated name" });
        const counts: number[] = [];
        const subscription = model.historyState.subscribe(entries => counts.push(entries.length));
        model.historyState.resetToDefault();
        expect(counts).toEqual([100, 0]);
        subscription.unsubscribe();
    });
});
