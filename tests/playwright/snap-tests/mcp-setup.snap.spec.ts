import type { Request } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { mcpClient } from '../utils/mcp-client';
import {
    captureDocsScreenshotWithLabels,
    disableUiAnimations,
    dismissSurveyIfPresent,
    waitForAppReady
} from '../utils/ui-helpers';
import { viewerActions } from '../utils/viewer-contract';

// Run with EB_MAPGET_MCP_LOCAL=1 and the native mapget-native-grid.yaml fixture.
test.use({ stateSnapshot: null });
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Requires the native local MCP fixture');
test.skip(({ browserName }) => browserName !== 'chromium', 'The MCP setup documentation image uses Chromium');

test('MCP setup shows a registered tab and completed real tool calls', async ({ page, request }) => {
    await requireMapSource(request, 'TestMap', 'WayLayer');
    const backgroundRequests = new Set<Request>();
    let backgroundStarted = false;
    page.on('request', resource => {
        if (!resource.url().includes('/bundle/images/backgrounds/world-overview/')) return;
        backgroundStarted = true;
        backgroundRequests.add(resource);
    });
    page.on('requestfinished', resource => backgroundRequests.delete(resource));
    page.on('requestfailed', resource => backgroundRequests.delete(resource));
    // Bundled imagery keeps the documentation capture independent of external tile servers.
    await page.goto('/?v2=1&n=1&vid=0&m=1&f=0&sync=&lon=11&lat=48&alt=4000000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=1&bg=world-overview~100&tb=0&l=');
    await waitForAppReady(page);
    await disableUiAnimations(page);
    await dismissSurveyIfPresent(page);
    // A few offscreen map pixels otherwise widen full-page capture and dispatch
    // a viewport resize, which correctly dismisses PrimeNG's transient popover.
    await page.addStyleTag({ content: '.main-layout { contain: paint; }' });

    const trigger = page.getByTestId('viewer-action-status');
    await trigger.click();
    const details = page.getByTestId('viewer-action-details');
    const ready = details.getByRole('status').filter({ hasText: 'MCP controls ready' });
    await expect(ready).toBeVisible();
    const tabLabel = details.getByLabel('Tab label', { exact: true });
    await tabLabel.fill('Map review');
    await tabLabel.press('Tab');

    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).map(session => session.label))
        .toEqual(['Map review']);
    const clientId = (await mcp.sessions())[0].clientId;
    const discovery = await mcp.rpc('tools/list');
    expect(discovery.response.ok()).toBe(true);
    expect(discovery.message.result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(expect.arrayContaining(['viewer_list_sessions', 'viewer_describe_controls', 'viewer_get_controls']));

    // Populate the status panel through the native HTTP/WebSocket relay, never fabricated UI state.
    const described = await mcp.call('viewer_describe_controls', { clientId });
    expect(described.isError).not.toBe(true);
    viewerActions.viewer_describe_controls.outputSchema.parse(described.structuredContent);
    const observed = await mcp.call('viewer_get_controls', { clientId, targets: [{ control: 'app.views' }] });
    expect(observed.isError).not.toBe(true);
    viewerActions.viewer_get_controls.outputSchema.parse(observed.structuredContent);
    const activity = details.getByRole('list', { name: 'Recent agent activity' });
    await expect(activity.getByRole('listitem')).toHaveCount(2);
    await expect(activity.getByRole('listitem').filter({ hasText: 'viewer_describe_controls' })).toContainText('completed');
    await expect(activity.getByRole('listitem').filter({ hasText: 'viewer_get_controls' })).toContainText('completed');
    const stop = details.getByTestId('viewer-action-stop');
    await expect(stop.getByRole('button')).toBeDisabled();

    // The local textures finish independently of registration; the payload stream stays open.
    await expect.poll(() => backgroundStarted && backgroundRequests.size === 0).toBe(true);
    await page.mouse.move(0, 0);
    await expect(ready).toBeVisible();
    await expect(page).toHaveScreenshot('mcp-setup.png', {
        fullPage: true,
        maxDiffPixelRatio: 0.01
    });
    await expect(ready).toBeVisible({ timeout: 1000 });

    await page.mouse.move(0, 0);
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/mcp-setup-controls.png', [
        { locator: trigger, label: 'Open MCP controls', placement: 'left' },
        { locator: ready, label: 'Browser registered', placement: 'left' },
        { locator: tabLabel, label: 'Name the target tab', placement: 'left' },
        {
            locator: details.getByRole('group', { name: 'Copy Add-MCP-Command' }),
            label: 'Copy a client setup command',
            placement: 'left'
        },
        { locator: stop, label: 'Cancel pending work', placement: 'left' },
        { locator: activity, label: 'Recent tool calls and status', placement: 'bottom' }
    ], { strict: true });
});
