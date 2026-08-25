import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {of, throwError} from "rxjs";

import {CacheResetService} from "./cache-reset.service";

class HttpClientStub {
    post = vi.fn();
}

describe("CacheResetService", () => {
    it("posts the selected map and announces only a confirmed reset", async () => {
        const httpClient = new HttpClientStub();
        httpClient.post.mockReturnValue(of(undefined));
        const service = new CacheResetService(httpClient as any);
        const completed = vi.fn();
        service.completed$.subscribe(completed);

        await service.reset("Map/A");

        expect(httpClient.post).toHaveBeenCalledWith(
            "/cache/reset",
            {mapId: "Map/A"}
        );
        expect(completed).toHaveBeenCalledWith("Map/A");
    });

    it("does not announce a failed reset", async () => {
        const httpClient = new HttpClientStub();
        httpClient.post.mockReturnValue(
            throwError(() => new Error("denied"))
        );
        const service = new CacheResetService(httpClient as any);
        const completed = vi.fn();
        service.completed$.subscribe(completed);

        await expect(service.reset("Map/A")).rejects.toThrow("denied");

        expect(completed).not.toHaveBeenCalled();
    });
});
