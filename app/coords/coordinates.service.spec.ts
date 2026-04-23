import {describe, it, expect, vi} from 'vitest';
import {CoordinatesService} from './coordinates.service';

class AppConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

class AppStateServiceStub {
    setMarkerPosition = vi.fn();
}

const createService = () => {
    const stateService = new AppStateServiceStub();
    const configService = new AppConfigServiceStub();
    const service = new CoordinatesService(stateService as any, configService as any);
    return {service, stateService, configService};
};

describe('CoordinatesService', () => {
    it('forwards mouse click coordinates to AppStateService, skipping the initial null', () => {
        const {service, stateService} = createService();

        expect(stateService.setMarkerPosition).not.toHaveBeenCalled();

        const position = {longitude: 1, latitude: 2, height: 3} as any;
        service.mouseClickCoordinates.next(position);

        expect(stateService.setMarkerPosition).toHaveBeenCalledTimes(1);
        expect(stateService.setMarkerPosition).toHaveBeenCalledWith(position);
    });

    it('loads the auxiliary plugin when a jump-target extension module is configured', async () => {
        const {service, configService} = createService();
        const loaderSpy = vi.spyOn(CoordinatesService.prototype as any, 'loadJumpTargetsModule').mockResolvedValue({
            getAuxCoordinates: () => null,
            getAuxTileIds: () => null,
        });

        try {
            configService.getExtensionModuleId.mockReturnValue('jump_plugin');

            service.initialize();

            await new Promise(resolve => setTimeout(resolve, 0));

            expect(loaderSpy).toHaveBeenCalledWith('/config/jump_plugin.js');
        } finally {
            loaderSpy.mockRestore();
        }
    });
}
);
