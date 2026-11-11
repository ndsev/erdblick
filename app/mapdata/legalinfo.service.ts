/** Shared attribution for the map edge and the complete legal-information dialog. */
import { Injectable } from "@angular/core";
import { combineLatest, distinctUntilChanged, map, Observable, shareReplay, startWith } from "rxjs";
import { deepEquals } from "../appstate/appstate.model";
import { AppStateService } from "../appstate/appstate.service";
import { AppConfigService } from "../config/appconfig.service";
import { MapViewState } from "../mapview/mapview.state";
import { MapDataService } from "./mapdata.service";

/**
 * Combine notices supplied by loaded map tiles with configured credits for the
 * backgrounds visible in any view. Both UI surfaces observe this same list, so
 * switching backgrounds also updates the legal dialog without a new tile load.
 * Subscriptions belong to the consumers; this service starts no loading work.
 */
@Injectable({ providedIn: "root" })
export class LegalInfoService {
    readonly entries$: Observable<readonly { source: string; notices: readonly string[] }[]>;
    readonly attribution$: Observable<string>;

    constructor(
        mapData: MapDataService,
        config: AppConfigService,
        views: MapViewState,
        persistence: AppStateService
    ) {
        // View membership and per-view backgrounds can change together during
        // URL restore. Read them after the completed state edit; equal selections
        // suppress unrelated updates, including camera movement while panning.
        const backgrounds = persistence.observe(
            () => views.viewIds.map((_, index) => views.getBackgroundState(index)),
            deepEquals
        );
        this.entries$ = combineLatest([
            mapData.legalInformationUpdated.pipe(startWith(true)),
            config.config$,
            backgrounds
        ]).pipe(
            map(([, settings]) => {
                const entries: { source: string; notices: string[] }[] = [];
                for (const [source, notices] of mapData.legalInformationPerMap) {
                    const nonempty = [...notices].filter(notice => notice.trim().length > 0);
                    if (nonempty.length) {
                        entries.push({ source, notices: nonempty });
                    }
                }

                // Use the renderer's fallback resolution for removed background
                // IDs. Omit backgrounds the user has hidden or made transparent.
                const visibleIds = new Set<string>();
                for (let index = 0; index < views.numViews; index++) {
                    const background = views.resolveBackgroundState(
                        index, settings.backgroundLayers, settings.defaultBackgroundLayerId
                    );
                    if (background.layerId !== null && background.opacity > 0) {
                        visibleIds.add(background.layerId);
                    }
                }
                for (const layer of settings.backgroundLayers) {
                    if (visibleIds.has(layer.id) && layer.attribution?.trim()) {
                        entries.push({
                            source: `${layer.name} (background imagery)`,
                            notices: [layer.attribution]
                        });
                    }
                }
                return entries;
            }),
            distinctUntilChanged((previous, current) => deepEquals(previous, current)),
            shareReplay({ bufferSize: 1, refCount: true })
        );

        // Preserve complete notice text. Repeated credits need only appear once
        // at the map edge; the dialog still identifies every contributing source.
        this.attribution$ = this.entries$.pipe(map(entries =>
            [...new Set(entries.flatMap(entry => entry.notices))].join(" · ")
        ));
    }
}
