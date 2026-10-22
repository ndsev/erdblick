import {signalStore, signalStoreFeature, StateSource, type, withMethods} from "@ngrx/signals";
import {withEntities} from "@ngrx/signals/entities";
import {withViewerActions} from "../actions/viewer-actions.store-feature";
import {withViewerUiActions} from "../actions/viewer-ui-actions.store-feature";
import {withCoordinatesPolicy} from "../coords/coordinates-policy.store-feature";
import {withCoordinates} from "../coords/coordinates.store-feature";
import {withDiagnosticsState} from "../diagnostics/diagnostics.store-feature";
import {withDiagnosticsActions} from "../diagnostics/diagnostics-actions.store-feature";
import {withInspectionActions} from "../inspection/inspection-actions.store-feature";
import {withInspectionState} from "../inspection/inspection.store-feature";
import {withMapCatalogState} from "../mapdata/map-catalog.store-feature";
import {withMapLayerState} from "../mapdata/map-layer.store-feature";
import {withMapCatalogActions} from "../mapdata/map-info-actions.store-feature";
import {withMapTileStream} from "../mapdata/map-tile-stream.store-feature";
import {withMapViewState} from "../mapview/map-view.store-feature";
import {withMapViewActions} from "../mapview/map-view-actions.store-feature";
import type {ViewIdentity} from "../mapview/view-id";
import {withFeatureSearch} from "../search/feature-search.store-feature";
import {withFeatureSearchActions} from "../search/feature-search-actions.store-feature";
import {withNavigationActions} from "../search/navigation-actions.store-feature";
import {withLocationSearch} from "../search/location.search.store-feature";
import {withStyleEditorRequest} from "../styledata/style-editor-request.store-feature";
import {withStyle} from "../styledata/style.store-feature";
import {withStyleActions} from "../styledata/style-actions.store-feature";
import {withAppActions} from "./app-actions.store-feature";
import {withAppConfig} from "./app-config.store-feature";
import {withAppLayout} from "./app-layout.store-feature";
import {patchAppState, StateWriteOrigin, withStateProvenance} from "./persisted-state";

// Infer this independent group before root overload resolution inspects later
// feature requirements (for example rendering preferences also use connection).
function withPreferences() {
    return signalStoreFeature(
        withStyle(),
        withMapTileStream(),
        withCoordinates(),
        withCoordinatesPolicy(),
        withLocationSearch(),
        withStyleEditorRequest(),
        withAppConfig(),
        withDiagnosticsState()
    );
}

/**
 * The injected application value owner. Features declare their native state,
 * semantic operations and persistence/action metadata together. Resource engines
 * initialize explicitly after config/WASM/persistence, so constructing this same
 * feature graph in Node can inspect the external contract without starting a viewer.
 */
export const AppStore = signalStore(
    {providedIn: "root"},
    withStateProvenance(),
    withEntities<ViewIdentity, "view">({entity: type<ViewIdentity>(), collection: "view"}),
    withAppLayout(),
    withMapLayerState(),
    withPreferences(),
    withInspectionState(),
    withFeatureSearch(),
    withMapViewState(),
    withMapCatalogState(),
    withMethods(store => {
        type Values = typeof store extends StateSource<infer Value> ? Value : never;
        return {
            /**
             * Persistence has already decoded and normalized every domain before
             * reaching this integration boundary. Publish its complete candidate
             * once, so no component sees a new view order with old layer records.
             */
            restorePersistedState(next: Values, origin: StateWriteOrigin): void {
                patchAppState(store, next, origin);
            }
        };
    }),
    signalStoreFeature(
        withMapCatalogActions(),
        withMapViewActions(),
        withInspectionActions(),
        withFeatureSearchActions(),
        withStyleActions(),
        withNavigationActions(),
        withDiagnosticsActions(),
        withViewerUiActions(),
        withAppActions()
    ),
    withViewerActions()
);
export type AppStore = InstanceType<typeof AppStore>;
export type AppStoreValues = AppStore extends StateSource<infer Values> ? Values : never;
