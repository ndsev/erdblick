import { composeDeclarations } from "../app/actions/app-action";
import { coordinateControls } from "../app/coords/coordinates.service";
import { inspectionStateControls } from "../app/inspection/inspection-panel.service";
import { inspectionControls } from "../app/inspection/inspection-selection.service";
import { connectionControls } from "../app/mapdata/connection-preferences.service";
import { mapControls } from "../app/mapdata/map-info.service";
import { mapViewControls, viewSettingsControls } from "../app/mapview/map-view.service";
import { renderControls } from "../app/mapview/render-preferences.service";
import { searchControls } from "../app/search/feature.search.service";

/** Explicit test inventory used to detect accidental public-contract changes. */
export const applicationControls = composeDeclarations(
    mapViewControls, viewSettingsControls, mapControls, inspectionControls,
    inspectionStateControls, searchControls, coordinateControls, renderControls, connectionControls
);
