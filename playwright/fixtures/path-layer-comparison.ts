import {COORDINATE_SYSTEM, Deck} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {lngLatToWorld, unitsPerMeter, worldToLngLat} from '@math.gl/web-mercator';
import type {Device} from '@luma.gl/core';
import {ErdblickVectorLayer} from '../../app/mapview/deck/erdblick-vector.layer';
import {GpuScene} from '../../app/mapview/deck/gpu-scene';
import {DeckContactShadingService} from '../../app/mapview/deck/deck-contact-shading.service';
import {DeckLayerRegistry} from '../../app/mapview/deck/deck-layer-registry';
import {
    DeckSemanticZIndexService, isSemanticZIndexPassLayer, isSemanticZIndexPickingLayer
} from '../../app/mapview/deck/deck-semantic-z-index.service';
import {ErdblickMapView} from '../../app/mapview/deck/navigation/web-mercator-feature-navigation';
import {
    GPU_RENDER_PACKET_ABI_VERSION,
    GPU_RENDER_PACKET_HEADER_BYTES,
    GpuMaterialFlag,
    GpuPrimitiveKind
} from '../../app/mapview/deck/gpu-render-packet';

const ORIGIN: [number, number, number] = [11.94668514, 57.64600107, 0];
const WIDTH = 620;
const HEIGHT = 500;

/** Identical input geometry and styling for the two independent renderers. */
interface TestPath {
    points: number[][];
    width: number;
    color: [number, number, number, number];
    layout: 'simple' | 'compact' | 'full';
}

/** Upload real packet records through GpuScene, without replacing its layer or shader plumbing. */
function installPath(scene: GpuScene, path: TestPath, index: number, billboard: boolean, semanticRole = 0): void {
    const simple = path.layout === 'simple';
    const compact = path.layout === 'compact';
    const stride = simple ? 52 : compact ? 76 : 148;
    const flags = GpuMaterialFlag.DepthTest | semanticRole | (billboard ? GpuMaterialFlag.Billboard : 0) |
        (simple ? GpuMaterialFlag.SimplePath : compact ? GpuMaterialFlag.CompactPath : 0);
    const reservation = scene.prepareRender('comparison', ORIGIN, [{
        identity: `path-${index}`, mapTileKey: 'Features:Comparison:Paths:1', styleOrder: 0, lod: 7
    }]);
    const contribution = reservation.contributions[0];
    const stream = GPU_RENDER_PACKET_HEADER_BYTES;
    const descriptor = stream + 48;
    const span = descriptor + 56;
    const zIndex = span + 16;
    const records = zIndex + 16;
    const count = path.points.length - 1;
    const bytes = new Uint8Array(records + count * stride);
    const view = new DataView(bytes.buffer);
    const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
    const f32 = (offset: number, value: number) => view.setFloat32(offset, value, true);
    u32(0, 0x50475245);
    view.setUint16(4, GPU_RENDER_PACKET_ABI_VERSION, true);
    view.setUint16(6, GPU_RENDER_PACKET_HEADER_BYTES, true);
    u32(8, bytes.length);
    u32(12, 1);
    u32(16, reservation.sceneGeneration);
    u32(20, reservation.packetSequence);
    u32(32, reservation.origin.slot);
    u32(36, 1);
    view.setBigUint64(40, reservation.origin.key, true);
    ORIGIN.forEach((value, axis) => view.setFloat64(48 + axis * 8, value, true));
    for (const [header, offset, length] of [
        [72, stream, 1], [80, descriptor, 1], [88, span, 1],
        [96, zIndex, 0], [104, zIndex, 0], [112, zIndex, 0],
        [120, zIndex, 0], [128, zIndex, 0], [144, zIndex, 0], [152, zIndex, 1]
    ]) {
        u32(header, offset);
        u32(header + 4, length);
    }
    view.setUint16(stream, GpuPrimitiveKind.PathSegment, true);
    view.setUint16(stream + 2, flags, true);
    view.setBigUint64(stream + 4, BigInt(flags + 1), true);
    u32(stream + 12, stride);
    u32(stream + 16, count);
    u32(stream + 20, records);
    u32(stream + 24, count * stride);
    view.setBigUint64(descriptor, contribution.key, true);
    u32(descriptor + 8, contribution.revision);
    u32(descriptor + 12, contribution.slot);
    u32(descriptor + 16, contribution.activationToken);
    u32(descriptor + 24, 1);
    u32(descriptor + 48, 1);
    u32(span + 8, count);
    view.setFloat64(zIndex, semanticRole ? 1 : Number.NaN, true);
    u32(zIndex + 12, semanticRole ? 7 : 0);
    for (let segment = 0; segment < count; ++segment) {
        const start = records + segment * stride;
        const points = simple ? path.points : [
            path.points[Math.max(0, segment - 1)], path.points[segment],
            path.points[segment + 1], path.points[Math.min(count, segment + 2)]
        ];
        points.flat().forEach((value, word) => f32(start + word * 4, value));
        f32(start + (simple ? 24 : compact ? 48 : 96), path.width);
        const color = start + (simple ? 32 : compact ? 56 : 128);
        bytes.set(path.color, color);
        u32(color + 4, reservation.origin.slot);
        u32(color + 8, contribution.slot);
        u32(color + 12, 0xffffffff);
        u32(color + 16, 1 | (segment === 0 ? 2 : 0) |
            (segment === count - 1 ? 4 : 0) | (contribution.activationToken << 8));
    }
    scene.applyPacket(bytes, reservation);
    scene.finishRender(reservation);
}

