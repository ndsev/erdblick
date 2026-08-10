import {Injectable} from "@angular/core";
import {Observable} from "rxjs";
import {map} from "rxjs/operators";

import {AppStateService} from "../shared/appstate.service";
import {FeatureSearchStyleRule} from "../shared/feature-search-state";
import {
    createSearchStyleConfigurationId,
    detachSearchStyleRules,
    MAX_SEARCH_STYLE_CONFIGURATIONS,
    MAX_SEARCH_STYLE_CONFIGURATION_NAME_LENGTH,
    normalizeSearchStyleConfigurationName,
    searchStyleConfigurationStateFits,
    SearchStyleConfigurationV1
} from "../shared/search-style-configuration-state";

/** CRUD boundary for reusable high-fidelity search-style configurations. */
@Injectable({providedIn: "root"})
export class SearchStyleConfigurationService {
    readonly configurations$: Observable<SearchStyleConfigurationV1[]> =
        this.stateService.searchStyleConfigurationsState.pipe(
            map(state => state.configurations.map(configuration =>
                this.detachConfiguration(configuration)))
        );

    constructor(private readonly stateService: AppStateService) {
    }

    /** Returns a detached snapshot of all saved configurations. */
    list(): SearchStyleConfigurationV1[] {
        return this.stateService.searchStyleConfigurations.configurations
            .map(configuration => this.detachConfiguration(configuration));
    }

    /** Returns one detached configuration snapshot. */
    get(id: string): SearchStyleConfigurationV1 | undefined {
        const configuration = this.stateService.searchStyleConfigurations.configurations
            .find(item => item.id === id);
        return configuration ? this.detachConfiguration(configuration) : undefined;
    }

    /** Saves a new reusable configuration containing only high-fidelity style rules. */
    create(name: string, rules: readonly FeatureSearchStyleRule[]): SearchStyleConfigurationV1 | undefined {
        const current = this.stateService.searchStyleConfigurations;
        if (current.configurations.length >= MAX_SEARCH_STYLE_CONFIGURATIONS) {
            return undefined;
        }
        const now = new Date().toISOString();
        const configuration: SearchStyleConfigurationV1 = {
            id: createSearchStyleConfigurationId(),
            revision: 1,
            name: this.uniqueName(normalizeSearchStyleConfigurationName(name)),
            rules: detachSearchStyleRules(rules),
            createdAt: now,
            updatedAt: now
        };
        const configurations = [...current.configurations, configuration];
        if (!searchStyleConfigurationStateFits(configurations)) {
            return undefined;
        }
        this.stateService.searchStyleConfigurations = {...current, configurations};
        return this.detachConfiguration(configuration);
    }

    /** Replaces a configuration's detached rules and optionally its display name. */
    update(
        id: string,
        rules: readonly FeatureSearchStyleRule[],
        name?: string
    ): SearchStyleConfigurationV1 | undefined {
        const current = this.stateService.searchStyleConfigurations;
        let updated: SearchStyleConfigurationV1 | undefined;
        const configurations = current.configurations.map(configuration => {
            if (configuration.id !== id) {
                return configuration;
            }
            updated = {
                ...configuration,
                revision: configuration.revision + 1,
                name: name === undefined
                    ? configuration.name
                    : this.uniqueName(normalizeSearchStyleConfigurationName(name), id),
                rules: detachSearchStyleRules(rules),
                updatedAt: new Date().toISOString()
            };
            return updated;
        });
        if (!updated) {
            return undefined;
        }
        if (!searchStyleConfigurationStateFits(configurations)) {
            return undefined;
        }
        this.stateService.searchStyleConfigurations = {...current, configurations};
        return this.detachConfiguration(updated);
    }

    /** Renames one configuration without changing its rule payload. */
    rename(id: string, name: string): SearchStyleConfigurationV1 | undefined {
        const existing = this.get(id);
        return existing ? this.update(id, existing.rules, name) : undefined;
    }

    /** Creates an independent copy of an existing configuration. */
    duplicate(id: string): SearchStyleConfigurationV1 | undefined {
        const existing = this.get(id);
        return existing
            ? this.create(`${existing.name} Copy`, existing.rules)
            : undefined;
    }

    /** Deletes one saved configuration while leaving applied search copies untouched. */
    remove(id: string): boolean {
        const current = this.stateService.searchStyleConfigurations;
        const configurations = current.configurations.filter(configuration => configuration.id !== id);
        if (configurations.length === current.configurations.length) {
            return false;
        }
        this.stateService.searchStyleConfigurations = {...current, configurations};
        return true;
    }

    /** Applies a configuration to a feature search as a detached rule copy. */
    applyToFeatureSearch(configurationId: string, featureSearchId: string): boolean {
        const configuration = this.get(configurationId);
        if (!configuration) {
            return false;
        }
        return !!this.stateService.patchFeatureSearch(featureSearchId, {
            searchStyleRules: detachSearchStyleRules(configuration.rules),
            searchStyleConfigurationId: configuration.id,
            searchStyleConfigurationRevision: configuration.revision
        });
    }

    /** Returns a case-insensitively unique name for the current collection. */
    private uniqueName(requested: string, excludedId?: string): string {
        const names = new Set(this.stateService.searchStyleConfigurations.configurations
            .filter(configuration => configuration.id !== excludedId)
            .map(configuration => configuration.name.toLocaleLowerCase()));
        if (!names.has(requested.toLocaleLowerCase())) {
            return requested;
        }
        let suffix = 2;
        while (names.has(this.nameWithSuffix(requested, suffix).toLocaleLowerCase())) {
            suffix += 1;
        }
        return this.nameWithSuffix(requested, suffix);
    }

    /** Appends a collision suffix without exceeding the persisted name limit. */
    private nameWithSuffix(requested: string, suffix: number): string {
        const ending = ` ${suffix}`;
        return `${requested.slice(0, MAX_SEARCH_STYLE_CONFIGURATION_NAME_LENGTH - ending.length)}${ending}`;
    }

    /** Deep-copies one configuration through the canonical rule normalizer. */
    private detachConfiguration(configuration: SearchStyleConfigurationV1): SearchStyleConfigurationV1 {
        return {
            ...configuration,
            rules: detachSearchStyleRules(configuration.rules)
        };
    }
}
