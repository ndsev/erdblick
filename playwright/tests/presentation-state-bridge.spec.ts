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

test("presentation URL state is applied without reloading the framed application", async ({page}) => {
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
    }, `${origin}/?embed=presentation&m2d=0&n=1&v2=1`);

    await expect.poll(async () => (await presentationMessages(page)).some(message =>
        message.type === "erdblick:presentation:ready" && message.version === 1
    )).toBe(true);
    const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    if (!child) {
        throw new Error("The framed Erdblick application was not created.");
    }
    await expect.poll(() => child.evaluate(() => !!window.ebDebug)).toBe(true);
    const initialTimeOrigin = await child.evaluate(() => performance.timeOrigin);

    await page.evaluate(targetOrigin => {
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.postMessage({
            type: "erdblick:presentation:apply-url-state",
            version: 1,
            requestId: 1,
            search: "?embed=presentation&m2d=1%2C0&n=2&v2=1"
        }, targetOrigin);
    }, origin);

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
