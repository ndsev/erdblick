import { expect, test } from '../fixtures/test';
import { mcpClient } from '../utils/mcp-client';
import { waitForAppReady } from '../utils/ui-helpers';
import { screenshotMetadataSchema } from '../utils/viewer-contract';

test.use({ stateSnapshot: null });
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Requires the native local MCP fixture');

test('MCP screenshots complete and release admission while animation frames are suspended', async ({ page, request }, testInfo) => {
    await page.goto('/?v2=1&n=1&vid=overview&m=0&f=0&sync=&lon=11&lat=48&alt=1000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=1&bg=~10&tb=0&l=');
    await waitForAppReady(page);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('MCP controls ready');
    const label = page.getByLabel('Tab label', { exact: true });
    await label.fill('Screenshot lifecycle');
    await label.press('Tab');
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).map(session => session.label))
        .toEqual(['Screenshot lifecycle']);
    const clientId = (await mcp.sessions())[0].clientId;

    // Emulate a background tab without relying on headless-browser throttling heuristics.
    // Keep pending callbacks so restoring the scheduler also resumes ordinary map work.
    await page.evaluate(() => {
        const testWindow = window as Window & { restoreMcpAnimationFrames?: () => void };
        const requestFrame = window.requestAnimationFrame;
        const cancelFrame = window.cancelAnimationFrame;
        const pending = new Map<number, FrameRequestCallback>();
        let nextId = -1;
        window.requestAnimationFrame = callback => {
            const id = nextId--;
            pending.set(id, callback);
            return id;
        };
        window.cancelAnimationFrame = id => {
            if (id < 0) pending.delete(id);
            else cancelFrame.call(window, id);
        };
        testWindow.restoreMcpAnimationFrames = () => {
            window.requestAnimationFrame = requestFrame;
            window.cancelAnimationFrame = cancelFrame;
            for (const callback of pending.values()) requestFrame.call(window, callback);
            pending.clear();
            delete testWindow.restoreMcpAnimationFrames;
        };
    });

    const captures: Array<{ elapsedMs: number; result: Awaited<ReturnType<typeof mcp.call>> }> = [];
    try {
        // Collect both results before asserting, preserving evidence of a stuck admission lock.
        for (let index = 0; index < 2; ++index) {
            const started = Date.now();
            const result = await mcp.call('viewer_screenshot', { clientId, maxWidth: 640, maxHeight: 480 });
            captures.push({ elapsedMs: Date.now() - started, result });
        }
    } finally {
        await page.evaluate(() => {
            (window as Window & { restoreMcpAnimationFrames?: () => void }).restoreMcpAnimationFrames?.();
        });
    }
    await testInfo.attach('suspended-animation-frame-captures', {
        body: JSON.stringify(captures.map(({ elapsedMs, result }) => ({
            elapsedMs,
            isError: result.isError === true,
            metadata: result.structuredContent,
            text: result.content.filter((item: { type: string }) => item.type === 'text')
        }))),
        contentType: 'application/json'
    });
    for (const [index, { elapsedMs, result }] of captures.entries()) {
        expect(result.isError, `Capture ${index + 1}: ${JSON.stringify(result.content.filter((item: { type: string }) => item.type === 'text'))}`)
            .not.toBe(true);
        expect(elapsedMs, `Capture ${index + 1} must fit the browser's 15-second budget with transport allowance`)
            .toBeLessThan(20000);
        const metadata = screenshotMetadataSchema.parse(result.structuredContent);
        expect(metadata).toMatchObject({ scope: 'application-viewport', readiness: { status: 'unknown' } });
        expect(metadata.width).toBeLessThanOrEqual(640);
        expect(metadata.height).toBeLessThanOrEqual(480);
        const image = result.content.find((item: { type: string }) => item.type === 'image');
        expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
        expect(image.data.length).toBeLessThanOrEqual(240000);
        await testInfo.attach(`suspended-animation-frame-image-${index + 1}`, {
            body: Buffer.from(image.data, 'base64'), contentType: 'image/jpeg'
        });
    }
});
