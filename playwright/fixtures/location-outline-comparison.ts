import {COORDINATE_SYSTEM, Deck, MapView, type MapViewState} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {LocationOutlineLayer} from '../../app/mapview/deck/location-area.layer';
import {fitLocationArea, locationOverlayPolygons} from '../../app/mapview/deck/deck-location-area-navigation';
import type {LocationPolygon} from '../../app/mapview/render-view';

export {fitLocationArea, locationOverlayPolygons};

const WIDTH = 620, HEIGHT = 500;
const decks: Deck[] = [];

/** Pixel comparisons use complete rings, including holes, a tiny island, short edges and a repeated point. */
function testPolygons(view: MapViewState): LocationPolygon[] {
    const origin = lngLatToWorld([view.longitude, view.latitude]);
    const ring = (points: number[][]): [number, number][] => points.map(([x, y]) =>
        worldToLngLat([origin[0] + x / 2 ** view.zoom, origin[1] + y / 2 ** view.zoom]) as [number, number]);
    return [[ring([[-200, -140], [120, -140], [120, -140], [120, 30], [20, 30], [20, 140],
        [-200, 140], [-200, -140]]), ring([[-150, -90], [-150, 90], [-60, 90], [-60, -90], [-150, -90]])],
        [ring([[165, -100], [166, -100], [166, -99], [165, -99], [165, -100]])],
        [ring([[150, 110], [180, -30], [165, 110], [166, 110.00001], [180, 135], [150, 110]])]];
}

