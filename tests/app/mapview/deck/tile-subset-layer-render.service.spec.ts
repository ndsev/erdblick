import {POINT_CLOUD_MAX_POINTS} from "../../../../app/mapview/point-cloud-policy.model";
import {MapViewState} from "../../../../app/mapview/mapview.state";
import {testPersistence} from "../../../support/state-owners";
import {DEFAULT_POINT_CLOUD_POLICY} from "../../../../app/mapview/point-cloud-policy.model";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {
    TileSubsetLayerRenderService
} from "../../../../app/mapview/deck/tile-subset-layer-render.service";
import {gpuMemoryBudget} from "../../../../app/mapview/deck/gpu-memory-budget.model";

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
    lastContributionLookupRows: 10,
    lastZIndexLookupRows: 11,
    lookupUploadedBytes: 12,
    lookupUploadCount: 13,
    lookupGrowthCount: 14,
    fatalPresentationFailures: 15,
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
    const prepare = vi.fn();
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
        prepare,
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
    return {admit, prepare, resolve, reject};
}

describe("TileSubsetLayerRenderService GPU admission", () => {
    it("resumes queued work when management is disabled and reclaims on re-enabling", async () => {
        const persistence = testPersistence();
        const state = new MapViewState(persistence);
        const management = state.gpuMemoryManagementEnabledState;
        const gpuMiB = state.pointCloudGpuMemoryMiBState;
        gpuMiB.next(16);
        const service = new TileSubsetLayerRenderService(state);
        const internal = service as any;
        const pump = vi.spyOn(internal, "pump").mockResolvedValue(undefined);
        const changed = vi.fn();
        const subscription = service.pointCloudPolicyChanged.subscribe(changed);
        let release: (() => void) | undefined;
        try {
            await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
            expect(pump).not.toHaveBeenCalled(); // Preferences alone must not start the worker pool.
            internal.queue = [{}];
            management.next(false);
            await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
            expect(changed).toHaveBeenLastCalledWith(false);
            expect(pump).toHaveBeenCalledOnce();
            release = gpuMemoryBudget.allocate(32 * 1048576);
            gpuMiB.next(8);
            await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
            expect(changed).toHaveBeenLastCalledWith(false);
            management.next(true);
            await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(4));
            expect(changed).toHaveBeenLastCalledWith(true);
            expect(() => gpuMemoryBudget.allocate(1)).toThrow("GPU allocation allowance exhausted");
        } finally {
            subscription.unsubscribe();
            persistence.ngOnDestroy();
            release?.();
            gpuMemoryBudget.setEnabled(true);
            gpuMemoryBudget.setLimit(DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB * 1048576);
        }
    });

    it("reclaims worker heaps and outstanding claims when retiring running work", () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const {reject} = completedTile(service);
        const terminate = vi.fn();
        internal.workers[0].terminate = terminate;
        internal.workerHeapBytes[0] = 1000;
        const pending = internal.inFlight.get("tile-task");
        pending.workingBytes = 123;
        internal.workingBytes = 123;
        const before = gpuMemoryBudget.reservedBytes;
        pending.gpuReservation = gpuMemoryBudget.reserve(100);
        internal.retireWorker(0);
        expect(terminate).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(internal.inFlight.size).toBe(0);
        expect(internal.ready).toHaveLength(0);
        expect(internal.workerHeapBytes[0]).toBe(0);
        expect(internal.workingBytes).toBe(0);
        expect(gpuMemoryBudget.reservedBytes).toBe(before);
    });

    it("wakes outer tile scheduling even when retirement cannot admit queued work", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const pump = vi.spyOn(internal, "pump").mockResolvedValue(undefined);
        const changed = vi.fn();
        const subscription = service.capacityChanged.subscribe(changed);
        const finish = gpuMemoryBudget.beginRetirement();
        internal.waitForGpuRetirement();
        expect(pump).not.toHaveBeenCalled();
        finish();
        await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(pump).toHaveBeenCalledOnce();
        subscription.unsubscribe();
    });

    it.each([false, true])("waits for retirement and permits existing-buffer reuse without changing point counts (%s)", async (retiring) => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const postMessage = vi.fn();
        const mib = 1048576;
        gpuMemoryBudget.setLimit(10 * mib);
        const releaseExisting = gpuMemoryBudget.allocate(10 * mib);
        const finishRetirement = retiring ? gpuMemoryBudget.beginRetirement() : null;
        const task = {
            taskId: "cloud", visualizationId: "cloud", renderSignature: "cloud",
            subsetBlob: new Uint8Array(4), inputGeometryVertexCount: 10000,
            mapId: "Map", catalogRevision: 1, stringPoolId: "pool", styleKey: "style",
            iconCatalogVersion: 0,
            pointCloud: {enabled: true, maxPoints: 10000, spacingMeters: 1, cacheKey: "cloud"}
        };
        const pending = {task, admit: vi.fn(), prepare: vi.fn(), resolve: vi.fn(), reject: vi.fn(), queuedAt: 0};
        internal.workers = [{postMessage}];
        internal.runningTaskIdByWorker = [null];
        internal.workerHeapBytes = [0];
        internal.catalogKeysByWorker = [new Set(["1:Map"])];
        internal.fieldDictSizesByWorker = [new Map()];
        internal.styleKeysByWorker = [new Set()];
        internal.iconCatalogVersionByWorker = [-1];
        internal.idleWorkers = [0];
        internal.queue = [pending];
        internal.latestSignatureByVisualization.set("cloud", "cloud");
        internal.ensureWorkers = vi.fn().mockResolvedValue(undefined);
        internal.activeWorkerCount = vi.fn().mockReturnValue(1);
        try {
            await internal.pump();
            if (retiring) {
                expect(postMessage).not.toHaveBeenCalled();
                expect(internal.queue).toHaveLength(1);
                releaseExisting();
                finishRetirement!();
                await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
            }
            expect(pending.reject).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledOnce();
            expect(postMessage.mock.calls[0][0].pointCloud.maxPoints).toBe(10000);
            expect(gpuMemoryBudget.allocatedBytes + gpuMemoryBudget.reservedBytes).toBeLessThanOrEqual(10 * mib);
        } finally {
            (pending as any).gpuReservation?.release();
            releaseExisting();
            finishRetirement?.();
            gpuMemoryBudget.setLimit(DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB * mib);
        }
    });

    it("dispatches a smaller queued job while a larger job waits for running work", async () => {
        const service = new TileSubsetLayerRenderService();
        const internal = service as any;
        const postMessage = vi.fn();
        const mib = 1048576;
        gpuMemoryBudget.setLimit(10 * mib);
        const releaseExisting = gpuMemoryBudget.allocate(8 * mib);
        const jobs = [30000, 1000].map((points, index) => ({
            task: {taskId: String(index), visualizationId: String(index), renderSignature: "same",
                subsetBlob: new Uint8Array(4), inputGeometryVertexCount: points,
                mapId: "Map", catalogRevision: 1, stringPoolId: "pool", styleKey: "style", iconCatalogVersion: 0,
                pointCloud: {enabled: true, maxPoints: points, spacingMeters: 0, cacheKey: String(index)}},
            admit: vi.fn(), prepare: vi.fn(), resolve: vi.fn(), reject: vi.fn(), queuedAt: 0
        }));
        internal.workers = [{postMessage}, {postMessage}];
        internal.runningTaskIdByWorker = ["running", null];
        internal.inFlight.set("running", {});
        internal.workerHeapBytes = [0, 0];
        // This fixture isolates memory admission after both workers have acknowledged the schema.
        internal.catalogKeysByWorker = [new Set(["1:Map"]), new Set(["1:Map"])];
        internal.fieldDictSizesByWorker = [new Map(), new Map()];
        internal.styleKeysByWorker = [new Set(), new Set()];
        internal.iconCatalogVersionByWorker = [-1, -1];
        internal.idleWorkers = [1];
        internal.queue = [...jobs];
        jobs.forEach(job => internal.latestSignatureByVisualization.set(job.task.visualizationId, "same"));
        internal.ensureWorkers = vi.fn().mockResolvedValue(undefined);
        internal.activeWorkerCount = () => 2;
        try {
            await internal.pump();
            expect(postMessage).toHaveBeenCalledOnce();
            expect(postMessage.mock.calls[0][0].taskId).toBe("1");
            expect(internal.queue).toEqual([jobs[0]]);
        } finally {
            jobs.forEach(job => (job as any).gpuReservation?.release());
            releaseExisting();
            gpuMemoryBudget.setLimit(DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB * mib);
        }
    });

    it("preloads one emitted worker module and reuses its cached source", async () => {
        const workerSources: Array<string | URL> = [];
        const workerModuleUrl = "https://viewer.test/worker-HASH.js";
        const cachedWorkerUrl = "blob:cached-subset-render-worker";

        class TestWorker {
            private messageListener:
                ((event: MessageEvent) => void) | null = null;

            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            /** Records the source used for each worker construction. */
            constructor(source: string | URL) {
                workerSources.push(source);
            }

            /** Stores the module-load listener installed by the render service. */
            addEventListener(type: string, listener: (event: MessageEvent) => void): void {
                if (type === "message") {
                    this.messageListener = listener;
                }
            }

            /** Clears the listener after the one-time worker handshake. */
            removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
                if (type === "message" && this.messageListener === listener) {
                    this.messageListener = null;
                }
            }

            /** Responds to initialization exactly like the real worker module. */
            postMessage(message: {type: string}): void {
                if (message.type !== "TileSubsetLayerRenderWorkerInit") {
                    return;
                }
                queueMicrotask(() => this.messageListener?.({
                    data: {
                        type: "TileSubsetLayerRenderWorkerReady",
                        scriptUrl: workerModuleUrl
                    }
                } as MessageEvent));
            }

            /** Matches the Worker lifecycle surface used by failure cleanup. */
            terminate(): void {}
        }

        const fetchWorker = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            blob: async () => new Blob(["worker source"])
        }));
        const createObjectUrl = vi.spyOn(URL, "createObjectURL")
            .mockReturnValue(cachedWorkerUrl);
        vi.stubGlobal("Worker", TestWorker);
        vi.stubGlobal("fetch", fetchWorker);
        try {
            const service = new TileSubsetLayerRenderService();
            const internal = service as any;

            await service.preloadWorkerSource();
            await internal.initializeWorkers(3);

            expect(workerSources).toHaveLength(3);
            expect(workerSources[0]).toBeInstanceOf(URL);
            expect(workerSources.slice(1)).toEqual([
                cachedWorkerUrl,
                cachedWorkerUrl
            ]);
            expect(fetchWorker).toHaveBeenCalledOnce();
            expect(fetchWorker).toHaveBeenCalledWith(workerModuleUrl, {
                cache: "force-cache"
            });
            expect(createObjectUrl).toHaveBeenCalledOnce();
        } finally {
            createObjectUrl.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it.each(["installed", "failed", "cancelled", "evicted"] as const)(
        "gates rendering on catalog installation and retains subset bytes (%s)", async outcome => {
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
        internal.catalogKeysByWorker.push(new Set(outcome === "evicted" ? ["0:Map"] : []));
        internal.fieldDictSizesByWorker.push(new Map(outcome === "evicted" ? [["0:Map:pool", 1]] : []));
        internal.styleKeysByWorker.push(new Set());
        internal.iconCatalogVersionByWorker.push(-1);
        internal.idleWorkers.push(0);
        internal.queue.push({
            task,
            schemas: [],
            admit: vi.fn(),
            prepare: vi.fn(),
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

        expect(postMessage).toHaveBeenCalledOnce();
        expect(postMessage.mock.calls[0][0].type).toBe("TileSubsetLayerRenderCatalogInstall");
        expect(postMessage.mock.calls[0][0].subsetBlob).toBeUndefined();
        expect(internal.catalogKeysByWorker[0]).not.toContain("1:Map");
        if (outcome === "cancelled") {
            internal.latestSignatureByVisualization.set(task.visualizationId, "replacement-signature");
        }
        internal.handleCatalogInstalled(0, {
            type: "TileSubsetLayerRenderCatalogInstalled", requestId: task.taskId,
            catalogKeys: outcome === "failed" ? [] : ["1:Map"],
            error: outcome === "failed" ? "Schema checksum mismatch" : undefined
        });
        if (outcome === "failed" || outcome === "cancelled") {
            expect(postMessage).toHaveBeenCalledOnce();
            expect(reject).toHaveBeenCalledOnce();
            expect(resolve).not.toHaveBeenCalled();
            expect(internal.inFlight.size).toBe(0);
            expect(internal.idleWorkers).toEqual([0]);
            expect(internal.styleKeysByWorker[0]).toEqual(new Set());
            expect(service.debugSnapshot().failed).toBe(outcome === "failed" ? 1 : 0);
            expect(service.debugSnapshot().stale).toBe(outcome === "cancelled" ? 1 : 0);
            return;
        }
        // An evicted parser no longer owns its field dictionary. Remembering
        // the old byte count would incorrectly suppress its next resend.
        expect(internal.fieldDictSizesByWorker[0].has("0:Map:pool")).toBe(false);
        const [outbound, transferables] = postMessage.mock.calls[1];
        expect(outbound.subsetBlob).toBe(subsetBlob);
        expect(transferables).not.toContain(subsetBlob.buffer);
        expect([...subsetBlob]).toEqual([1, 2, 3, 4]);
        expect(internal.catalogKeysByWorker[0]).toEqual(new Set(["1:Map"]));
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
            prepare: vi.fn(),
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
            lastContributionLookupRows: 20,
            lastZIndexLookupRows: 22,
            lookupUploadedBytes: 24,
            lookupUploadCount: 26,
            lookupGrowthCount: 28,
            fatalPresentationFailures: 30,
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

    it("holds the worker credit until one completed packet is task-admitted", () => {
        const callbacks: Array<() => void> = [];
        vi.stubGlobal("setTimeout", vi.fn((callback: () => void) => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const {admit, prepare, resolve, reject} = completedTile(service);

            expect(prepare).toHaveBeenCalledOnce();
            expect(admit).not.toHaveBeenCalled();
            expect(resolve).not.toHaveBeenCalled();
            expect(reject).not.toHaveBeenCalled();
            expect(service.debugSnapshot()).toMatchObject({
                ready: 1,
                readyTiles: 1,
                readyPacketBytes: 128,
                inFlight: 1,
                completed: 0
            });

            callbacks.shift()!();

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
        const callbacks: Array<() => void> = [];
        vi.stubGlobal("setTimeout", vi.fn((callback: () => void) => {
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

            callbacks.shift()!();
            expect(admit).toHaveBeenCalledTimes(1);
            expect(resolve).not.toHaveBeenCalled();
            expect(service.debugSnapshot()).toMatchObject({
                ready: 1,
                readyPacketBytes: fragmentBytes,
                inFlight: 1,
                completed: 0
            });
            expect((service as any).ready[0].buffers.packets[0].byteLength)
                .toBe(0);
            expect(callbacks).toHaveLength(1);

            callbacks.shift()!();
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

    it("admits render revisions containing more than eight fragments", () => {
        const callbacks: Array<() => void> = [];
        vi.stubGlobal("setTimeout", vi.fn((callback: () => void) => {
            callbacks.push(callback);
            return callbacks.length;
        }));
        try {
            const service = new TileSubsetLayerRenderService();
            const {admit, resolve, reject} = completedTile(
                service,
                true,
                Array.from({length: 9}, () => new Uint8Array(128))
            );

            callbacks.shift()!();

            expect(admit).toHaveBeenCalledTimes(9);
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(resolve.mock.calls[0][0].packets).toEqual([]);
            expect(reject).not.toHaveBeenCalled();
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
        const callbacks: Array<() => void> = [];
        vi.stubGlobal("setTimeout", vi.fn((callback: () => void) => {
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

    it("admits several cheap worker results in one task", () => {
        const callbacks: Array<() => void> = [];
        vi.stubGlobal("setTimeout", vi.fn((callback: () => void) => {
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
                    prepare: vi.fn(),
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
            callbacks.shift()!();
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
            prepare: vi.fn(),
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


describe("point-cloud view allocation", () => {
    it("keeps per-object fidelity independent of other views and visible contributions", () => {
        const service = new TileSubsetLayerRenderService();
        service.registerPointCloud("a", 0, 100);
        const whole = service.pointCloudPolicyFor("a", 1).maxPoints;
        service.registerPointCloud("b", 1, 100);
        service.registerPointCloud("c", 1, 100);
        const first = service.pointCloudPolicyFor("a", 1);
        const second = service.pointCloudPolicyFor("b", 1);
        const third = service.pointCloudPolicyFor("c", 1);
        expect(whole).toBe(POINT_CLOUD_MAX_POINTS);
        expect(first.maxPoints).toBe(whole);
        expect(second.maxPoints).toBe(third.maxPoints);
        expect(first.maxPoints).toBe(second.maxPoints);
        service.unregisterPointCloud("c");
        expect(service.pointCloudPolicyFor("b", 1).maxPoints).toBe(first.maxPoints);
    });

    it("keeps count-based demand independent without broadcasting policy changes", async () => {
        const service = new TileSubsetLayerRenderService();
        const changed = vi.fn();
        const subscription = service.pointCloudPolicyChanged.subscribe(changed);
        service.registerPointCloud("a", 0, 100);
        service.registerPointCloud("b", 0, 200);
        service.registerPointCloud("a", 0, 100);
        await Promise.resolve();
        service.unregisterPointCloud("b");
        expect(changed).not.toHaveBeenCalled();
        const policy = service.pointCloudPolicyFor("a", 1);
        expect(service.pointCloudPolicyFor("a", 1.1, policy.spacingMeters).spacingMeters).toBe(policy.spacingMeters);
        subscription.unsubscribe();
    });
});
