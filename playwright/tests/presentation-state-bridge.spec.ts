import {expect, test} from "../fixtures/test";

interface PresentationMessage {
    type: string;
    version: number;
    requestId?: number;
    ok?: boolean;
}

/** Reads protocol messages captured by the same-origin test host. */
async function presentationMessages(page: import("@playwright/test").Page): Promise<PresentationMessage[]> {
    return page.evaluate(() => (
        window as typeof window & {presentationMessages?: PresentationMessage[]}
    ).presentationMessages ?? []);
}

test("presentation snapshot state is applied without reloading the framed application", async ({page}) => {
    await page.goto("/");
    await page.waitForSelector("#global-spinner-container", {state: "hidden"});
    const origin = new URL(page.url()).origin;
    let childDocumentRequests = 0;
    page.on("request", request => {
        if (request.resourceType() === "document" && request.frame().parentFrame()) {
            childDocumentRequests += 1;
        }
    });

    await page.evaluate(frameSource => {
        const hostWindow = window as typeof window & {presentationMessages: PresentationMessage[]};
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

    await page.evaluate(({targetOrigin, state}) => {
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.postMessage({
            type: "erdblick:presentation:apply-state",
            version: 2,
            requestId: 1,
            state
        }, targetOrigin);
    }, {targetOrigin: origin, state: presentationState});

    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.type === "erdblick:presentation:result"
        && message.requestId === 1
        && message.ok === true
    )).toBe(true);
    await expect.poll(() => child.evaluate(() => {
        const state = window.ebDebug?.stateService;
        return state
            ? [state.numViews, state.mode2dState.getValue(0), state.mode2dState.getValue(1)]
            : null;
    })).toEqual([2, true, false]);
    await expect.poll(() => child.evaluate(() => [0, 1].map(viewIndex => {
        const canvas = document.querySelector<HTMLCanvasElement>(`#mapViewContainer-${viewIndex} canvas`);
        return canvas ? [canvas.width > 0, canvas.height > 0] : null;
    }))).toEqual([[true, true], [true, true]]);

    expect(await child.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigin);
    expect(childDocumentRequests).toBe(1);
});
