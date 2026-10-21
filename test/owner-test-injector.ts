import "@angular/compiler";
import {Injector, DestroyableInjector, Provider} from "@angular/core";
import {Router} from "@angular/router";
import {Subject} from "rxjs";
import {afterEach} from "vitest";
import {AppActionService} from "../app/actions/app-action.service";
import {AppStateService} from "../app/shared/appstate.service";
import {InfoMessageService} from "../app/shared/info.service";

const injectors: DestroyableInjector[] = [];

/** Real SignalStore and persistence for a focused owner test; collaborators stay explicit at the call site. */
export function ownerTestInjector(providers: Provider[] = []): DestroyableInjector {
    const injector = Injector.create({providers: [
        AppStateService, AppActionService,
        {provide: Router, useValue: {events: new Subject(), navigate: async () => true,
            getCurrentNavigation: () => undefined, routerState: {snapshot: {root: {queryParams: {}}}}}},
        {provide: InfoMessageService, useValue: {showError() {}, showSuccess() {}, showWarning() {}}},
        ...providers
    ]});
    injectors.push(injector);
    return injector;
}

afterEach(() => injectors.splice(0).forEach(injector => injector.destroy()));
