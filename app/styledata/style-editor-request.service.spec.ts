import "@angular/compiler";
import {describe, expect, it} from "vitest";
import {StyleEditorRequestService} from "./style-editor-request.service";

describe("StyleEditorRequestService", () => {
    it("publishes the full style id requested by the map tree", () => {
        const service = new StyleEditorRequestService();
        const received: string[] = [];
        const subscription = service.requests.subscribe(styleId => received.push(styleId));

        service.open("customer/group/roads");

        expect(received).toEqual(["customer/group/roads"]);
        subscription.unsubscribe();
    });
});
