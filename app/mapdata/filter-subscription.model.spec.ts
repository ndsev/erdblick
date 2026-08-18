import {afterEach, describe, expect, it, vi} from "vitest";
import {
    FilterSubscriptionRef,
    type FilterSubscriptionOwner,
    type FilterTileInstallResult,
    type TileSubsetDelivery
} from "./filter-subscription.model";
import {FilterTileState} from "./filter-tile-state.model";

function definition() {
    return {
        mapId: "Map",
        layerId: "Layer",
        channels: []
    };
}

function delivery(
    tileId: number,
    generation: number,
    overrides: Partial<TileSubsetDelivery> = {}
): TileSubsetDelivery {
    return {
        blob: new Uint8Array([tileId]),
        filterId: "styled",
        generation,
        mapId: "Map",
        layerId: "Layer",
        tileId,
        mapTileKey: `Features:Map:Layer:${tileId}`,
        stringPoolId: "source",
        conversionTimestampMs: null,
        ttlMs: null,
        dependencies: [],
        issues: [],
        info: {},
        numEntries: 0,
        geometryVertexCount: 0,
        glbAttachmentName: "",
        receivedAt: 0,
        ...overrides
    };
}

function acceptedInstall(valueVersion = 1) {
    return vi.fn(() => ({
        status: "accepted",
        valueVersion
    } as const));
}

