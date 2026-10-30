import { describe, expect, it } from "vitest";
import { testPersistence } from "../../support/state-owners";
import { OmnibarState } from "../../../app/omnibar/omnibar.state";

describe("omnibar state persistence", () => {
    it("restores legacy entries and valid neighbours using the deployed history key", () => {
        const state = new OmnibarState(testPersistence());
        state.historyState.deserialize(JSON.stringify([
            [2, "48.1, 11.2"],
            ["features", " true "],
            { invalid: true },
            { version: 2, actionId: "features", input: "true" }
        ]));
        expect(state.historyState.name).toBe("searchHistory");
        expect(state.historyState.value).toEqual([
            [2, "48.1, 11.2"],
            { version: 2, actionId: "features", input: "true" }
        ]);
        state.historyState.deserialize('["features","false"]');
        expect(state.historyState.value).toEqual([{ version: 2, actionId: "features", input: "false" }]);
        state.historyState.deserialize('[["features","valid neighbour"],"malformed entry"]');
        expect(state.historyState.value).toEqual([{ version: 2, actionId: "features", input: "valid neighbour" }]);
        state.historyState.deserialize('[[0.5,"invalid numeric identity"],["features","valid neighbour"]]');
        expect(state.historyState.value).toEqual([{ version: 2, actionId: "features", input: "valid neighbour" }]);
    });

    it("round-trips command payloads without compacting booleans or publishing history in links", () => {
        const state = new OmnibarState(testPersistence());
        const entry = {
            version: 2 as const,
            actionId: "features",
            input: "true",
            payload: { selectedMapLayersManual: true, enabled: false }
        };
        state.remember(entry);
        const saved = state.historyState.serialize(false)!['searchHistory'] as string;
        expect(JSON.parse(saved)).toEqual([entry]);
        const restored = new OmnibarState(testPersistence());
        restored.historyState.deserialize(saved);
        expect(restored.historyState.value).toEqual([entry]);
        expect(restored.historyState.serialize(true)).toBeUndefined();
        expect(restored.historyState.isSnapshotState()).toBe(false);
        expect(restored.historyState.isConfigDefaultState()).toBe(false);
    });

    it("keeps recent commands first, bounds history, and publishes resets to consumers", () => {
        const state = new OmnibarState(testPersistence());
        state.replaceHistory(Array.from({ length: 110 }, (_, index) => ({
            version: 2, actionId: "features", input: String(index)
        })));
        state.remember({ version: 2, actionId: "features", input: "5", actionName: "Updated name" });
        expect(state.historyState.value).toHaveLength(100);
        expect(state.historyState.value[0]).toMatchObject({ input: "5", actionName: "Updated name" });
        const counts: number[] = [];
        const subscription = state.historyState.subscribe(entries => counts.push(entries.length));
        state.historyState.resetToDefault();
        expect(counts).toEqual([100, 0]);
        subscription.unsubscribe();
    });
});
