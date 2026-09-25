import {expect, test} from '../fixtures/test';
import {navigateToRoot} from '../utils/ui-helpers';
import {
    DUAL_SIMPLE_PATH_FRAGMENT_SHADER,
    SIMPLE_PATH_FRAGMENT_SHADER
} from '../../app/mapview/deck/erdblick-vector.shaders';

test.use({stateSnapshot: null});

test('3D contact shading preserves the canvas multisampling', async ({page}) => {
    await page.addInitScript(() => {
        const allocations: Array<{samples: number; width: number; height: number}> = [];
        Object.assign(window, {renderbufferAllocations: allocations});
        const allocate = WebGL2RenderingContext.prototype.renderbufferStorageMultisample;
        WebGL2RenderingContext.prototype.renderbufferStorageMultisample = function(
            target, samples, format, width, height
        ) {
            if (format === this.RGBA8) {
                allocations.push({samples, width, height});
            }
            return allocate.call(this, target, samples, format, width, height);
        };
    });
    await navigateToRoot(page);
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug?.subsetRenderPresentation().views
    )).toBe(1);
    const canvasSamples = await page.getByTestId('mapViewContainer-0')
        .locator('canvas').first().evaluate(element => {
            const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
            const previous = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            try {
                return {
                    samples: gl.getParameter(gl.SAMPLES) as number,
                    width: gl.drawingBufferWidth,
                    height: gl.drawingBufferHeight
                };
            } finally {
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous);
            }
        });
    test.skip(canvasSamples.samples === 0, 'This browser did not grant canvas MSAA.');
    await expect.poll(() => page.evaluate(() =>
        (window as unknown as {renderbufferAllocations: unknown[]}).renderbufferAllocations
    )).toContainEqual(canvasSamples);
});

for (const [kind, shader] of [
    ['two-point', SIMPLE_PATH_FRAGMENT_SHADER],
    ['dual-stroke two-point', DUAL_SIMPLE_PATH_FRAGMENT_SHADER]
]) {
    test(`${kind} line bodies retain partially covered MSAA pixels`, async ({page}, testInfo) => {
        const result = await page.evaluate(fragmentShader => {
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 192;
            const gl = canvas.getContext('webgl2', {antialias: true, preserveDrawingBuffer: true})!;
            const samples = gl.getParameter(gl.SAMPLES) as number;
            const vertexShader = `#version 300 es
    precision highp float;
    out vec4 vColor;
    out vec2 vPathPosition;
    out float vPathLength;
    flat out vec4 vInnerColor;
    flat out float vInnerWidthRatio;
    void main() {
        vec2 start = vec2(16.0, 75.0);
        vec2 end = vec2(496.0, 123.0);
        vec2 direction = normalize(end - start);
        vec2 normal = vec2(-direction.y, direction.x);
        float halfWidth = 1.5;
        bool isEnd = gl_VertexID >= 2;
        float side = (gl_VertexID % 2) == 0 ? -1.0 : 1.0;
        vec2 pixel = (isEnd ? end : start) + normal * side * halfWidth
            + direction * (isEnd ? halfWidth : -halfWidth);
        gl_Position = vec4(pixel / vec2(512.0, 192.0) * 2.0 - 1.0, 0.0, 1.0);
        vPathLength = length(end - start) / halfWidth;
        vPathPosition = vec2(side, isEnd ? vPathLength + 1.0 : -1.0);
        vColor = vec4(1.0);
        vInnerColor = vec4(1.0);
        vInnerWidthRatio = 0.5;
    }`;
            /** Compile a real WebGL shader, surfacing driver errors in the test. */
            const compile = (type: number, source: string) => {
                const shader = gl.createShader(type)!;
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                    throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
                }
                return shader;
            };
            /** Render the same shallow-sloping quad and measure its resolved edge coverage. */
            const render = (source: string) => {
                const program = gl.createProgram()!;
                const vertex = compile(gl.VERTEX_SHADER, vertexShader);
                const fragment = compile(gl.FRAGMENT_SHADER, source);
                gl.attachShader(program, vertex);
                gl.attachShader(program, fragment);
                gl.linkProgram(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                    throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed');
                }
                gl.useProgram(program);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                let coverage = 0;
                let partialPixels = 0;
                // Compare only the body: the end caps intentionally trim the quad.
                for (let y = 0; y < canvas.height; ++y) {
                    for (let x = 32; x < 480; ++x) {
                        const value = pixels[(y * canvas.width + x) * 4];
                        coverage += value;
                        if (value > 0 && value < 255) ++partialPixels;
                    }
                }
                gl.deleteProgram(program);
                gl.deleteShader(vertex);
                gl.deleteShader(fragment);
                return {coverage, partialPixels, image: canvas.toDataURL()};
            };
            // Isolate the production fragment from Deck's color/picking hooks.
            const actual = render(fragmentShader.replace('precision highp float;', `
    precision highp float;
    struct Geometry { vec2 uv; };
    Geometry geometry;
    struct Picking { float isActive; };
    Picking picking = Picking(0.0);
    #define DECKGL_FILTER_COLOR(color, geometry)
    `));
            const reference = render(`#version 300 es
    precision highp float;
    out vec4 fragColor;
    void main() { fragColor = vec4(1.0); }`);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            return {samples, actual, reference};
        }, shader);
        test.skip(result.samples === 0, 'This browser did not grant canvas MSAA.');
        for (const [name, rendered] of Object.entries({actual: result.actual, reference: result.reference})) {
            await testInfo.attach(`${name}.png`, {
                body: Buffer.from(rendered.image.split(',')[1], 'base64'),
                contentType: 'image/png'
            });
        }
        expect(result.reference.partialPixels).toBeGreaterThan(0);
        expect(result.actual.coverage).toBe(result.reference.coverage);
        expect(result.actual.partialPixels).toBe(result.reference.partialPixels);
    });
}
