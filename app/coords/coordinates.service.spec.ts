import {describe, it, expect, vi} from 'vitest';
import {of} from 'rxjs';

import {CoordinatesService} from './coordinates.service';

class HttpClientStub {
    get = vi.fn();
}

class AppStateServiceStub {
    setMarkerPosition = vi.fn();
}

const createService = () => {
    const httpClient = new HttpClientStub();
    const stateService = new AppStateServiceStub();
    const service = new CoordinatesService(httpClient as any, stateService as any);
    return {service, httpClient, stateService};
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

    it('calls config.json during initialization when auxiliary plugin is configured', async () => {
        const {service, httpClient} = createService();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const loaderSpy = vi.spyOn(CoordinatesService.prototype as any, 'loadJumpTargetsModule').mockResolvedValue({
            getAuxCoordinates: () => null,
            getAuxTileIds: () => null,
        });

        try {
            httpClient.get.mockImplementation((url: string) => {
                if (url === 'config.json') {
                    return of({
                        extensionModules: {
                            jumpTargets: 'jump_plugin',
                        },
                    });
                }
                throw new Error(`Unexpected URL ${url}`);
            });

            service.initialize();

            await new Promise(resolve => setTimeout(resolve, 0));

            expect(httpClient.get).toHaveBeenCalledWith('config.json', {responseType: 'json'});
            expect(loaderSpy).toHaveBeenCalledWith('/config/jump_plugin.js');
        } finally {
            loaderSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });
}
);