describe("FilterSubscriptionRef", () => {
    afterEach(() => vi.restoreAllMocks());

    it("projects only pending outputs while keeping priorities and roots aligned", () => {
        const updateFilterSubscription = vi.fn();
        const onTile = acceptedInstall();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription,
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {
                tileIds: [1, 2, 3],
                priorityTileIds: [3, 2, 1],
                roots: [
                    {tileId: 2, featureId: "two"},
                    {tileId: 1, featureId: "one"}
                ]
            },
            {onTile}
        );

        expect(ref.accept(delivery(2, ref.generation))).toBe("accepted");

        expect(ref.requestJson()).toMatchObject({
            generation: 1,
            tileIds: [1, 3],
            priorityTileIds: [3, 1],
            roots: [{tileId: 1, featureId: "one"}]
        });
        expect(updateFilterSubscription).toHaveBeenCalledWith(ref, false);
    });

    it("keeps generation while transmitting tile and priority reordering", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1, 2], priorityTileIds: [1]},
            {onTile: acceptedInstall()}
        );

        ref.setCoverage({tileIds: [2, 1], priorityTileIds: [2]});

        expect(ref.generation).toBe(1);
        expect(owner.updateFilterSubscription).toHaveBeenCalledWith(ref, true);
        expect(ref.requestJson()).toMatchObject({
            generation: 1,
            tileIds: [2, 1],
            priorityTileIds: [2]
        });
    });

    it("does not resubmit structurally equal ordered coverage", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const coverage = {
            tileIds: [1, 2],
            priorityTileIds: [2],
            roots: [{
                tileId: 1,
                typeId: "Lane",
                featureId: ["Lane", 1, 42]
            }]
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            coverage,
            {onTile: acceptedInstall()}
        );

        ref.setCoverage(structuredClone(coverage));

        expect(owner.updateFilterSubscription).not.toHaveBeenCalled();
        expect(ref.generation).toBe(1);
    });

    it("advances generation when exact relation roots change", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: acceptedInstall()}
        );

        ref.setCoverage({
            tileIds: [1],
            roots: [{
                tileId: 1,
                typeId: "Lane",
                featureId: "Lane.1.42"
            }]
        });

        expect(ref.generation).toBe(2);
        expect(owner.updateFilterSubscription).toHaveBeenCalledWith(ref, true);
    });

    it("refreshes unchanged demand and benignly rejects the old generation", () => {
        const onTile = acceptedInstall();
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );
        const oldDelivery = delivery(1, ref.generation);

        ref.refresh();

        expect(ref.generation).toBe(2);
        expect(ref.accept(oldDelivery)).toBe("benign-rejection");
        expect(ref.accept(delivery(1, ref.generation))).toBe("accepted");
        expect(onTile).toHaveBeenCalledOnce();
    });

    it("rejects withdrawn work without invoking installation", () => {
        const onTile = acceptedInstall();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );

        expect(ref.accept(delivery(2, ref.generation))).toBe(
            "benign-rejection"
        );
        expect(onTile).not.toHaveBeenCalled();
    });

    it("does not acknowledge a semantically superseded value", () => {
        const updateFilterSubscription = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription,
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: vi.fn(() => ({status: "superseded"} as const))}
        );

        expect(ref.accept(delivery(1, ref.generation))).toBe(
            "benign-rejection"
        );
        expect(ref.requestJson()).toMatchObject({tileIds: [1]});
        expect(updateFilterSubscription).not.toHaveBeenCalled();
    });

    it("propagates current installation failures and leaves the output pending", () => {
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: () => {
                throw new Error("immutable bytes rejected");
            }}
        );

        expect(() => ref.accept(delivery(1, ref.generation))).toThrow(
            "immutable bytes rejected"
        );
        expect(ref.requestJson()).toMatchObject({tileIds: [1]});
    });

    it("expires only the accepted value incarnation and re-adds ordinary pending work", () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000);
        const updateFilterSubscription = vi.fn();
        const updateFilterTileExpiry = vi.fn();
        const onTilesPending = vi.fn();
        const onTile = acceptedInstall(7);
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription,
                releaseFilterSubscription: vi.fn(),
                updateFilterTileExpiry
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile, onTilesPending}
        );

        expect(ref.accept(delivery(1, ref.generation, {
            conversionTimestampMs: 1_000,
            ttlMs: 100
        }))).toBe("accepted");
        expect(ref.requestJson()).toMatchObject({tileIds: []});
        expect(updateFilterTileExpiry).toHaveBeenCalledWith(
            ref,
            1,
            7,
            1_100
        );

        updateFilterSubscription.mockClear();
        ref.expireTiles([{tileId: 1, valueVersion: 6}]);
        expect(updateFilterSubscription).not.toHaveBeenCalled();

        ref.expireTiles([{tileId: 1, valueVersion: 7}]);
        expect(ref.requestJson()).toMatchObject({tileIds: [1]});
        expect(onTilesPending).toHaveBeenCalledWith([1], ref.generation);
        expect(updateFilterSubscription).toHaveBeenCalledWith(ref, true);
    });

    it("keeps an already-expired accepted value pending and forces reconciliation", () => {
        vi.spyOn(Date, "now").mockReturnValue(2_000);
        const updateFilterSubscription = vi.fn();
        const updateFilterTileExpiry = vi.fn();
        const cancelFilterTileExpiries = vi.fn();
        const onTile = acceptedInstall(3);
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription,
                releaseFilterSubscription: vi.fn(),
                updateFilterTileExpiry,
                cancelFilterTileExpiries
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );

        expect(ref.accept(delivery(1, ref.generation, {
            conversionTimestampMs: 1_000,
            ttlMs: 100
        }))).toBe("accepted");

        expect(onTile).toHaveBeenCalledWith(expect.anything(), true);
        expect(ref.requestJson()).toMatchObject({tileIds: [1]});
        expect(cancelFilterTileExpiries).toHaveBeenCalledWith(ref, [1]);
        expect(updateFilterTileExpiry).not.toHaveBeenCalled();
        expect(updateFilterSubscription).toHaveBeenCalledWith(ref, true);
    });

    it("defers expiry while suspended and restores it as pending on resume", () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000);
        const updateFilterSubscription = vi.fn();
        const onTilesPending = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription,
                releaseFilterSubscription: vi.fn(),
                updateFilterTileExpiry: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: acceptedInstall(4), onTilesPending}
        );
        ref.accept(delivery(1, ref.generation, {
            conversionTimestampMs: 1_000,
            ttlMs: 100
        }));
        ref.suspend();
        updateFilterSubscription.mockClear();

        ref.expireTiles([{tileId: 1, valueVersion: 4}]);
        expect(onTilesPending).not.toHaveBeenCalled();
        expect(updateFilterSubscription).not.toHaveBeenCalled();

        ref.resume();
        expect(ref.requestJson()).toMatchObject({tileIds: [1]});
        expect(onTilesPending).toHaveBeenCalledWith([1], ref.generation);
        expect(updateFilterSubscription).toHaveBeenCalledWith(ref, true);
    });

    it("retains the freshest concurrent refresh value in either arrival order", () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000);

        const runOrder = (deadlines: number[]) => {
            const state = new FilterTileState(
                "Map",
                "Layer",
                1,
                "Features:Map:Layer:1",
                1
            );
            state.install(delivery(1, 1, {
                conversionTimestampMs: 0,
                ttlMs: 800
            }));
            state.markPending(1);
            const ref = new FilterSubscriptionRef(
                {
                    updateFilterSubscription: vi.fn(),
                    releaseFilterSubscription: vi.fn(),
                    updateFilterTileExpiry: vi.fn(),
                    cancelFilterTileExpiries: vi.fn()
                },
                "styled",
                definition(),
                {tileIds: [1]},
                {
                    onTile: (value, remainsPending): FilterTileInstallResult =>
                        state.install(value, remainsPending)
                            ? {
                                status: "accepted",
                                valueVersion: state.valueVersion
                            }
                            : {status: "superseded"}
                }
            );
            const admissions = deadlines.map(deadline => ref.accept(
                delivery(1, 1, {
                    conversionTimestampMs: 0,
                    ttlMs: deadline
                })
            ));
            return {state, ref, admissions};
        };

        const freshFirst = runOrder([1_200, 900]);
        expect(freshFirst.state.expiresAtMs).toBe(1_200);
        expect(freshFirst.admissions).toEqual([
            "accepted",
            "benign-rejection"
        ]);
        expect(freshFirst.ref.requestJson()).toMatchObject({tileIds: []});

        const staleFirst = runOrder([900, 1_200]);
        expect(staleFirst.state.expiresAtMs).toBe(1_200);
        expect(staleFirst.admissions).toEqual(["accepted", "accepted"]);
        expect(staleFirst.ref.requestJson()).toMatchObject({tileIds: []});
    });

    it("notifies its consumer only while active transport state is synchronized", () => {
        const onRequestSynchronized = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {
                onTile: acceptedInstall(),
                onRequestSynchronized
            }
        );

        ref.notifyRequestSynchronized();
        ref.suspend();
        ref.notifyRequestSynchronized();

        expect(onRequestSynchronized).toHaveBeenCalledOnce();
    });
});