/** Render full production layers side by side and leave the result available for screenshots. */
export async function render(pitch: number, billboard: boolean, pipeline: 'direct' | 'contact' | 'semantic') {
    const paths: TestPath[] = [];
    for (const [index, layout] of (['simple', 'compact', 'full'] as const).entries()) {
        for (const [row, width] of [1, 2, 4].entries()) {
            const y = 95 - index * 70 - row * 20;
            const points = layout === 'simple'
                ? [[-130, y, 0], [130, y + 12, 0]]
                : Array.from({length: 41}, (_, i) => [
                    -130 + i * 6.5, y + i * 0.3 + Math.sin(i * 0.2) * 2, 0
                ]);
            if (layout === 'full' && row === 1) {
                points.splice(0, points.length,
                    [-130, y, 0], [-60, y + 4, 0], [-30, y + 18, 0], [20, y + 2, 0], [130, y + 12, 0]);
            }
            paths.push({points, width, color: [70, 230, 230, 255], layout});
        }
    }
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:black;color:white;font:16px sans-serif';
    const title = document.createElement('p');
    title.textContent = `Pitch ${pitch}°, ${billboard ? 'billboard' : 'ground'} lines · pipeline ${pipeline} · groups: simple / compact / full · widths: 1 / 2 / 4 px`;
    document.body.append(title);
    const board = document.createElement('div');
    board.style.cssText = 'display:flex;gap:12px';
    document.body.append(board);
    const results = [];
    const originWorld = lngLatToWorld(ORIGIN);
    const scale = unitsPerMeter(ORIGIN[1]);
    for (const custom of [true, false]) {
        const panel = document.createElement('section');
        const label = document.createElement('h3');
        label.textContent = custom ? 'ErdblickVectorLayer' : 'Deck PathLayer (analytic AA off)';
        panel.append(label);
        const holder = document.createElement('div');
        holder.style.cssText = `position:relative;width:${WIDTH}px;height:${HEIGHT}px`;
        const canvas = document.createElement('canvas');
        holder.append(canvas);
        panel.append(holder);
        board.append(panel);
        const result = await new Promise<{
            coverage: number; partialPixels: number; samples: number; pixels: Uint8Array
        }>((resolve, reject) => {
            let frames = 0;
            let installed = false;
            let device: Device;
            let shading: DeckContactShadingService | undefined;
            const registry = new DeckLayerRegistry();
            const semantic = custom && pipeline === 'semantic' ? new DeckSemanticZIndexService(registry) : undefined;
            const deck = new Deck({
                canvas, width: WIDTH, height: HEIGHT, useDevicePixels: false,
                views: new ErdblickMapView(), controller: false, _animate: true,
                initialViewState: {longitude: ORIGIN[0], latitude: ORIGIN[1], zoom: 16.5, pitch, bearing: 0},
                deviceProps: {type: 'webgl', webgl: {antialias: true, preserveDrawingBuffer: true}},
                effects: semantic ? [semantic] : [],
                layerFilter: ({layer}) => !isSemanticZIndexPassLayer(layer.id) && !isSemanticZIndexPickingLayer(layer.id),
                onDeviceInitialized: initializedDevice => { device = initializedDevice; },
                onError: reject,
                onBeforeRender: () => {
                    if (shading) deck.props._framebuffer = shading.prepare();
                },
                onLoad: () => {
                    if (custom) {
                        if (pipeline === 'contact') {
                            shading = new DeckContactShadingService(device, canvas.getContext('webgl2')!);
                        }
                        const scene = new GpuScene(device, () => {}, reject);
                        paths.forEach((path, index) => installPath(scene, path, index, billboard,
                            semantic ? GpuMaterialFlag.SemanticOverlay : 0));
                        if (semantic) {
                            installPath(scene, {
                                points: [[-300, 0, 0], [300, 0, 0]], width: 1600,
                                color: [0, 0, 0, 255], layout: 'simple'
                            }, 99, false, GpuMaterialFlag.SemanticSupport);
                        }
                        scene.publishPresentation();
                        const layer = new ErdblickVectorLayer({
                            id: 'custom', scene, flattenZ: false,
                            coordinateSystem: COORDINATE_SYSTEM.LNGLAT
                        });
                        if (semantic) {
                            registry.setDeck(deck);
                            registry.upsert(layer.id, layer, 0);
                            semantic.bindScene(scene, false);
                        } else {
                            deck.setProps({layers: [layer]});
                        }
                    } else {
                        deck.setProps({layers: [new PathLayer<TestPath>({
                            id: 'stock', data: paths,
                            getPath: path => path.points.map(point => {
                                const [lon, lat] = worldToLngLat([
                                    originWorld[0] + point[0] * scale, originWorld[1] + point[1] * scale
                                ]);
                                return [lon, lat, point[2]] as [number, number, number];
                            }),
                            getWidth: path => path.width, getColor: path => path.color,
                            widthUnits: 'pixels', billboard, capRounded: true, jointRounded: true,
                            antialiasing: false,
                            coordinateSystem: COORDINATE_SYSTEM.LNGLAT
                        })]});
                    }
                    installed = true;
                },
                onAfterRender: ({gl}) => {
                    shading?.render(deck.getViewports()[0]);
                    if (!installed || ++frames < 8) return;
                    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
                    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    let coverage = 0;
                    let partialPixels = 0;
                    for (let i = 1; i < pixels.length; i += 4) {
                        coverage += pixels[i];
                        if (pixels[i] > 0 && pixels[i] < 225) ++partialPixels;
                    }
                    if (!coverage) return;
                    deck.setProps({_animate: false});
                    resolve({coverage, partialPixels, samples: gl.getParameter(gl.SAMPLES), pixels});
                }
            });
        });
        results.push(result);
    }
    let difference = 0;
    for (let i = 1; i < results[0].pixels.length; i += 4) {
        difference += Math.abs(results[0].pixels[i] - results[1].pixels[i]);
    }
    return {
        renderers: results.map(({pixels, ...statistics}) => statistics),
        relativePixelDifference: difference / results[1].coverage
    };
}
