import {describe, expect, it, vi} from "vitest";
import {
    TileSubsetLayerRenderService
} from "./tile-subset-layer-render.service";

const EMPTY_SCENE = {
    generation: 1,
    revision: 2,
    materialCount: 3,
    activeContributionCount: 4,
    activeOriginCount: 5,
    pickingHighWater: 6,
    pickingFragmentation: 7,
    zIndexHighWater: 8,
    zIndexUpdateMs: 9,
    labels: 8,
    stores: [{
        materialKey: 1n,
        recordStride: 16,
        capacityRecords: 100,
        highWaterRecords: 75,
        fragmentedRecords: 5,
        allocatedBytes: 1_600,
        uploadedBytes: 800,
        uploadCount: 2,
        growthCount: 1
    }]
};

function completedTile(
    service: TileSubsetLayerRenderService,
    current = true,
    packets: Uint8Array[] = [new Uint8Array(128)]
) {
    const internal = service as any;
    const taskId = "tile-task";
    const visualizationId = "tile-visualization";
    const renderSignature = "tile-signature";
    const resolve = vi.fn();
    const reject = vi.fn();
    const admit = vi.fn();
    const task = {
        taskId,
        visualizationId,
        renderSignature,
        tileId: 1,
        inputGeometryVertexCount: 4_000,
        catalogRevision: 1,
        mapId: "Map",
        stringPoolId: "pool",
        fieldDictBlob: new Uint8Array([1]),
        styleKey: "style",
        iconCatalogVersion: 0
    };
    internal.latestSignatureByVisualization.set(
        visualizationId,
        current ? renderSignature : "replacement-signature"
    );
    internal.inFlight.set(taskId, {
        task,
        admit,
        resolve,
        reject,
        queuedAt: 0,
        dispatchedAt: performance.now()
    });
    internal.workers[0] = {postMessage: vi.fn()};
    internal.runningTaskIdByWorker[0] = taskId;
    internal.catalogKeysByWorker[0] = new Set();
    internal.fieldDictSizesByWorker[0] = new Map();
    internal.styleKeysByWorker[0] = new Set();
    internal.iconCatalogVersionByWorker[0] = -1;
    internal.pump = vi.fn().mockResolvedValue(undefined);
    internal.handleResult(0, {
        type: "TileSubsetLayerRenderResult",
        taskId,
        visualizationId,
        renderSignature,
        packets,
        bridge: {
            gltfNodes: {},
            gltfPickProxies: {}
        },
        vertexCount: 4_000,
        timings: {
            deserializeMs: 1,
            runMs: 1,
            packetMs: 0.5,
            bridgeMs: 0.5,
            renderMs: 2,
            totalMs: 3
        }
    });
    return {admit, resolve, reject};
}

