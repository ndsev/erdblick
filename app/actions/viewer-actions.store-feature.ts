import {signalStoreFeature, withProps} from "@ngrx/signals";
import {ActionCatalog} from "./app-action";

/**
 * Compose this last, after domain state and operation features. The catalog sees
 * their annotated methods and explicit controls directly; no service registers
 * a second list of names or handlers. Constructing it is safe during the Node
 * build export because discovery does not invoke methods or suggestion providers.
 */
export function withViewerActions() {
    return signalStoreFeature(withProps(store => ({actionCatalog: new ActionCatalog(store)})));
}
