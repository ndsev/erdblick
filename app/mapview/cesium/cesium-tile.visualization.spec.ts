import {beforeAll, describe, expect, it, vi} from 'vitest';
import {coreLib, initializeLibrary, uint8ArrayFromWasm} from '../../integrations/wasm';
import {FeatureTile} from '../../mapdata/features.model';
import {CesiumTileVisualization} from './cesium-tile.visualization.model';

beforeAll(async () => {
    // Minimal polyfills for the jsdom test environment so Cesium's texture and image handling paths
    // used by the WASM renderer can execute without throwing ReferenceError.
    if (typeof (globalThis as any).ImageBitmap === 'undefined') {
        (globalThis as any).ImageBitmap = class ImageBitmapStub {
            close() {
                // no-op
            }
        };
    }

    if (typeof (globalThis as any).createImageBitmap === 'undefined') {
        (globalThis as any).createImageBitmap = async (image: any) => image as any;
    }

    if (typeof (globalThis as any).OffscreenCanvas === 'undefined') {
        (globalThis as any).OffscreenCanvas = class OffscreenCanvasStub {};
    }

    // Patch Cesium ContextLimits for the jsdom/Vitest environment.
    // Necessary to test the high detail rendering.
    try {
        const engine = (await import('@cesium/engine')) as any;
        const limits = engine.ContextLimits;

        if (limits &&
            limits._minimumAliasedLineWidth === 0 &&
            limits._maximumAliasedLineWidth === 0) {
            limits._minimumAliasedLineWidth = 1;
            limits._maximumAliasedLineWidth = 1;
        }
    } catch (e) {
       console.error(e);
    }

    await initializeLibrary();
});

describe('CesiumTileVisualization', () => {

    const createViewer = () => {
        const primitives = {
            add: (_primitive: any) => {
                if (_primitive && typeof _primitive.getGeometryInstanceAttributes === 'function') {
                    const original = _primitive.getGeometryInstanceAttributes.bind(_primitive);
                    _primitive.getGeometryInstanceAttributes = (id: any) => {
                        try {
                            return original(id);
                        } catch (_err) {
                            return {color: null};
                        }
                    };
                }
                return _primitive;
            },
            remove: (_primitive: any) => true,
        };

        return {
            scene: {
                primitives,
                requestRender: vi.fn(),
            },
        } as any;
    };

    const createTile = (overrides: Partial<FeatureTile> = {}) => {
        const parser = new coreLib.TileLayerParser();
        const blob = uint8ArrayFromWasm((buffer: any) => coreLib.generateTestTile(buffer, parser));
        if (!blob) {
            throw new Error('Failed to generate test tile blob');
        }
        const tile = new FeatureTile(parser, blob, false);
        Object.assign(tile, overrides);
        return tile;
    };

    const createPointMergeService = () => ({
        makeMapViewLayerStyleId: vi.fn().mockReturnValue('rule'),
        insert: vi.fn().mockReturnValue([]),
        remove: vi.fn().mockReturnValue([]),
    });

    const createStyle = (overrides: Partial<{isDeleted: () => boolean}> = {}) => {
        const style = coreLib.generateTestStyle();
        (style as any).isDeleted = overrides.isDeleted ?? (() => false);
        return style as any;
    };

    it('renders a high-detail visualization and records statistics', async () => {
        const tile = createTile();
        const pointMergeService = createPointMergeService();
        const style = createStyle();
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            true,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            undefined,
            false,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');

        const result = await visu.render(sceneHandle as any);

        expect(result).toBe(true);
        expect(addSpy).toHaveBeenCalledTimes(2);
        expect(visu.isDirty()).toBe(false);

        visu.isHighDetail = false;
        expect(visu.isDirty()).toBe(true);

        visu.destroy(sceneHandle as any);
    });

    it('renders only a low-detail tile border when high-detail is disabled', async () => {
        const pointMergeService = createPointMergeService();
        const style = createStyle();
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            1,
            createTile({tileId: 2n}) as any,
            pointMergeService as any,
            () => null,
            style as any,
            false,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            undefined,
            true,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');

        const result = await visu.render(sceneHandle as any);

        expect(result).toBe(true);
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(visu.isDirty()).toBe(false);

        visu.showTileBorder = false;
        expect(visu.isDirty()).toBe(true);

        visu.destroy(sceneHandle as any);
    });

    it('marks visualization dirty when style options change', async () => {
        const tile = createTile();
        const pointMergeService = createPointMergeService();
        const style = createStyle();
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            true,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            undefined,
            false,
            {roadColor: '#f00'},
        );

        await visu.render(sceneHandle as any);
        expect(visu.isDirty()).toBe(false);

        visu.setStyleOption('roadColor', '#0f0');
        expect(visu.isDirty()).toBe(true);

        await visu.render(sceneHandle as any);
        expect(visu.isDirty()).toBe(false);

        visu.setStyleOption('roadColor', '#0f0');
        expect(visu.isDirty()).toBe(false);

        visu.destroy(sceneHandle as any);
    });

    it('destroys visualizations and removes point-merge contributions', async () => {
        const tile = createTile();
        const removedTiles = [{remove: vi.fn()}];
        const pointMergeService = {
            makeMapViewLayerStyleId: vi.fn().mockReturnValue('rule'),
            insert: vi.fn().mockReturnValue([]),
            remove: vi.fn().mockReturnValue(removedTiles),
        };
        const style = createStyle();
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            true,
            (coreLib as any).HighlightMode.NO_HIGHLIGHT,
            undefined,
            false,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');
        const removeSpy = vi.spyOn(primitives, 'remove');

        await visu.render(sceneHandle as any);
        expect(addSpy).toHaveBeenCalledTimes(2);

        visu.destroy(sceneHandle as any);

        expect(pointMergeService.remove).toHaveBeenCalledWith(tile.tileId, 'rule');
        expect(removedTiles[0].remove).toHaveBeenCalledWith(viewer);
        expect(removeSpy).toHaveBeenCalledTimes(2);
        expect(visu.isDirty()).toBe(true);
    });

    it('aborts rendering when the style has been deleted', async () => {
        const tile = createTile();
        const pointMergeService = createPointMergeService();
        const style = createStyle({isDeleted: () => true});
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            true,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');

        const result = await visu.render(sceneHandle as any);

        expect(result).toBe(false);
        expect(addSpy).not.toHaveBeenCalled();
    });

    it('ignores tile data version bumps above the style minimum stage', async () => {
        const tile = createTile({tileId: 3n});
        let relevantVersion = 1;
        (tile as any).dataVersion = 10;
        (tile as any).dataVersionUpToStage = () => relevantVersion;

        const pointMergeService = createPointMergeService();
        const style = createStyle();
        (style as any).minimumStage = () => 0;
        const viewer = createViewer();
        const sceneHandle = {renderer: 'cesium' as const, scene: viewer};

        const visu = new CesiumTileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            false,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            undefined,
            true,
        );

        await visu.render(sceneHandle as any);
        expect(visu.isDirty()).toBe(false);

        // Simulate arrival of higher-stage data that does not affect the style's minimum stage.
        (tile as any).dataVersion += 1;
        expect(visu.isDirty()).toBe(false);

        // A relevant-stage update still marks the visualization dirty.
        relevantVersion += 1;
        expect(visu.isDirty()).toBe(true);
    });
});
