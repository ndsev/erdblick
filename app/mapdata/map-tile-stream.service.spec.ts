import {Subject} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {MapTileStreamService} from './map-tile-stream.service';

describe('MapTileStreamService source catalog refresh', () => {
    it('reloads again when a backend reconnect races an in-flight catalog fetch', async () => {
        let finishFirstReload: (() => void) | null = null;
        const mapInfo = {
            dataSourceInfoChanged: new Subject<void>(),
            sourceCatalogRevision: 49,
            reloadDataSources: vi.fn()
                .mockImplementationOnce(() => new Promise<boolean>(resolve => {
                    finishFirstReload = () => resolve(true);
                }))
                .mockResolvedValue(true)
        };
        const service = new MapTileStreamService(
            {tilePullCompressionEnabledState: new Subject<boolean>()} as any,
            mapInfo as any,
            {viewStateChanged: new Subject<void>()} as any,
            {} as any,
            {
                run: (callback: () => unknown) => callback(),
                runOutsideAngular: (callback: () => unknown) => callback()
            } as any
        );
        const internals = service as any;
        internals.tileStream = {getSourcesRevision: () => 1};
        internals.scheduleUpdate = vi.fn();

        internals.requestSourceCatalogRefresh(49);
        expect(mapInfo.reloadDataSources).toHaveBeenCalledTimes(1);

        // The new backend may reuse or lower the process-local revision while
        // the request started against its predecessor is still unresolved.
        internals.handleSourcesRevisionChanged(1, true);
        finishFirstReload?.();

        await vi.waitFor(() => expect(mapInfo.reloadDataSources).toHaveBeenCalledTimes(2));
    });
});
