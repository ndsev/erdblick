import type {FilterChannelDefinition} from
    "../mapdata/filter-subscription.model";
import type {StyleFilterPlan} from
    "../mapdata/styled-mapget-layer.model";
import type {TileFeatureId} from "../shared/appstate.service";
import {
    parseFeatureInspectionTarget,
    type FeatureInspectionTarget
} from "../shared/tile-feature-id";
import {
    partitionKey,
    type PartitionId
} from "../mapdata/partition.model";

/** One visible inspection target with the partition required by exact-root requests. */
export type InteractionHighlightTarget = TileFeatureId & {
    partition: PartitionId;
};

/** Backend portion of one hybrid local/remote interaction presentation. */
export interface RemoteInteractionHighlightPlan {
    plan: StyleFilterPlan;
    partitions: PartitionId[];
    roots: Array<{partition: PartitionId; featureId: string}>;
}

/** Exact targets already represented by regular/search scene geometry. */
export interface RemoteInteractionHighlightOptions {
    localTargetKeys?: ReadonlySet<string>;
}

interface ResolvedInteractionTarget extends InteractionHighlightTarget {
    inspectionTarget: FeatureInspectionTarget;
}

/** Stable exact-target identity shared by local-overlay planning. */
export function interactionTargetKey(feature: TileFeatureId): string {
    return `${feature.mapTileKey}\n${feature.featureId}`;
}

/** Joins a planner expression with an exact-target restriction. */
function restrictExpression(
    expression: string | undefined,
    restriction: string
): string {
    return expression
        ? `(${expression}) and (${restriction})`
        : restriction;
}

/** Builds an entry restriction for one exact attribute target. */
function attributeEntryRestriction(
    target: ResolvedInteractionTarget & {
        inspectionTarget: Extract<FeatureInspectionTarget, {scope: "attribute"}>;
    }
): string {
    const conditions = [
        `$feature.id == ${JSON.stringify(target.inspectionTarget.baseFeatureId)}`,
        `$attributeIndex == ${target.inspectionTarget.attributeIndex}`
    ];
    if (target.inspectionTarget.validityIndex !== undefined) {
        conditions.push(
            "$hasValidity",
            `$validityIndex == ${target.inspectionTarget.validityIndex}`
        );
    }
    return `(${conditions.join(" and ")})`;
}

/** Builds an entry restriction for one explicitly selected relation row. */
function relationEntryRestriction(
    target: ResolvedInteractionTarget & {
        inspectionTarget: Extract<FeatureInspectionTarget, {scope: "relation"}>;
    }
): string {
    return `($source.id == ${JSON.stringify(
        target.inspectionTarget.baseFeatureId
    )} and $relationIndex == ${target.inspectionTarget.relationIndex})`;
}

/** Selects targets whose semantic scope can be consumed by one filter channel. */
function channelTargets(
    channel: FilterChannelDefinition,
    targets: readonly ResolvedInteractionTarget[]
): ResolvedInteractionTarget[] {
    if (channel.scope === "feature") {
        return targets.filter(target =>
            target.inspectionTarget.scope === "feature");
    }
    if (channel.scope === "attribute") {
        return targets.filter(target =>
            target.inspectionTarget.scope === "attribute");
    }
    if (channel.scope === "relation") {
        return targets.filter(target =>
            target.inspectionTarget.scope === "relation");
    }
    return [...targets];
}

/**
 * Reports whether authored geometry exists for the exact target scope.
 *
 * Authored interaction channels only own targets of their exact semantic
 * scope; sibling entity scopes never replace one another.
 */
export function hasAuthoredInteractionHighlight(
    plan: StyleFilterPlan,
    feature: InteractionHighlightTarget
): boolean {
    const scope = parseFeatureInspectionTarget(feature.featureId).scope;
    return plan.channels.some(channel => channel.scope === scope);
}

/** Restricts one cloned channel to the exact compatible semantic targets. */
function restrictChannel(
    channel: FilterChannelDefinition,
    targets: readonly ResolvedInteractionTarget[]
): ResolvedInteractionTarget[] {
    const remoteTargets = channelTargets(channel, targets);
    if (!remoteTargets.length) {
        return [];
    }

    const backendFeatureIds = [...new Set(remoteTargets.map(target =>
        target.inspectionTarget.baseFeatureId))];
    const featureRestriction = backendFeatureIds
        .map(featureId => `id == ${JSON.stringify(featureId)}`)
        .join(" or ");
    channel.featureFilter = restrictExpression(
        channel.featureFilter,
        featureRestriction
    );

    if (channel.scope === "attribute") {
        const entryRestriction = remoteTargets
            .filter((target): target is ResolvedInteractionTarget & {
                inspectionTarget: Extract<FeatureInspectionTarget, {
                    scope: "attribute";
                }>;
            } => target.inspectionTarget.scope === "attribute")
            .map(attributeEntryRestriction)
            .join(" or ");
        channel.entryFilter = restrictExpression(
            channel.entryFilter,
            entryRestriction
        );
    } else if (channel.scope === "relation") {
        const exactRelationTargets = remoteTargets.filter(
            (target): target is ResolvedInteractionTarget & {
                inspectionTarget: Extract<FeatureInspectionTarget, {
                    scope: "relation";
                }>;
            } => target.inspectionTarget.scope === "relation"
        );
        const entryRestriction = exactRelationTargets
            .map(relationEntryRestriction)
            .join(" or ");
        channel.entryFilter = restrictExpression(
            channel.entryFilter,
            entryRestriction
        );
    }
    return remoteTargets;
}

/**
 * Produces the remote half of a hybrid highlight presentation.
 *
 * The returned plan contains only channels compatible with the requested
 * semantic targets. The input style plan is never mutated.
 */
export function planRemoteInteractionHighlight(
    rawPlan: StyleFilterPlan,
    features: readonly InteractionHighlightTarget[],
    options: RemoteInteractionHighlightOptions = {}
): RemoteInteractionHighlightPlan | null {
    const targets: ResolvedInteractionTarget[] = features
        .filter(feature => !options.localTargetKeys?.has(
            interactionTargetKey(feature)))
        .map(feature => ({
            ...feature,
            inspectionTarget: parseFeatureInspectionTarget(feature.featureId)
        }));
    if (!targets.length) {
        return null;
    }
    const plan = structuredClone(rawPlan);
    const admittedTargetKeys = new Set<string>();
    plan.channels = plan.channels.filter(channel => {
        const admittedTargets = restrictChannel(channel, targets);
        admittedTargets.forEach(target =>
            admittedTargetKeys.add(interactionTargetKey(target)));
        return admittedTargets.length > 0;
    });
    if (!plan.channels.length) {
        return null;
    }

    const admittedTargets = targets.filter(target =>
        admittedTargetKeys.has(interactionTargetKey(target)));
    const partitions = [...new Map(admittedTargets.map(target => [
        partitionKey(target.partition),
        target.partition
    ])).values()];
    const needsRoots = plan.channels.some(channel =>
        channel.scope === "relation");
    const roots = new Map<string, {
        partition: PartitionId;
        featureId: string;
    }>();
    if (needsRoots) {
        for (const target of admittedTargets) {
            if (target.inspectionTarget.scope !== "relation") {
                continue;
            }
            const root = {
                partition: target.partition,
                featureId: target.inspectionTarget.baseFeatureId
            };
            roots.set(
                `${partitionKey(root.partition)}\n${root.featureId}`,
                root
            );
        }
    }
    return {
        plan,
        partitions,
        roots: [...roots.values()]
    };
}
