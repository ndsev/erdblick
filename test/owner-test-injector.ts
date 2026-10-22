import "@angular/compiler";
import {Injector, DestroyableInjector, Provider} from "@angular/core";
import {Router} from "@angular/router";
import {Subject} from "rxjs";
import {afterEach} from "vitest";
import {getState} from "@ngrx/signals";
import {AppStore} from "../app/shared/app.store";
import {prepareViewMembership} from "../app/mapview/map-view.store-feature";
import {persistenceDescriptors} from "../app/shared/persisted-state";
import {AppUrlStateService} from "../app/shared/app-url-state.service";
import {AppStateService} from "../app/shared/appstate.service";
import {InfoMessageService} from "../app/shared/info.service";

const injectors: DestroyableInjector[] = [];

/** Real SignalStore and persistence for a focused owner test; collaborators stay explicit at the call site. */
export function ownerTestInjector(providers: Provider[] = [], parent?: Injector): DestroyableInjector {
    const injector = Injector.create({parent, providers: [
        AppStateService, AppUrlStateService, AppStore,
        {provide: Router, useValue: {events: new Subject(), navigate: async () => true,
            getCurrentNavigation: () => undefined, routerState: {snapshot: {root: {queryParams: {}}}}}},
        {provide: InfoMessageService, useValue: {showError() {}, showSuccess() {}, showWarning() {}}},
        ...providers
    ]});
    injector.get(AppStore).initializeViews();
    injectors.push(injector);
    return injector;
}

afterEach(() => injectors.splice(0).forEach(injector => injector.destroy()));

/** Choose stable logical IDs for lifetime tests without adding a production mutation API. */
export function setTestViewIds(store: AppStore, ids: string[]): void {
    const next = prepareViewMembership(getState(store), ids, persistenceDescriptors(store));
    store.restorePersistedState(next, "hydration");
}
