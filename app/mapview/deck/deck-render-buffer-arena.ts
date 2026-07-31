import type {DeckLayerLike} from "./deck-layer-registry";
import {DeckLayerRegistry} from "./deck-layer-registry";

export interface DeckRenderBufferArenaContribution<T> {
    groupKey: string;
    sourceId: string;
    vertexCount: number;
    contribution: T;
    buildLayer: (
        key: string,
        contributions: ReadonlyMap<string, unknown>
    ) => {layer: DeckLayerLike | null; order: number};
}

interface ArenaPage {
    key: string;
    usedVertices: number;
    contributionVertices: Map<string, number>;
}

interface ArenaGroup {
    nextPageOrdinal: number;
    pages: ArenaPage[];
}

interface ArenaAssignment {
    groupKey: string;
    sourceId: string;
    page: ArenaPage;
}

/** Default bounded rebuild page: four full 16k render blocks. */
export const DEFAULT_RENDER_BUFFER_ARENA_PAGE_VERTICES = 64 * 1024;

/**
 * View-owned allocator for compatible rendered buffer contributions.
 *
 * Blocks remain semantic owners. The arena only assigns each immutable
 * contribution to a bounded, stable Deck layer page and delegates page
 * synthesis to the primitive-specific builder. A removal dirties one page,
 * never the complete view.
 */
export class DeckRenderBufferArena {
    private readonly groups = new Map<string, ArenaGroup>();
    private readonly assignments = new Map<string, ArenaAssignment>();
    private stableCoordinateOrigin: [number, number, number] | null = null;

    constructor(
        private readonly registry: DeckLayerRegistry,
        private readonly pageVertexLimit =
            DEFAULT_RENDER_BUFFER_ARENA_PAGE_VERTICES
    ) {}

    /** Establishes and then retains one worker/render origin for this view. */
    coordinateOrigin(
        fallback: readonly [number, number, number]
    ): [number, number, number] {
        if (!this.stableCoordinateOrigin) {
            this.stableCoordinateOrigin = [
                fallback[0],
                fallback[1],
                fallback[2]
            ];
        }
        return [...this.stableCoordinateOrigin];
    }

    /** Inserts or replaces one block contribution in a compatible page. */
    upsert<T>(request: DeckRenderBufferArenaContribution<T>): string {
        const vertexCount = Math.max(0, Math.ceil(request.vertexCount));
        const assignmentKey = this.assignmentKey(
            request.groupKey,
            request.sourceId
        );
        const existing = this.assignments.get(assignmentKey);
        if (existing) {
            const previous = existing.page.contributionVertices.get(
                request.sourceId
            ) ?? 0;
            const nextUsed =
                existing.page.usedVertices - previous + vertexCount;
            if (nextUsed <= this.pageCapacity(vertexCount)) {
                existing.page.usedVertices = nextUsed;
                existing.page.contributionVertices.set(
                    request.sourceId,
                    vertexCount
                );
                this.registry.upsertShared(
                    existing.page.key,
                    request.sourceId,
                    request.contribution,
                    request.buildLayer
                );
                return existing.page.key;
            }
            this.remove(request.groupKey, request.sourceId);
        }

        const group = this.groups.get(request.groupKey) ?? {
            nextPageOrdinal: 0,
            pages: []
        };
        this.groups.set(request.groupKey, group);
        let page = group.pages.find(candidate =>
            candidate.usedVertices + vertexCount <=
                this.pageCapacity(vertexCount));
        if (!page) {
            page = {
                key: `${request.groupKey}/page-${group.nextPageOrdinal++}`,
                usedVertices: 0,
                contributionVertices: new Map()
            };
            group.pages.push(page);
        }
        page.usedVertices += vertexCount;
        page.contributionVertices.set(request.sourceId, vertexCount);
        this.assignments.set(assignmentKey, {
            groupKey: request.groupKey,
            sourceId: request.sourceId,
            page
        });
        this.registry.upsertShared(
            page.key,
            request.sourceId,
            request.contribution,
            request.buildLayer
        );
        return page.key;
    }

    /** Removes one block contribution without disturbing neighboring pages. */
    remove(groupKey: string, sourceId: string): boolean {
        const key = this.assignmentKey(groupKey, sourceId);
        const assignment = this.assignments.get(key);
        if (!assignment) {
            return false;
        }
        this.assignments.delete(key);
        const vertices =
            assignment.page.contributionVertices.get(sourceId) ?? 0;
        assignment.page.contributionVertices.delete(sourceId);
        assignment.page.usedVertices = Math.max(
            0,
            assignment.page.usedVertices - vertices
        );
        return this.registry.removeShared(
            assignment.page.key,
            sourceId
        );
    }

    /** Removes every arena contribution owned by one visualization. */
    removeSource(sourcePrefix: string): number {
        const matches = [...this.assignments.values()].filter(assignment =>
            assignment.sourceId.startsWith(sourcePrefix));
        let removed = 0;
        for (const assignment of matches) {
            removed += this.remove(
                assignment.groupKey,
                assignment.sourceId
            ) ? 1 : 0;
        }
        return removed;
    }

    /** Drops allocator metadata; the registry remains the layer owner. */
    clear(): void {
        for (const assignment of [...this.assignments.values()]) {
            this.registry.removeShared(
                assignment.page.key,
                assignment.sourceId
            );
        }
        this.assignments.clear();
        this.groups.clear();
        this.stableCoordinateOrigin = null;
    }

    private pageCapacity(contributionVertices: number): number {
        return Math.max(
            1,
            this.pageVertexLimit,
            contributionVertices
        );
    }

    private assignmentKey(groupKey: string, sourceId: string): string {
        return `${groupKey}\n${sourceId}`;
    }
}
