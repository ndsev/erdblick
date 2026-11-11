import type { APIRequestContext, Page, Request } from '@playwright/test';
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
test.use({ stateSnapshot: null, viewport: { width: 1600, height: 1200 } });
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Requires the native local MCP fixture');
test.skip(({ browserName }) => browserName !== 'chromium', 'The MCP setup documentation image uses Chromium');

/** Prepares actual native registration/activity and a deterministic bundled background. */
async function prepareMcpControls(page: Page, request: APIRequestContext) {
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
    const ready = details.getByTestId('viewer-action-availability');
    await expect(ready).toHaveText('ready');
    await expect(ready).toHaveClass(/p-tag-success/);
    await expect(ready).toBeVisible();
    const tabLabel = details.getByLabel('Tab label', { exact: true });
    await tabLabel.fill('Map review');
    await tabLabel.press('Shift+Tab');

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
    return {trigger, details, ready, tabLabel, activity, stop, configure: details.getByTestId('mcp-configure').getByRole('button')};
}

test('MCP controls show registration, real activity and the Configure shortcut', async ({page, request}) => {
    const {trigger, ready, activity} = await prepareMcpControls(page, request);
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('mcp-setup.png', {fullPage: true, maxDiffPixelRatio: 0.01});
    await expect(ready).toBeVisible({timeout: 1000});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/mcp-setup-controls.png', [
        {locator: trigger, label: 'Open MCP controls', placement: 'left'},
        {locator: page.getByTestId('mcp-controls-row'), label: 'MCP status and configuration', placement: 'left'},
        {locator: page.getByTestId('viewer-action-tab-label'), label: 'Name the target tab', placement: 'left'},
        {locator: page.getByTestId('viewer-action-stop-controls'), label: 'Stop pending work and help', placement: 'left'},
        {locator: activity, label: 'Recent tool calls', placement: 'left'}
    ], {strict: true});
});

test('MCP Configuration reveals platform, agent and remote setup fields', async ({page, request}) => {
    const {configure} = await prepareMcpControls(page, request);
    await configure.click();
    const dialog = page.getByRole('dialog', {name: 'MCP Configuration', exact: true});
    const platforms = dialog.getByTestId('mcp-platform-selector');
    await expect(dialog.getByTestId('mcp-agent-selector')).toHaveCount(0);
    await platforms.getByRole('button', {name: 'Linux', exact: true}).click();
    const agents = dialog.getByTestId('mcp-agent-selector');
    await agents.getByRole('button', {name: 'Codex CLI', exact: true}).click();
    await expect(dialog.getByTestId('mcp-provider-docs')).toBeInViewport();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('mcp-configuration.png', {fullPage: true, maxDiffPixelRatio: 0.01});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/mcp-configuration.png', [
        {locator: platforms, label: '1. Choose the platform', placement: 'left'},
        {locator: agents, label: '2. Choose the agent', placement: 'left'},
        {locator: dialog.getByTestId('mcp-setup-field-url'), label: 'Current server endpoint', placement: 'left'},
        {locator: dialog.getByTestId('mcp-setup-field-add'), label: 'Copy the setup command', placement: 'left'},
        {locator: dialog.getByTestId('mcp-setup-field-verify'), label: 'Verify the connection', placement: 'left'},
        {locator: dialog.getByTestId('mcp-provider-docs'), label: 'Full provider instructions', placement: 'left'}
    ], {strict: true});
});

test('MCP Configuration offers app browser setup and the current viewer route', async ({page, request}) => {
    const {configure} = await prepareMcpControls(page, request);
    await configure.click();
    const dialog = page.getByRole('dialog', {name: 'MCP Configuration', exact: true});
    await dialog.getByRole('button', {name: 'Linux', exact: true}).click();
    await dialog.getByRole('button', {name: 'ChatGPT App', exact: true}).click();
    await dialog.getByRole('button', {name: 'WebMCP', exact: true}).click();
    await expect(dialog.getByLabel('Current viewer URL', {exact: true})).toHaveValue(page.url());
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('mcp-configuration-webmcp.png', {fullPage: true, maxDiffPixelRatio: 0.01});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/mcp-configuration-webmcp.png', [
        {locator: dialog.getByTestId('mcp-platform-selector'), label: '1. Choose the platform', placement: 'left'},
        {locator: dialog.getByTestId('mcp-agent-selector'), label: '2. Choose an app', placement: 'left'},
        {locator: dialog.getByTestId('mcp-connection-selector'), label: '3. Choose the connection', placement: 'left'},
        {locator: dialog.getByTestId('mcp-setup-field-viewer-url'), label: 'Copy the current route', placement: 'left'},
        {locator: dialog.getByRole('list', {name: 'Finish setup'}), label: 'Open the app browser', placement: 'left'},
        {locator: dialog.getByTestId('mcp-provider-docs'), label: 'Full browser instructions', placement: 'left'}
    ], {strict: true});
});