describe("TileSubsetLayerRenderService GPU admission", () => {
    it("retains subset bytes and leaves their worker clone to structured clone", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const postMessage = vi.fn();
        const resolve = vi.fn();
        const reject = vi.fn();
        const subsetBlob = new Uint8Array([1, 2, 3, 4]);
        const task = {
            type: "TileSubsetLayerRenderTask",
            taskId: "tile-task",
            visualizationId: "tile-visualization",
            renderSignature: "tile-signature",
            tileId: 1,
            subsetBlob,
            catalogRevision: 1,
            mapId: "Map",
            stringPoolId: "pool",
            styleKey: "style",
            iconCatalogVersion: 0,
            dataSourceInfoBlob: new Uint8Array([5]),
            fieldDictBlob: new Uint8Array([6]),
            styleSource: "rules: []"
        };
        internal.workers.push({postMessage});
        internal.runningTaskIdByWorker.push(null);
        internal.catalogKeysByWorker.push(new Set());
        internal.fieldDictSizesByWorker.push(new Map());
        internal.styleKeysByWorker.push(new Set());
        internal.iconCatalogVersionByWorker.push(-1);
        internal.idleWorkers.push(0);
        internal.queue.push({
            task,
            admit: vi.fn(),
            resolve,
            reject,
            queuedAt: performance.now()
        });
        internal.latestSignatureByVisualization.set(
            task.visualizationId,
            task.renderSignature
        );
        internal.ensureWorkers = vi.fn().mockResolvedValue(undefined);
        internal.activeWorkerCount = vi.fn().mockReturnValue(1);

        await internal.pump();

        const [outbound, transferables] = postMessage.mock.calls[0];
        expect(outbound.subsetBlob).toBe(subsetBlob);
        expect(transferables).not.toContain(subsetBlob.buffer);
        expect([...subsetBlob]).toEqual([1, 2, 3, 4]);
        expect(internal.catalogKeysByWorker[0]).toEqual(new Set());
        expect(internal.styleKeysByWorker[0]).toEqual(new Set());

        internal.handleResult(0, {
            type: "TileSubsetLayerRenderResult",
            taskId: task.taskId,
            visualizationId: task.visualizationId,
            renderSignature: task.renderSignature,
            packets: [new Uint8Array(64)],
            bridge: {
                gltfNodes: {},
                gltfPickProxies: {}
            },
            vertexCount: 1,
            timings: {
                deserializeMs: 0,
                runMs: 0,
                packetMs: 0,
                bridgeMs: 0,
                renderMs: 0,
                totalMs: 0
            }
        });

        expect(internal.catalogKeysByWorker[0]).toEqual(new Set(["1:Map"]));
        expect(internal.fieldDictSizesByWorker[0].get("1:Map:pool")).toBe(1);
        expect(internal.styleKeysByWorker[0]).toEqual(new Set(["style"]));
        expect(internal.iconCatalogVersionByWorker[0]).toBe(0);
        expect(reject).not.toHaveBeenCalled();
    });

    it("does not retain cache state when posting a worker task fails", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const reject = vi.fn();
        const task = {
            type: "TileSubsetLayerRenderTask",
            taskId: "tile-task",
            visualizationId: "tile-visualization",
            renderSignature: "tile-signature",
            tileId: 1,
            subsetBlob: new Uint8Array([1]),
            catalogRevision: 1,
            mapId: "Map",
            stringPoolId: "pool",
            styleKey: "style",
            iconCatalogVersion: 0,
            dataSourceInfoBlob: new Uint8Array([2]),
            fieldDictBlob: new Uint8Array([3]),
            styleSource: "rules: []"
        };
        internal.workers[0] = {
            postMessage: vi.fn(() => {
                throw new DOMException("Clone failed", "DataCloneError");
            })
        };
        internal.runningTaskIdByWorker[0] = null;
        internal.catalogKeysByWorker[0] = new Set();
        internal.fieldDictSizesByWorker[0] = new Map();
        internal.styleKeysByWorker[0] = new Set();
        internal.iconCatalogVersionByWorker[0] = -1;
        internal.idleWorkers.push(0);
        internal.queue.push({
            task,
            admit: vi.fn(),
            resolve: vi.fn(),
            reject,
            queuedAt: performance.now()
        });
        internal.latestSignatureByVisualization.set(
            task.visualizationId,
            task.renderSignature
        );
        internal.ensureWorkers = vi.fn().mockResolvedValue(undefined);
        internal.activeWorkerCount = vi.fn().mockReturnValue(1);

        await internal.pump();

        expect(reject).toHaveBeenCalledOnce();
        expect(internal.inFlight.size).toBe(0);
        expect(internal.idleWorkers).toEqual([0]);
        expect(internal.catalogKeysByWorker[0]).toEqual(new Set());
        expect(service.debugSnapshot().failed).toBe(1);
    });

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

    it("aggregates persistent GPU scene diagnostics across views", () => {
        const service = new TileSubsetLayerRenderService();
        const firstProvider = vi.fn(() => ({
            layers: 12,
            scene: EMPTY_SCENE as any
        }));
        const secondProvider = vi.fn(() => ({
            layers: 5,
            scene: {
                ...EMPTY_SCENE,
                materialCount: 1,
                activeContributionCount: 2,
                stores: []
            } as any
        }));
        service.setDeckPresentationDiagnosticsProvider(0, firstProvider);
        service.setDeckPresentationDiagnosticsProvider(1, secondProvider);

        expect(firstProvider).not.toHaveBeenCalled();
        expect(secondProvider).not.toHaveBeenCalled();

        expect(service.currentDeckPresentationDiagnostics()).toMatchObject({
            views: 2,
            layers: 17,
            materials: 4,
            activeContributions: 6,
            activeOrigins: 10,
            zIndexHighWater: 16,
            maxZIndexUpdateMs: 9,
            stores: 1,
            capacityRecords: 100,
            allocatedBytes: 1_600
        });
        expect(firstProvider).toHaveBeenCalledOnce();
        expect(secondProvider).toHaveBeenCalledOnce();

        service.clearDeckPresentationDiagnostics(0);
        expect(service.currentDeckPresentationDiagnostics()).toMatchObject({
            views: 1,
            layers: 5,
            activeContributions: 2
        });
    });

    it("holds the worker credit until one completed packet is frame-admitted", () => {
        const callbacks: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn(callback => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const {admit, resolve, reject} = completedTile(service);

            expect(resolve).not.toHaveBeenCalled();
            expect(reject).not.toHaveBeenCalled();
            expect(service.debugSnapshot()).toMatchObject({
                ready: 1,
                readyTiles: 1,
                readyPacketBytes: 128,
                inFlight: 1,
                completed: 0
            });

            callbacks.shift()!(performance.now());

            expect(admit).toHaveBeenCalledTimes(1);
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(service.debugSnapshot()).toMatchObject({
                ready: 0,
                inFlight: 0,
                completed: 1,
                completedTiles: 1,
                latestGeometryVertices: 4_000,
                maxGeometryVertices: 4_000
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("retains worker credit and revision state across bounded fragments", () => {
        const callbacks: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn(callback => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const fragmentBytes = 3 * 1024 * 1024;
            const {admit, resolve} = completedTile(service, true, [
                new Uint8Array(fragmentBytes),
                new Uint8Array(fragmentBytes)
            ]);

            callbacks.shift()!(performance.now());
            expect(admit).toHaveBeenCalledTimes(1);
            expect(resolve).not.toHaveBeenCalled();
            expect(service.debugSnapshot()).toMatchObject({
                ready: 1,
                readyPacketBytes: fragmentBytes,
                inFlight: 1,
                completed: 0
            });
            expect(callbacks).toHaveLength(1);

            callbacks.shift()!(performance.now());
            expect(admit).toHaveBeenCalledTimes(2);
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(service.debugSnapshot()).toMatchObject({
                ready: 0,
                inFlight: 0,
                completed: 1
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("rejects a tile superseded while its worker was running", () => {
        const service = new TileSubsetLayerRenderService();
        const {resolve, reject} = completedTile(service, false);

        expect(resolve).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledTimes(1);
        expect(service.debugSnapshot()).toMatchObject({
            completed: 0,
            stale: 1,
            ready: 0,
            inFlight: 0
        });
    });

    it("rejects a worker response whose task identity changed in flight", () => {
        const callbacks: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn(callback => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const internal = service as any;
            const {resolve, reject} = completedTile(service);
            const ready = internal.ready.pop();
            internal.inFlight.set(ready.pending.task.taskId, ready.pending);
            internal.runningTaskIdByWorker[0] = ready.pending.task.taskId;

            internal.handleResult(0, {
                type: "TileSubsetLayerRenderResult",
                taskId: "another-task",
                visualizationId: ready.pending.task.visualizationId,
                renderSignature: ready.pending.task.renderSignature,
                packets: [new Uint8Array(64)],
                bridge: {},
                vertexCount: 0,
                timings: {totalMs: 0}
            });

            expect(resolve).not.toHaveBeenCalled();
            expect(reject).toHaveBeenCalledTimes(1);
            expect(service.debugSnapshot()).toMatchObject({
                failed: 1,
                inFlight: 0,
                ready: 0
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("admits several cheap worker results in one animation frame", () => {
        const callbacks: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn(callback => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const internal = service as any;
            internal.pump = vi.fn().mockResolvedValue(undefined);
            const resolves = [vi.fn(), vi.fn()];
            const admits = [vi.fn(), vi.fn()];

            for (let index = 0; index < 2; ++index) {
                const task = {
                    taskId: `tile-task-${index}`,
                    visualizationId: `tile-visualization-${index}`,
                    renderSignature: `tile-signature-${index}`,
                    tileId: index + 1,
                    inputGeometryVertexCount: 1,
                    catalogRevision: 1,
                    mapId: "Map",
                    stringPoolId: "pool",
                    fieldDictBlob: new Uint8Array([1]),
                    styleKey: "style",
                    iconCatalogVersion: 0
                };
                internal.latestSignatureByVisualization.set(
                    task.visualizationId,
                    task.renderSignature
                );
                internal.inFlight.set(task.taskId, {
                    task,
                    admit: admits[index],
                    resolve: resolves[index],
                    reject: vi.fn(),
                    queuedAt: 0,
                    dispatchedAt: performance.now()
                });
                internal.runningTaskIdByWorker[index] = task.taskId;
                internal.workers[index] = {postMessage: vi.fn()};
                internal.catalogKeysByWorker[index] = new Set();
                internal.fieldDictSizesByWorker[index] = new Map();
                internal.styleKeysByWorker[index] = new Set();
                internal.iconCatalogVersionByWorker[index] = -1;
                internal.handleResult(index, {
                    type: "TileSubsetLayerRenderResult",
                    taskId: task.taskId,
                    visualizationId: task.visualizationId,
                    renderSignature: task.renderSignature,
                    packets: [new Uint8Array(64)],
                    bridge: {
                        gltfNodes: {},
                        gltfPickProxies: {}
                    },
                    vertexCount: 1,
                    timings: {
                        deserializeMs: 0,
                        runMs: 0,
                        packetMs: 0,
                        bridgeMs: 0,
                        renderMs: 0,
                        totalMs: 0
                    }
                });
            }

            expect(callbacks).toHaveLength(1);
            expect(service.debugSnapshot().ready).toBe(2);
            callbacks.shift()!(performance.now());
            expect(resolves[0]).toHaveBeenCalledTimes(1);
            expect(resolves[1]).toHaveBeenCalledTimes(1);
            expect(admits[0]).toHaveBeenCalledTimes(1);
            expect(admits[1]).toHaveBeenCalledTimes(1);
            expect(callbacks).toHaveLength(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("removes a queued task when worker initialization fails", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        internal.ensureWorkers = vi.fn().mockRejectedValue(
            new Error("WASM init failed")
        );

        const promise = service.render({
            visualizationId: "tile",
            renderSignature: "revision",
            tileId: 1
        } as any);

        await expect(promise).rejects.toThrow("WASM init failed");
        expect(internal.queue).toHaveLength(0);
        expect(service.debugSnapshot().failed).toBe(1);
    });

    it("forgets private caches and replaces a failed runtime worker", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const terminate = vi.fn();
        const reject = vi.fn();
        const pending = {
            task: {
                taskId: "running",
                visualizationId: "tile",
                renderSignature: "revision",
                tileId: 1
            },
            admit: vi.fn(),
            resolve: vi.fn(),
            reject,
            queuedAt: 0,
            dispatchedAt: performance.now()
        };
        internal.workers[0] = {terminate, onmessage: vi.fn(), onerror: vi.fn()};
        internal.runningTaskIdByWorker[0] = pending.task.taskId;
        internal.inFlight.set(pending.task.taskId, pending);
        internal.ready.push({
            workerIndex: 0,
            pending,
            buffers: {packets: [new Uint8Array(16)]},
            nativeMs: 0,
            roundTripMs: 0,
            nextPacketIndex: 0
        });
        internal.catalogKeysByWorker[0] = new Set(["catalog"]);
        internal.fieldDictSizesByWorker[0] = new Map([["dict", 1]]);
        internal.styleKeysByWorker[0] = new Set(["style"]);
        internal.iconCatalogVersionByWorker[0] = 4;
        internal.pump = vi.fn().mockResolvedValue(undefined);
        internal.initializeWorker = vi.fn(async (index: number) => {
            internal.workers[index] = {terminate: vi.fn()};
            internal.resetWorkerState(index);
            internal.idleWorkers.push(index);
        });

        internal.handleWorkerError(0, {message: "worker crashed"});
        await internal.initialization;
        await Promise.resolve();

        expect(terminate).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(internal.ready).toHaveLength(0);
        expect(internal.inFlight.size).toBe(0);
        expect(internal.catalogKeysByWorker[0]).toEqual(new Set());
        expect(internal.styleKeysByWorker[0]).toEqual(new Set());
        expect(internal.iconCatalogVersionByWorker[0]).toBe(-1);
        expect(internal.initializeWorker).toHaveBeenCalledWith(0);
        expect(internal.idleWorkers).toEqual([0]);
    });
});
