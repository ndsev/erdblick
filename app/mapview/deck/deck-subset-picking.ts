import type {TileFeatureId} from "../../shared/appstate.service";
import type {PresentationKind} from
    "../../mapdata/styled-mapget-layer.model";
import {SceneMode} from "../../integrations/geo";
import type {
    DeckGltfPickProxyStyleContribution
} from "./deck-gltf-node.layer";

export type SubsetPickResolver = (pickIndex: number) => TileFeatureId[];

/** Picking metadata shared by binary Deck layers built from subset results. */
export interface DeckSubsetPickProps {
    tileKey: string;
    subsetPickResolver: SubsetPickResolver;
    featureAddresses?: Uint32Array;
    featureAddressesByPath?: Uint32Array;
    navigationAnchorEligible?: boolean;
    markerAnchorEligible?: boolean;
    drillPickEligible?: boolean;
    coordinateOrigin?: [number, number, number];
    anchorPositions?: ArrayLike<number>;
    surfaceNormals?: ArrayLike<number>;
    pathCenterline?: {
        positions: ArrayLike<number>;
        startIndices: ArrayLike<number>;
        coordinateOrigin: [number, number, number];
    };
}

export interface DeckSubsetInteractionProps {
    pickable: boolean | "3d";
    drillPickEligible: boolean;
}

/** Names one owner-specific invisible GLTF proxy so presentation kinds never mix. */
export function deckSubsetGltfPickProxyKey(
    mapTileKey: string,
    ownerId: string
): string {
    return `${mapTileKey}/gltf-pick-proxy/${encodeURIComponent(ownerId)}`;
}

/** Selects Deck interaction behavior without making highlight passes pickable. */
export function deckSubsetInteractionProps(
    presentationKind: PresentationKind,
    highlightModeValue: number,
    noHighlightModeValue: number,
    sceneMode: SceneMode | undefined
): DeckSubsetInteractionProps {
    const ordinaryPresentation =
        highlightModeValue === noHighlightModeValue;
    return {
        pickable: ordinaryPresentation
            ? sceneMode === SceneMode.SCENE3D
                ? "3d"
                : true
            : false,
        drillPickEligible:
            ordinaryPresentation && presentationKind === "regular"
    };
}

interface GltfPickContribution {
    sourceId: string;
    data: DeckGltfPickProxyStyleContribution["data"];
    pickResolver: SubsetPickResolver;
}

/**
 * Rebinds contributor-local subset addresses into one pick-proxy address table.
 * This keeps shared proxy data paired with the exact immutable subset that owns it.
 */
export function remapGltfPickContributions(
    source: readonly GltfPickContribution[]
): {
    contributions: DeckGltfPickProxyStyleContribution[];
    pickResolver: SubsetPickResolver;
} {
    const entries: Array<{
        resolver: SubsetPickResolver;
        address: number;
    }> = [];
    const contributions = source.map(item => {
        const remapped = new Map<number, number>();
        return {
            sourceId: item.sourceId,
            data: item.data.map(datum => {
                let address = remapped.get(datum.featureAddress);
                if (address === undefined) {
                    address = entries.length;
                    remapped.set(datum.featureAddress, address);
                    entries.push({
                        resolver: item.pickResolver,
                        address: datum.featureAddress
                    });
                }
                return {...datum, featureAddress: address};
            })
        };
    });
    return {
        contributions,
        pickResolver: address => {
            const entry = entries[address];
            return entry ? entry.resolver(entry.address) : [];
        }
    };
}
