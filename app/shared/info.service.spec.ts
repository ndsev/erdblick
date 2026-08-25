import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {InfoMessageService} from "./info.service";

describe("InfoMessageService configuration-editing notices", () => {
    it("stacks source-style and writable map-preset notices in one host", () => {
        const messages = {clear: vi.fn(), add: vi.fn()};
        const service = new InfoMessageService(messages as any, {} as any);

        service.showConfigurationEditingNotices("/workspace/styles", true);

        expect(messages.clear).toHaveBeenCalledWith("configuration-editing");
        expect(messages.add).toHaveBeenNthCalledWith(1, {
            key: "configuration-editing",
            severity: "warn",
            summary: "Source Style Editing Enabled",
            detail: "Saving a style will overwrite YAML files below /workspace/styles.",
            sticky: true
        });
        expect(messages.add).toHaveBeenNthCalledWith(2, {
            key: "configuration-editing",
            severity: "warn",
            summary: "Server Map Preset Editing Enabled",
            detail: "Changes to map presets are saved to the server configuration.",
            sticky: true
        });
    });

    it("shows only the map-preset notice for ordinary writable deployments", () => {
        const messages = {clear: vi.fn(), add: vi.fn()};
        const service = new InfoMessageService(messages as any, {} as any);

        service.showConfigurationEditingNotices(null, true);

        expect(messages.add).toHaveBeenCalledOnce();
        expect(messages.add).toHaveBeenCalledWith(expect.objectContaining({
            severity: "warn",
            detail: "Changes to map presets are saved to the server configuration."
        }));
    });
});
