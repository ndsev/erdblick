import {expect, test} from '../fixtures/test';
import {requireTestMapSource} from '../utils/backend-helpers';

/** Collect only point primitives; line/polygon vertices are not group members. */
function pointCoordinates(geometry: any): number[][] {
    if (geometry.type === 'GeometryCollection') {
        return geometry.geometries.flatMap(pointCoordinates);
    }
    if (geometry.type === 'Point') {
        return [geometry.coordinates];
    }
    return geometry.type === 'MultiPoint' ? geometry.coordinates : [];
}

test('synthetic point geometries belong to their requested tile', async ({request}) => {
    await requireTestMapSource(request);

    // Packed level-13 tiles at (42.5, 11.6), (42.5, 11.8), and the
    // inspection camera at (42.5, 11.615). The point owners are ten rows apart.
    const cases = [
        {tileId: 538788094, latitudes: [11.6, 11.6]},
        {tileId: 538788566, latitudes: [11.8]},
        {tileId: 538788436, latitudes: []}
    ];
    const response = await request.post('/tiles', {data: {
        responseType: 'jsonl',
        requests: [{mapId: 'TestMap', layerId: 'WayLayer', tileIds: cases.map(item => item.tileId)}]
    }});
    expect(response.status()).toBe(200);
    const tiles = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
        .filter(row => row.type === 'FeatureCollection');
    expect(tiles).toHaveLength(cases.length);

    for (const {tileId, latitudes} of cases) {
        const tile = tiles.find(row => row.mapgetTileId === tileId);
        expect(tile, `Missing fixture tile ${tileId}`).toBeDefined();
        expect(tile.error).toBeUndefined();
        expect(tile.features.map((feature: any) => feature.id)).toEqual(
            ['Way.0', 'Way.1', 'Way.2', 'Way.3', 'Way.4']);
        for (const feature of tile.features) {
            // Inspection still needs the stable IDs and attributes in its anchor tile.
            expect(feature.properties.isBridge).toBe(false);
            expect(feature.properties.addresses[0].name).toBe('Main St.');
            const points = pointCoordinates(feature.geometry);
            expect(points).toHaveLength(latitudes.length);
            for (let index = 0; index < points.length; ++index) {
                expect(points[index][0]).toBeCloseTo(42.5, 5);
                expect(points[index][1]).toBeCloseTo(latitudes[index], 5);
            }
        }
    }
});
