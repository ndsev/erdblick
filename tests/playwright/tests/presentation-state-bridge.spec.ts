import { expect, test } from "../fixtures/test";
import { requireMapSource } from "../utils/backend-helpers";
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS } from "../utils/test-params";

interface PresentationMessage {
    type: string;
    version: number;
    requestId?: number;
    ok?: boolean;
    capabilities?: { searches?: boolean };
}

/** Reads protocol messages captured by the same-origin test host. */
async function presentationMessages(page: import("@playwright/test").Page): Promise<PresentationMessage[]> {
    return page.evaluate(() => (
        window as typeof window & { presentationMessages?: PresentationMessage[] }
    ).presentationMessages ?? []);
}

test("presentation scenes apply state and authored searches without reloading the framed application", async ({ page, request }) => {
    await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await page.goto("/");
    await page.waitForSelector("#global-spinner-container", { state: "hidden" });
    const origin = new URL(page.url()).origin;
    let childDocumentRequests = 0;
    page.on("request", request => {
        if (request.resourceType() === "document" && request.frame().parentFrame()) {
            childDocumentRequests += 1;
        }
    });

    await page.evaluate(frameSource => {
        const hostWindow = window as typeof window & { presentationMessages: PresentationMessage[] };
        hostWindow.presentationMessages = [];
        window.addEventListener("message", event => {
            if (event.source === document.querySelector("iframe")?.contentWindow) {
                hostWindow.presentationMessages.push(event.data as PresentationMessage);
            }
        });
        const iframe = document.createElement("iframe");
        iframe.id = "presentation-mapviewer";
        iframe.src = frameSource;
        document.body.replaceChildren(iframe);
    }, `${origin}/?embed=presentation`);

    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.type === "erdblick:presentation:ready" && message.version === 2
        && message.capabilities?.searches === true
    )).toBe(true);
    const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    if (!child) {
        throw new Error("The framed Erdblick application was not created.");
    }
    await expect.poll(() => child.evaluate(() => !!window.ebDebug)).toBe(true);
    const initialTimeOrigin = await child.evaluate(() => performance.timeOrigin);

    const presentationState = await child.evaluate(() => {
        const snapshot = window.ebDebug!.stateService.exportSnapshot() as Record<string, unknown>;
        const duplicateViewValue = (name: string): void => {
            const values = snapshot[name];
            if (Array.isArray(values) && values.length) {
                snapshot[name] = [structuredClone(values[0]), structuredClone(values[0])];
            }
        };
        snapshot["numberOfViews"] = 2;
        snapshot["viewIds"] = ["presentation-first", "presentation-second"];
        for (const name of [
            "cameraView", "layerSyncOptions", "background", "visibility", "tileBorders",
            "tileGridMode", "tileGridLevel", "tileGridAutoLevel", "tileGridColor",
            "tileGridOpacity", "zoomLevel", "autoZoomLevel"
        ]) {
            duplicateViewValue(name);
        }
        snapshot["mode2d"] = [true, false];
        return snapshot;
    });

    await page.evaluate(({ targetOrigin, state }) => {
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.postMessage({
            type: "erdblick:presentation:apply-state",
            version: 2,
            requestId: 1,
            state
        }, targetOrigin);
    }, { targetOrigin: origin, state: presentationState });

    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.type === "erdblick:presentation:result"
        && message.requestId === 1
        && message.ok === true
    )).toBe(true);
    await expect.poll(() => child.evaluate(() => {
        const snapshot = window.ebDebug?.stateService.exportSnapshot();
        return snapshot ? [snapshot["numberOfViews"], ...(snapshot["mode2d"] as boolean[])] : null;
    })).toEqual([2, true, false]);
    await expect.poll(() => child.evaluate(() => [0, 1].map(viewIndex => {
        const canvas = document.querySelector<HTMLCanvasElement>(`#mapViewContainer-${viewIndex} canvas`);
        return canvas ? [canvas.width > 0, canvas.height > 0] : null;
    }))).toEqual([[true, true], [true, true]]);

    const searches = [{
        query: "true", scope: "feature", autoUpdate: false,
        selectedMapLayers: [{ mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0] }],
        selectedMapLayersManual: true, selectedViewIndices: [0], selectedTileLevels: [13],
        showResultsOnMap: false
    }];
    const [lon, lat] = TEST_VIEW_POSITIONS[0];
    await page.evaluate(({ targetOrigin, searches, search }) => {
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.postMessage({
            type: "erdblick:presentation:apply-url-state", version: 2, requestId: 2,
            search, reset: false, searches
        }, targetOrigin);
    }, { targetOrigin: origin, searches, search: `?embed=presentation&v2=1&lon=${lon}&lat=${lat}&alt=1200&tll=4` });
    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.requestId === 2 && message.ok === true
    )).toBe(true);
    await expect(child.getByTestId("feature-search-panel")).toHaveCount(1);
    await expect(child.locator(".feature-search-query-input .cm-content")).toHaveText("true");
    await expect(child.getByTestId("feature-search-panel").getByRole("tab", { name: /^Results/ }))
        .toContainText(/Results\s*[1-9][0-9]*/);
    await expect(child.locator("feature-search")).toContainText(/Complete, \d+\/\d+ tiles/);
    await expect(child.getByTestId("feature-search-tree").getByRole("treeitem").first()).toBeVisible();

    await page.evaluate(targetOrigin => {
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.postMessage({
            type: "erdblick:presentation:apply-url-state", version: 2, requestId: 3,
            search: "?embed=presentation&v2=1", reset: false, searches: []
        }, targetOrigin);
    }, origin);
    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.requestId === 3 && message.ok === true
    )).toBe(true);
    await expect(child.getByTestId("feature-search-panel")).toHaveCount(0);

    expect(await child.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigin);
    expect(childDocumentRequests).toBe(1);
});
