import {AsyncPipe} from "@angular/common";
import {HttpErrorResponse} from "@angular/common/http";
import {Component} from "@angular/core";
import {TooltipModule} from "primeng/tooltip";
import {map, Observable} from "rxjs";

import {CacheResetService} from "../mapdata/cache-reset.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {isDataSourceCatalogEntryReady} from "../mapdata/map.tree.model";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {AppConfigService} from "../shared/app-config.service";
import {
    AppStateService,
    CACHE_RESET_DIALOG_LAYOUT_ID
} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";

@Component({
    selector: "cache-reset-dialog",
    template: `
        <app-dialog header="Cache Reset"
                    styleClass="app-dialog-compact cache-reset-dialog"
                    data-testid="cache-reset-dialog"
                    [(visible)]="dialogVisible"
                    [modal]="false"
                    [persistLayout]="true"
                    [layoutId]="dialogLayoutId"
                    [style]="{'width': 'min(32rem, 92vw)'}">
            <p class="cache-reset-description">
                Clear server-side tile data for a configured map. Its visible layers will then load again.
            </p>
            @if (!enabled) {
                <p class="cache-reset-unavailable" role="status">
                    Cache reset is not enabled for this session.
                </p>
            }
            @if (mapIds$ | async; as mapIds) {
                @if (mapIds.length) {
                    <div class="cache-reset-list">
                        @for (mapId of mapIds; track mapId; let index = $index) {
                            <div class="cache-reset-row">
                                <span class="cache-reset-map-id" [title]="mapId">{{ mapId }}</span>
                                <span [pTooltip]="tooltip(mapId)" tooltipPosition="left">
                                    <button type="button"
                                            class="cache-reset-button"
                                            [attr.data-testid]="'cache-reset-map-' + index"
                                            [attr.aria-label]="'Reset tile cache for ' + mapId"
                                            [attr.aria-busy]="isPending(mapId)"
                                            [disabled]="!enabled || isPending(mapId)"
                                            (click)="reset(mapId)">
                                        <span class="material-symbols-outlined">cycle</span>
                                    </button>
                                </span>
                            </div>
                        }
                    </div>
                } @else {
                    <p class="cache-reset-empty">No ready maps are currently configured.</p>
                }
            }
        </app-dialog>
    `,
    styles: [`
        .cache-reset-description,
        .cache-reset-unavailable,
        .cache-reset-empty {
            margin: 0 0 1rem;
        }

        .cache-reset-unavailable {
            color: var(--p-text-muted-color);
        }

        .cache-reset-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .cache-reset-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: center;
            gap: 1rem;
            min-height: 2.5rem;
            padding: 0.375rem 0.5rem;
            border: 1px solid var(--p-content-border-color);
            border-radius: var(--p-border-radius-md);
        }

        .cache-reset-map-id {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .cache-reset-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.25rem;
            height: 2.25rem;
            padding: 0;
            color: var(--p-primary-color);
            background: transparent;
            border: 1px solid var(--p-primary-color);
            border-radius: var(--p-border-radius-md);
            cursor: pointer;
        }

        .cache-reset-button:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
    `],
    standalone: true,
    imports: [AppDialogComponent, AsyncPipe, TooltipModule]
})
/** Lists caller-visible primary maps and runs one guarded reset at a time per row. */
export class CacheResetComponent {
    readonly dialogLayoutId = CACHE_RESET_DIALOG_LAYOUT_ID;
    readonly mapIds$: Observable<string[]> = this.mapInfo.maps$.pipe(
        map(tree => [...tree.maps.values()]
            .filter(node =>
                isDataSourceCatalogEntryReady(node.info) &&
                !node.info.addOn)
            .map(node => node.id))
    );
    private readonly pendingMapIds = new Set<string>();

    constructor(
        private readonly mapInfo: MapInfoService,
        private readonly cacheReset: CacheResetService,
        private readonly config: AppConfigService,
        private readonly messages: InfoMessageService,
        private readonly state: AppStateService
    ) {}

    get enabled(): boolean {
        return this.config.snapshot.serverConfig.cacheReset;
    }

    get dialogVisible(): boolean {
        return this.state.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.state.setDialogOpen(this.dialogLayoutId, visible);
    }

    isPending(mapId: string): boolean {
        return this.pendingMapIds.has(mapId);
    }

    tooltip(mapId: string): string {
        if (!this.enabled) {
            return `Cache reset is unavailable for ${mapId}`;
        }
        if (this.isPending(mapId)) {
            return `Resetting tile cache for ${mapId}`;
        }
        return `Reset tile cache for ${mapId}`;
    }

    /** Resets one row without allowing duplicate requests or trusting the presentation capability as authorization. */
    async reset(mapId: string): Promise<void> {
        if (!this.enabled || this.pendingMapIds.has(mapId)) {
            return;
        }
        this.pendingMapIds.add(mapId);
        try {
            await this.cacheReset.reset(mapId);
            this.messages.showSuccess(`Tile cache reset for “${mapId}”.`);
        } catch (error) {
            this.messages.showError(this.resetErrorMessage(mapId, error));
        } finally {
            this.pendingMapIds.delete(mapId);
        }
    }

    private resetErrorMessage(mapId: string, error: unknown): string {
        if (error instanceof HttpErrorResponse) {
            if (error.status === 403) {
                return "Cache reset is no longer available for this session.";
            }
            if (error.status === 404) {
                return `Map “${mapId}” is no longer available for cache reset.`;
            }
        }
        return `Could not reset the tile cache for “${mapId}”.`;
    }
}
