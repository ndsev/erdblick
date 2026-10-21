import {runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {AppStateService} from "../shared/appstate.service";
import {describe, it, expect, vi} from 'vitest';
import {CoordinatesService} from './coordinates.service';

class AppConfigServiceStub {
    getExtensionModuleId = vi.fn().mockReturnValue(null);
}

class MapViewStateStub {
    setMarkerPosition = vi.fn();
}

const createService = () => {
    const viewState = new MapViewStateStub();
    const injector = ownerTestInjector([{provide: MapViewStateService, useValue: viewState}]);
    const configService = new AppConfigServiceStub();
    const service = runInInjectionContext(injector, () =>
        new CoordinatesService(injector.get(AppStateService), configService as any));
    return {service, viewState, configService};
};

describe('CoordinatesService', () => {
    it('forwards mouse click coordinates to the view owner, skipping the initial null', () => {
        const {service, viewState} = createService();

        expect(viewState.setMarkerPosition).not.toHaveBeenCalled();

        const position = {longitude: 1, latitude: 2, height: 3} as any;
        service.mouseClickCoordinates.next(position);

        expect(viewState.setMarkerPosition).toHaveBeenCalledTimes(1);
        expect(viewState.setMarkerPosition).toHaveBeenCalledWith(position);
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
