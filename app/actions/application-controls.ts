import {composeDeclarations} from "./app-action.js";
import {mapViewControls} from "../mapview/map-view.service.declarations.js";
import {viewSettingsControls} from "../mapview/map-view-state.service.declarations.js";
import {mapControls} from "../mapdata/map-info.service.declarations.js";
import {inspectionControls} from "../inspection/inspection-selection.service.declarations.js";
import {inspectionStateControls} from "../inspection/inspection-state.service.declarations.js";
import {searchControls} from "../search/feature.search.service.declarations.js";
import {coordinateControls} from "../coords/coordinates.service.declarations.js";
import {renderControls} from "../mapview/render-preferences.service.declarations.js";
import {connectionControls} from "../mapdata/connection-preferences.service.declarations.js";

/** Build composition only. Domain schemas and runtime bindings remain at their owners. */
export const applicationControls = composeDeclarations(
    mapViewControls, viewSettingsControls, mapControls, inspectionControls,
    inspectionStateControls, searchControls, coordinateControls, renderControls, connectionControls
);
