import {Injectable} from "@angular/core";
import {Observable} from "rxjs";
import {Feature} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "../mapdata/features.model";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {InspectionPanelModel} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {displayFeatureId, stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {InspectionSelectionService} from "./inspection-selection.service";

/** One feature that can be exported as GeoJSON from the main File menu. */
export interface InspectionGeoJsonExportItem {
    key: string;
    label: string;
    tooltip: string;
    panelId: string;
    featureId: string;
    disabled: boolean;
    feature: FeatureWrapper;
}

/** Provides menu-ready GeoJSON exports for the currently inspected features. */
@Injectable({providedIn: "root"})
export class InspectionExportService {
    readonly exportItemsChanged: Observable<InspectionPanelModel<FeatureWrapper>[]>;

    constructor(
        private readonly inspectionSelection: InspectionSelectionService,
        private readonly mapService: MapTileStreamService,
        private readonly messageService: InfoMessageService
    ) {
        this.exportItemsChanged = this.inspectionSelection.selectionTopic.asObservable();
    }

    /** Returns one export option per currently inspected feature. */
    geoJsonExportItems(): InspectionGeoJsonExportItem[] {
        return this.inspectionSelection.selectionTopic.getValue().flatMap(panel =>
            panel.features.map((feature, index) => this.geoJsonExportItem(panel, feature, index))
        );
    }

    /** Downloads one inspected feature as a GeoJSON FeatureCollection. */
    downloadFeatureGeoJson(item: InspectionGeoJsonExportItem): boolean {
        if (!this.mapService.isTileInspectionDataComplete(item.feature.featureTile)) {
            this.messageService.showWarning("Inspection data is still loading for this feature.");
            return false;
        }

        try {
            const featureJson = item.feature.peek((feature: Feature) => feature.geojson() as string);
            if (typeof featureJson !== "string" || !featureJson.length) {
                this.messageService.showError("GeoJSON data is not available for this feature.");
                return false;
            }
            const payload = `{"type":"FeatureCollection","features":[${featureJson}]}`;
            this.downloadTextFile(payload, this.geoJsonFilename(item), "application/geo+json");
            this.messageService.showSuccess("GeoJSON download started");
            return true;
        } catch (error) {
            console.error("Failed to export inspected feature as GeoJSON.", {
                panelId: item.panelId,
                mapTileKey: item.feature.mapTileKey,
                featureId: item.featureId,
                error
            });
            this.messageService.showError("Could not export GeoJSON for this feature.");
            return false;
        }
    }

    /** Builds the stable menu item descriptor for one inspected feature. */
    private geoJsonExportItem(
        panel: InspectionPanelModel<FeatureWrapper>,
        feature: FeatureWrapper,
        index: number
    ): InspectionGeoJsonExportItem {
        const displayId = displayFeatureId(feature.featureId);
        const panelId = String(panel.id);
        return {
            key: `${panelId}:${index}:${feature.mapTileKey}:${feature.featureId}`,
            label: displayId,
            tooltip: `${displayId} (${panelId})`,
            panelId,
            featureId: feature.featureId,
            disabled: !this.mapService.isTileInspectionDataComplete(feature.featureTile),
            feature
        };
    }

    /** Creates a browser download for generated text payloads. */
    private downloadTextFile(data: string, filename: string, mimeType: string): void {
        const blob = new Blob([data], {type: mimeType});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /** Returns a filesystem-safe GeoJSON export filename. */
    private geoJsonFilename(item: InspectionGeoJsonExportItem): string {
        const panelId = this.safeFilenamePart(item.panelId);
        const featureId = this.safeFilenamePart(stripFeatureInspectionTarget(item.featureId));
        return `inspection-${panelId}-${featureId}.geojson`;
    }

    /** Converts an arbitrary identifier into a compact filename component. */
    private safeFilenamePart(value: string): string {
        const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
        return (normalized || "feature").slice(0, 80);
    }
}
