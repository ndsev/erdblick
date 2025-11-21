import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../integrations/cesium', () => {
    class PrimitiveCollection {
        add(primitive: any) {
            return primitive;
        }
        remove(_primitive: any) {
            return true;
        }
    }

    class Rectangle {
        static fromDegrees(..._args: any[]) {
            return {};
        }
    }

    class Color {
        static YELLOW = {withAlpha: (_a: number) => ({})};
        static AQUA = {withAlpha: (_a: number) => ({})};
        withAlpha(_a: number) {
            return {};
        }
    }

    class ColorGeometryInstanceAttribute {
        static fromColor(_c: any) {
            return {lastColor: _c};
        }

        static toValue(color: any, attribute: any) {
            if (attribute) {
                attribute.lastColor = color;
            }
            return attribute ?? {lastColor: color};
        }
    }

    class GeometryInstance {
        constructor(public options: any) {}
    }

    class PerInstanceColorAppearance {
        constructor(public options: any) {}
    }

    class Primitive {
        constructor(public options: any) {}
    }

    class RectangleOutlineGeometry {
        constructor(public options: any) {}
        static createGeometry(_g: any) {
            return {};
        }
    }

    class Viewer {
        scene = {
            primitives: new PrimitiveCollection(),
        };
    }

    return {
        Color,
        PrimitiveCollection,
        Rectangle,
        Viewer,
        ColorGeometryInstanceAttribute,
        GeometryInstance,
        PerInstanceColorAppearance,
        Primitive,
        RectangleOutlineGeometry,
    };
});
import {coreLib} from '../integrations/wasm';
import {TileVisualization} from './visualization.model';

describe('TileVisualization', () => {

    const createViewer = () => {
        const primitives = {
            add: (_primitive: any) => _primitive,
            remove: (_primitive: any) => true,
        };

        return {
            scene: {
                primitives,
            },
        } as any;
    };

    const createTile = (overrides: Partial<any> = {}) => ({
        mapTileKey: 'm1/layerA/1',
        mapName: 'm1',
        layerName: 'layerA',
        tileId: 1n,
        numFeatures: 5,
        preventCulling: false,
        stats: new Map<string, number[]>(),
        peekAsync: (cb: (layer: any) => Promise<any>) => cb({}),
        ...overrides,
    });

    const createPointMergeService = () => ({
        makeMapViewLayerStyleId: vi.fn().mockReturnValue('rule'),
        insert: vi.fn().mockReturnValue([]),
        remove: vi.fn().mockReturnValue([]),
    });

    const createStyle = (overrides: Partial<any> = {}) => ({
        name: () => 'TestStyle',
        isDeleted: () => false,
        ...overrides,
    });

    it('renders a high-detail visualization and records statistics', async () => {
        const tile = createTile();
        const pointMergeService = createPointMergeService();
        const style = createStyle();
        const viewer = createViewer();

        const visu = new TileVisualization(
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

        const result = await visu.render(viewer as any);

        expect(result).toBe(true);
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(visu.isDirty()).toBe(false);

        visu.isHighDetail = false;
        expect(visu.isDirty()).toBe(true);
    });

    it('renders only a low-detail tile border when high-detail is disabled', async () => {
        const pointMergeService = createPointMergeService();
        const style = createStyle();
        const viewer = createViewer();

        const visu = new TileVisualization(
            1,
            createTile({tileId: 2n}) as any,
            pointMergeService as any,
            () => null,
            style as any,
            false,
            (coreLib as any).HighlightMode.NO_HIGHLIGHT,
            undefined,
            true,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');

        const result = await visu.render(viewer as any);

        expect(result).toBe(true);
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(visu.isDirty()).toBe(false);

        visu.showTileBorder = false;
        expect(visu.isDirty()).toBe(true);
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

        const visu = new TileVisualization(
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

        await visu.render(viewer as any);
        expect(addSpy).toHaveBeenCalledTimes(1);

        visu.destroy(viewer as any);

        expect(pointMergeService.remove).toHaveBeenCalledWith(tile.tileId, 'rule');
        expect(removedTiles[0].remove).toHaveBeenCalledWith(viewer);
        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(visu.isDirty()).toBe(true);
    });

    it('aborts rendering when the style has been deleted', async () => {
        const tile = createTile();
        const pointMergeService = createPointMergeService();
        const style = createStyle({isDeleted: () => true});
        const viewer = createViewer();

        const visu = new TileVisualization(
            0,
            tile as any,
            pointMergeService as any,
            () => null,
            style as any,
            true,
        );

        const primitives = (viewer.scene.primitives as any);
        const addSpy = vi.spyOn(primitives, 'add');

        const result = await visu.render(viewer as any);

        expect(result).toBe(false);
        expect(addSpy).not.toHaveBeenCalled();
    });
});