/** Renders production outlines side by side, comparing actual WebGL coverage rather than screenshots of mocks. */
export async function render(view: MapViewState, opacity = 1, dateline = false,
    options: {polygons?: LocationPolygon[]; measure?: boolean; width?: number; height?: number} = {}) {
    decks.splice(0).forEach(deck => deck.finalize());
    const width = options.width ?? WIDTH, height = options.height ?? HEIGHT;
    const data = options.polygons ?? (dateline ? locationOverlayPolygons({label: 'Dateline',
        rectangle: {west: 170, south: -10, east: 190, north: 10},
        polygons: [[[[170, -10], [190, -10], [190, 10], [170, 10], [170, -10]],
            [[178, -4], [182, -4], [182, 4], [178, 4], [178, -4]]]]}) : testPolygons(view));
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:black;color:white;font:16px sans-serif;display:flex;gap:12px';
    const results = [];
    for (const custom of [false, true]) {
        const panel = document.createElement('section');
        const label = document.createElement('h3');
        label.textContent = custom ? 'Luma full-detail outline' : 'Deck PathLayer reference';
        const holder = document.createElement('div');
        holder.style.cssText = `position:relative;width:${width}px;height:${height}px`;
        const canvas = document.createElement('canvas');
        holder.append(canvas);
        panel.append(label, holder);
        document.body.append(panel);
        const common = {id: 'boundary', opacity, pickable: false, parameters: {depthCompare: 'always' as const, depthWriteEnabled: false}};
        const layer = custom ? new LocationOutlineLayer({...common, data, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN}) :
            new PathLayer({...common, data: data.flat(), getPath: path => path.flat(), positionFormat: 'XY',
                getColor: [0, 255, 255, 255], getWidth: 3, widthUnits: 'pixels', _pathType: 'loop',
                jointRounded: false, capRounded: false, antialiasing: false, wrapLongitude: false});
        const result = await new Promise<{coverage: number; pixels: Uint8Array; uploadsDuringFade: number;
            gpuMedianMs?: number; gpuP95Ms?: number; gpuFrameMedianMs?: number; gpuFrameP95Ms?: number;
            gpuSamples: number; gpuFrames: number; gpuDisjoint: boolean; renderer: string}>((resolve, reject) => {
            let frames = 0, uploadsDuringFade = 0;
            let finished = false;
            const queries: {query: WebGLQuery; frame: number}[] = [];
            const deck = new Deck({
                canvas, width, height, useDevicePixels: false,
                views: new MapView({repeat: true}), controller: false, _animate: true,
                initialViewState: view, layers: [layer],
                deviceProps: {type: 'webgl', webgl: {antialias: true, preserveDrawingBuffer: true}},
                onError: reject,
                onAfterRender: ({gl}) => {
                    if (finished) return;
                    if (++frames === 3) {
                        const timer = options.measure && gl.getExtension('EXT_disjoint_timer_query_webgl2');
                        if (timer) {
                            const draw = gl.drawElementsInstanced.bind(gl);
                            gl.drawElementsInstanced = (...args: Parameters<typeof gl.drawElementsInstanced>) => {
                                const query = gl.createQuery()!;
                                gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
                                draw(...args);
                                gl.endQuery(timer.TIME_ELAPSED_EXT);
                                queries.push({query, frame: frames});
                            };
                        }
                        const original = gl.bufferSubData.bind(gl);
                        gl.bufferSubData = (...args: Parameters<typeof gl.bufferSubData>) => {
                            if (args[2].byteLength > 1024) uploadsDuringFade++;
                            original(...args);
                        };
                        const allocate = gl.bufferData.bind(gl);
                        gl.bufferData = (...args: Parameters<typeof gl.bufferData>) => {
                            const size = args[1];
                            if ((typeof size === 'number' ? size : size?.byteLength ?? 0) > 1024) uploadsDuringFade++;
                            allocate(...args);
                        };
                        // Exercise the exact clone path used by the highlight's fade callback.
                        deck.setProps({layers: [layer.clone({opacity: opacity / 2})],
                            viewState: {...view, zoom: view.zoom + 1, longitude: view.longitude + 0.1}});
                    }
                    if (frames === 4) deck.setProps({layers: [layer.clone({opacity})], viewState: view});
                    if (frames < (options.measure ? 120 : 6)) return;
                    finished = true;
                    const pixels = new Uint8Array(width * height * 4);
                    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    let coverage = 0;
                    for (let i = 1; i < pixels.length; i += 4) coverage += pixels[i];
                    deck.setProps({_animate: false});
                    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
                    const gpuDisjoint = timer ? Boolean(gl.getParameter(timer.GPU_DISJOINT_EXT)) : false;
                    const ready = gpuDisjoint ? [] : queries.filter(({query}) => gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
                        .map(({query, frame}) => ({frame, time: Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6}));
                    const times = ready.map(item => item.time).sort((a, b) => a - b);
                    const frameTimes = new Map<number, number>();
                    for (const {frame, time} of ready) {
                        // Exclude the camera/opacity exercise and any incomplete trailing frame.
                        if (frame < 8 || frame >= ready[ready.length - 1].frame) continue;
                        frameTimes.set(frame, (frameTimes.get(frame) ?? 0) + time);
                    }
                    const totals = [...frameTimes.values()].sort((a, b) => a - b);
                    queries.forEach(({query}) => gl.deleteQuery(query));
                    const debug = gl.getExtension('WEBGL_debug_renderer_info');
                    resolve({coverage, pixels, uploadsDuringFade, gpuSamples: times.length, gpuFrames: totals.length, gpuDisjoint,
                        gpuMedianMs: times[Math.floor(times.length / 2)], gpuP95Ms: times[Math.floor(times.length * 0.95)],
                        gpuFrameMedianMs: totals[Math.floor(totals.length / 2)], gpuFrameP95Ms: totals[Math.floor(totals.length * 0.95)],
                        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)});
                }
            });
            decks.push(deck);
        });
        results.push(result);
    }
    let difference = 0;
    for (let i = 1; i < results[0].pixels.length; i += 4) difference += Math.abs(results[0].pixels[i] - results[1].pixels[i]);
    let unmatchedPixels = 0;
    // A one-pixel neighborhood distinguishes subpixel projection differences from missing geometry.
    for (const [source, target] of [[results[0].pixels, results[1].pixels], [results[1].pixels, results[0].pixels]]) {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            if (!source[(y * width + x) * 4 + 1]) continue;
            let matched = false;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height &&
                    target[((y + dy) * width + x + dx) * 4 + 1]) matched = true;
            }
            if (!matched) unmatchedPixels++;
        }
    }
    return {renderers: results.map(({pixels, ...statistics}) => statistics),
        relativePixelDifference: difference / results[0].coverage, unmatchedPixels};
}
