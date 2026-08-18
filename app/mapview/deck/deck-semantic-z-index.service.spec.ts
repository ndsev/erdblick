import {describe, expect, it, vi} from "vitest";

import {
    DeckSemanticZIndexService,
    isSemanticZIndexPassLayer,
    isSemanticZIndexPickingLayer
} from "./deck-semantic-z-index.service";
import {ErdblickVectorRenderMode} from "./erdblick-vector.layer";

describe("DeckSemanticZIndexService", () => {
    it("registers a pick-only compositor backed by the semantic overlay source", () => {
        const registry = {
            upsert: vi.fn(),
            remove: vi.fn()
        };
        const service = new DeckSemanticZIndexService(registry as never);
        const sharedDisabledPickIndices = new Set<number>();
        const scene = {
            navigationAltitude: vi.fn(() => 123)
        };

        service.bindScene(
            scene as never,
            false,
            sharedDisabledPickIndices
        );

        const registrations = registry.upsert.mock.calls as Array<
            [string, any, number]
        >;
        const overlayLayer = registrations.find(([, layer]) =>
            layer.props.renderMode === ErdblickVectorRenderMode.SemanticOverlay
        )?.[1];
        const pickingRegistration = registrations.find(([id]) =>
            isSemanticZIndexPickingLayer(id)
        );
        const pickingLayer = pickingRegistration?.[1];

        expect(service.useInPicking).toBe(true);
        expect(overlayLayer).toBeDefined();
        expect(pickingLayer).toBeDefined();
        expect(pickingLayer.props).toMatchObject({
            pickable: true,
            drillPickEligible: true,
            navigationAnchorEligible: true,
            markerAnchorEligible: true
        });
        expect(pickingLayer.props.navigationAltitudeResolver(7)).toBe(123);
        expect(scene.navigationAltitude).toHaveBeenCalledWith(7);

        const info = pickingLayer.getPickingInfo({
            info: {index: 19},
            mode: "query"
        });
        expect(info.object).toEqual({globalPickIndex: 19});
        expect(info.sourceLayer).toBe(overlayLayer);

        pickingLayer.disablePickingIndex(19);
        expect(sharedDisabledPickIndices).toEqual(new Set([19]));
        pickingLayer.restorePickingColors();
        expect(sharedDisabledPickIndices.size).toBe(0);
    });

    it("keeps hidden pass layers distinct from the public picking compositor", () => {
        expect(isSemanticZIndexPassLayer(
            "builtin/semantic-z-index-pass/support"
        )).toBe(true);
        expect(isSemanticZIndexPassLayer(
            "builtin/semantic-z-index-picking"
        )).toBe(false);
        expect(isSemanticZIndexPickingLayer(
            "builtin/semantic-z-index-picking"
        )).toBe(true);
        expect(isSemanticZIndexPickingLayer(
            "builtin/semantic-z-index-composite"
        )).toBe(false);
    });

    it("writes feature identities only when the effect feeds a Deck picking pass", () => {
        const service = new DeckSemanticZIndexService({} as never);
        const render = vi.fn();
        const supportGroup = {};
        const supportDepth = {};
        const overlayColor = {};
        const setSemanticSupportTexture = vi.fn();
        const internal = service as any;
        internal.context = {
            device: {
                canvasContext: {
                    getDrawingBufferSize: () => [16, 8]
                }
            }
        };
        internal.pass = {render};
        internal.supportFramebuffer = {
            width: 16,
            height: 8,
            colorAttachments: [{texture: supportGroup}],
            depthStencilAttachment: {texture: supportDepth}
        };
        internal.overlayFramebuffer = {
            width: 16,
            height: 8,
            colorAttachments: [{texture: overlayColor}],
            depthStencilAttachment: {texture: {}}
        };
        internal.supportLayer = {};
        internal.overlayLayer = {setSemanticSupportTexture};

        service.preRender({
            isPicking: true,
            viewports: [],
            layers: [],
            pass: "picking:query"
        } as never);

        expect(setSemanticSupportTexture).toHaveBeenCalledWith(supportGroup);
        expect(render).toHaveBeenCalledTimes(2);
        expect(render.mock.calls[0][0]).toMatchObject({
            pass: "semantic-z-index-support",
            shaderModuleProps: {
                picking: {isActive: false, isAttribute: false}
            }
        });
        expect(render.mock.calls[1][0]).toMatchObject({
            pass: "semantic-z-index-picking",
            shaderModuleProps: {
                picking: {isActive: true, isAttribute: false}
            }
        });

        render.mockClear();
        service.preRender({
            isPicking: false,
            viewports: [],
            layers: [],
            pass: "screen"
        } as never);
        expect(render.mock.calls[1][0]).toMatchObject({
            pass: "semantic-z-index-overlay",
            shaderModuleProps: {
                picking: {isActive: false, isAttribute: false}
            }
        });
    });
});
