import {runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore} from "../shared/app.store";
import {describe, it, expect, vi} from 'vitest';
import {CoordinatesService} from './coordinates.service';

class AppConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

const createService = () => {
    const injector = ownerTestInjector();
    const store = injector.get(AppStore);
    vi.spyOn(store, "setMarkerPosition");
    const configService = new AppConfigServiceStub();
    const service = runInInjectionContext(injector, () =>
        new CoordinatesService(configService as any));
    return {service, store, configService};
};

describe('CoordinatesService', () => {
    it('forwards mouse click coordinates to the view owner, skipping the initial null', () => {
        const {service, store} = createService();

        expect(store.setMarkerPosition).not.toHaveBeenCalled();

        const position = {longitude: 1, latitude: 2, height: 3} as any;
        service.mouseClickCoordinates.next(position);

        expect(store.setMarkerPosition).toHaveBeenCalledTimes(1);
        expect(store.setMarkerPosition).toHaveBeenCalledWith(position);
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

            expect(loaderSpy).toHaveBeenCalledWith('/static-config/jump_plugin.js');
        } finally {
            loaderSpy.mockRestore();
        }
    });
}
);
