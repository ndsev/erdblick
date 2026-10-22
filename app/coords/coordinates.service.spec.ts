import { CoordinatesStore } from "./coordinates.store";
import "@angular/compiler";
import { testPersistence } from "../../test/state-owners";
import { describe, it, expect, vi } from 'vitest';
import { CoordinatesService } from './coordinates.service';

class AppConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

const createService = () => {
    const stateService = testPersistence();
    const configService = new AppConfigServiceStub();
    const service = new CoordinatesService(stateService as any, configService as any, new CoordinatesStore(stateService as any));
    return { service, stateService, configService };
};

describe('CoordinatesService', () => {
    it('stores mouse click coordinates on its owner, skipping the initial null', () => {
        const { service } = createService();
        const setMarkerPosition = vi.spyOn(service, "setMarkerPosition");

        expect(setMarkerPosition).not.toHaveBeenCalled();

        const position = { longitude: 1, latitude: 2, height: 3 } as any;
        service.mouseClickCoordinates.next(position);

        expect(setMarkerPosition).toHaveBeenCalledTimes(1);
        expect(setMarkerPosition).toHaveBeenCalledWith(position);
    });

    it('loads the auxiliary plugin when a jump-target extension module is configured', async () => {
        const { service, configService } = createService();
        const loaderSpy = vi.spyOn(CoordinatesService.prototype as any, 'loadJumpTargetsModule').mockResolvedValue({
            getAuxCoordinates: () => null,
            getAuxTileIds: () => null,
        });

        try {
            configService.getExtensionModuleId.mockReturnValue('jump_plugin');

            service.initialize();

            await new Promise(resolve => setTimeout(resolve, 0));

            expect(loaderSpy).toHaveBeenCalledWith('/static-config/jump_plugin.js');
        } finally {
            loaderSpy.mockRestore();
        }
    });
}
);
