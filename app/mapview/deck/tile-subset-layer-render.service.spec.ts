import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {
    getTileSubsetLayerRenderAutoWorkerCount,
    TileSubsetLayerRenderService
} from "./tile-subset-layer-render.service";

function completedBlock(
    service: TileSubsetLayerRenderService,
    current = true
) {
    const internal = service as any;
    const taskId = "block-task";
    const visualizationId = "block-visualization";
    const renderSignature = "block-signature";
    const resolve = vi.fn();
    const reject = vi.fn();
    const task = {
        taskId,
        visualizationId,
        renderSignature,
        tileIds: [1, 2, 3, 4],
        inputGeometryVertexCount: 16_000
    };
    internal.latestSignatureByVisualization.set(
        visualizationId,
        current ? renderSignature : "replacement-signature"
    );
    internal.inFlight.set(taskId, {
        task,
        resolve,
        reject,
        queuedAt: 0,
        dispatchedAt: performance.now()
    });
    internal.runningTaskIdByWorker[0] = taskId;
    internal.pump = vi.fn().mockResolvedValue(undefined);
    internal.handleResult(0, {
        type: "TileSubsetLayerRenderResult",
        taskId,
        visualizationId,
        renderSignature,
        timings: {
            deserializeMs: 1,
            deserializeMsBySubset: [1],
            renderMs: 2,
            totalMs: 3
        }
    });
    return {resolve, reject};
}

describe("TileSubsetLayerRenderService block presentation", () => {
    it("reports visible Deck cadence at p90 instead of callback duration", () => {
        const service = new TileSubsetLayerRenderService();
        for (const interval of [16, 17, 18, 950, 1_000]) {
            service.recordDeckFrameTime(0, interval);
        }
        service.recordDeckFrameTime(1, 33);

        expect(service.currentFrameTimeMs()).toBe(1_000);

        service.clearDeckFrameTime(0);
        expect(service.currentFrameTimeMs()).toBe(33);
    });

    it("exposes live block policy without allocating workers", () => {
        const workerCount = new BehaviorSubject(0);
        const debugBlocks = new BehaviorSubject(false);
        const vertexLimit = new BehaviorSubject(16_384);
        const appState = {
            tileSubsetRenderWorkerCountState: workerCount,
            debugRenderBlocksState: debugBlocks,
            renderBlockVertexLimitState: vertexLimit,
            get tileSubsetRenderWorkerCount() {
                return workerCount.getValue();
            },
            get debugRenderBlocks() {
                return debugBlocks.getValue();
            },
            get renderBlockVertexLimit() {
                return vertexLimit.getValue();
            }
        };
        const service = new TileSubsetLayerRenderService(appState as any);
        const changes: string[] = [];
        service.policyChanged.subscribe(change => changes.push(change));

        debugBlocks.next(true);
        vertexLimit.next(32_768);

        expect(service.debugRenderBlocksEnabled()).toBe(true);
        expect(service.blockVertexLimit()).toBe(32_768);
        expect(changes).toEqual([
            "debug-blocks",
            "block-vertex-limit"
        ]);
        expect(service.debugSnapshot()).toMatchObject({
            workers: getTileSubsetLayerRenderAutoWorkerCount(),
            allocatedWorkers: 0
        });
    });

    it("releases a completed block immediately without a viewport-wide gate", () => {
        const service = new TileSubsetLayerRenderService();
        const {resolve, reject} = completedBlock(service);

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(reject).not.toHaveBeenCalled();
        expect(service.debugSnapshot()).toMatchObject({
            ready: 0,
            completed: 1,
            completedTiles: 4,
            released: 1,
            releaseBatches: 1,
            latestBlockTiles: 4,
            maxBlockTiles: 4,
            latestBlockGeometryVertices: 16_000,
            maxBlockGeometryVertices: 16_000,
            maxAggregateGeometryVertices: 16_000,
            blockSizeHistogram: {"4": 1}
        });
    });

    it("rejects a block superseded while its worker was running", () => {
        const service = new TileSubsetLayerRenderService();
        const {resolve, reject} = completedBlock(service, false);

        expect(resolve).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledTimes(1);
        expect(service.debugSnapshot()).toMatchObject({
            completed: 0,
            released: 0,
            stale: 1
        });
    });

    it("releases simultaneously active blocks as one progressive wave", () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        internal.pump = vi.fn().mockResolvedValue(undefined);
        const resolves = [vi.fn(), vi.fn()];

        for (let index = 0; index < 2; ++index) {
            const taskId = `block-task-${index}`;
            const visualizationId = `block-visualization-${index}`;
            const renderSignature = `block-signature-${index}`;
            const task = {
                taskId,
                visualizationId,
                renderSignature,
                tileIds: [index + 1],
                inputGeometryVertexCount: 4_000
            };
            internal.latestSignatureByVisualization.set(
                visualizationId,
                renderSignature
            );
            internal.inFlight.set(taskId, {
                task,
                resolve: resolves[index],
                reject: vi.fn(),
                queuedAt: 0,
                dispatchedAt: performance.now()
            });
            internal.runningTaskIdByWorker[index] = taskId;
        }

        for (let index = 0; index < 2; ++index) {
            internal.handleResult(index, {
                type: "TileSubsetLayerRenderResult",
                taskId: `block-task-${index}`,
                visualizationId: `block-visualization-${index}`,
                renderSignature: `block-signature-${index}`,
                timings: {
                    deserializeMs: 1,
                    deserializeMsBySubset: [1],
                    renderMs: 2,
                    totalMs: 3
                }
            });
            if (index === 0) {
                expect(resolves[0]).not.toHaveBeenCalled();
                expect(service.debugSnapshot().ready).toBe(1);
            }
        }

        expect(resolves[0]).toHaveBeenCalledTimes(1);
        expect(resolves[1]).toHaveBeenCalledTimes(1);
        expect(service.debugSnapshot()).toMatchObject({
            ready: 0,
            completed: 2,
            released: 2,
            releaseBatches: 1
        });
    });

    it("buffers later results for at most two worker waves without idling workers", () => {
        vi.useFakeTimers();
        try {
            const service = new TileSubsetLayerRenderService();
            const internal = service as any;
            internal.releasedTaskCount = 1;
            internal.pump = vi.fn().mockResolvedValue(undefined);
            const waveSize =
                getTileSubsetLayerRenderAutoWorkerCount() * 2;
            const resolves = Array.from(
                {length: waveSize},
                () => vi.fn()
            );

            for (let index = 0; index < waveSize; ++index) {
                const task = {
                    taskId: `later-task-${index}`,
                    visualizationId: `later-visualization-${index}`,
                    renderSignature: `later-signature-${index}`,
                    tileIds: [index],
                    inputGeometryVertexCount: 1
                };
                internal.latestSignatureByVisualization.set(
                    task.visualizationId,
                    task.renderSignature
                );
                internal.enqueueReadyResult(
                    {
                        task,
                        resolve: resolves[index],
                        reject: vi.fn(),
                        queuedAt: 0
                    },
                    {timings: {totalMs: 0}}
                );
                if (index === 0) {
                    expect(service.availableWorkerSlots()).toBe(
                        getTileSubsetLayerRenderAutoWorkerCount()
                    );
                }
                if (index < waveSize - 1) {
                    expect(resolves[index]).not.toHaveBeenCalled();
                }
            }

            for (const resolve of resolves) {
                expect(resolve).toHaveBeenCalledTimes(1);
            }
            expect(service.debugSnapshot()).toMatchObject({
                ready: 0,
                released: waveSize + 1,
                releaseBatches: 1
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
