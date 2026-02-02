import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';
import {MapDataService} from '../mapdata/map.service';
import {InspectionPanelModel, TileFeatureId} from '../shared/appstate.service';
import {FeatureWrapper} from '../mapdata/features.model';

export interface InspectionComparisonEntry {
    panelId: number;
    label: string;
    featureIds: TileFeatureId[];
    featureWrappers?: FeatureWrapper[];
}

export interface InspectionComparisonModel {
    id: number;
    base: InspectionComparisonEntry;
    others: InspectionComparisonEntry[];
}

export interface InspectionComparisonOption {
    label: string;
    value: number;
}

@Injectable({providedIn: 'root'})
export class InspectionComparisonService {
    private nextId = 1;
    isComparisonVisible: boolean = false;
    comparisons = new BehaviorSubject<InspectionComparisonModel[]>([]);

    constructor(private mapService: MapDataService) {}

    openComparison(basePanelId: number, otherPanelIds: number[]) {
        const panels = this.panelMap();
        const basePanel = panels.get(basePanelId);
        if (!basePanel || basePanel.features.length === 0 || basePanel.sourceData !== undefined) {
            return;
        }
        const baseEntry = this.createEntryFromPanel(basePanel);
        const normalizedOtherIds = this.normalizeOtherPanelIds(basePanelId, otherPanelIds);
        const otherEntries = normalizedOtherIds
            .map(id => panels.get(id))
            .filter((panel): panel is InspectionPanelModel<FeatureWrapper> => !!panel)
            .map(panel => this.createEntryFromPanel(panel));
        const existing = this.comparisons.getValue()[0];
        const id = existing?.id ?? this.nextId++;
        this.comparisons.next([{
            id,
            base: baseEntry,
            others: otherEntries
        }]);
        this.isComparisonVisible = true;
    }

    closeComparison() {
        this.comparisons.next([]);
    }

    updateComparisonSelections(id: number, otherPanelIds: number[]) {
        const comparisons = this.comparisons.getValue();
        const index = comparisons.findIndex(comp => comp.id === id);
        if (index === -1) {
            return;
        }
        const comparison = comparisons[index];
        const panels = this.panelMap();
        const normalizedOtherIds = this.normalizeOtherPanelIds(comparison.base.panelId, otherPanelIds);
        const nextOthers: InspectionComparisonEntry[] = [];
        for (const panelId of normalizedOtherIds) {
            const existing = comparison.others.find(entry => entry.panelId === panelId);
            if (existing) {
                nextOthers.push(existing);
                continue;
            }
            const panel = panels.get(panelId);
            if (!panel || panel.features.length === 0 || panel.sourceData !== undefined) {
                continue;
            }
            nextOthers.push(this.createEntryFromPanel(panel));
        }
        comparisons[index] = {
            ...comparison,
            others: nextOthers
        };
        this.comparisons.next(comparisons.slice());
    }

    updateComparisonPanels(id: number, panelIds: number[]) {
        const comparisons = this.comparisons.getValue();
        const index = comparisons.findIndex(comp => comp.id === id);
        if (index === -1) {
            return;
        }
        const comparison = comparisons[index];
        const panels = this.panelMap();
        const entryMap = new Map<number, InspectionComparisonEntry>();
        entryMap.set(comparison.base.panelId, comparison.base);
        comparison.others.forEach(entry => entryMap.set(entry.panelId, entry));

        let selected = Array.from(new Set(panelIds))
            .filter(panelId => entryMap.has(panelId) || this.isFeaturePanel(panels.get(panelId)));
        if (selected.length === 0) {
            selected = [comparison.base.panelId];
        }
        const basePanelId = selected.includes(comparison.base.panelId)
            ? comparison.base.panelId
            : selected[0];
        const ordered = [basePanelId, ...selected.filter(idValue => idValue !== basePanelId)].slice(0, 4);

        const baseEntry = this.entryForPanelId(basePanelId, entryMap, panels);
        if (!baseEntry) {
            return;
        }
        const otherEntries: InspectionComparisonEntry[] = [];
        for (const panelId of ordered.slice(1)) {
            const entry = this.entryForPanelId(panelId, entryMap, panels);
            if (entry) {
                otherEntries.push(entry);
            }
        }
        comparisons[index] = {
            ...comparison,
            base: baseEntry,
            others: otherEntries
        };
        this.comparisons.next(comparisons.slice());
    }

    buildCompareOptions(excludePanelId?: number): InspectionComparisonOption[] {
        return this.mapService.selectionTopic.getValue()
            .filter(panel => excludePanelId === undefined || panel.id !== excludePanelId)
            .filter(panel => panel.features.length > 0 && panel.sourceData === undefined)
            .map(panel => ({
                label: this.formatFeatureLabel(panel.features),
                value: panel.id
            }));
    }

    formatFeatureLabel(features: FeatureWrapper[]): string {
        return features.map(feature => `${feature.featureTile.mapName}.${feature.featureId}`).join(', ');
    }

    private normalizeOtherPanelIds(basePanelId: number, otherPanelIds: number[]): number[] {
        const unique = Array.from(new Set(otherPanelIds))
            .filter(id => id !== basePanelId);
        return unique.slice(0, 3);
    }

    private createEntryFromPanel(panel: InspectionPanelModel<FeatureWrapper>): InspectionComparisonEntry {
        return {
            panelId: panel.id,
            label: this.formatFeatureLabel(panel.features),
            featureIds: panel.features.map(feature => ({
                mapTileKey: feature.mapTileKey,
                featureId: feature.featureId
            })),
            featureWrappers: panel.features.slice()
        };
    }

    private entryForPanelId(panelId: number,
                            entryMap: Map<number, InspectionComparisonEntry>,
                            panels: Map<number, InspectionPanelModel<FeatureWrapper>>): InspectionComparisonEntry | undefined {
        const existing = entryMap.get(panelId);
        if (existing) {
            return existing;
        }
        const panel = panels.get(panelId);
        if (!this.isFeaturePanel(panel)) {
            return;
        }
        if (panel !== undefined) {
            return this.createEntryFromPanel(panel);
        }
        return;
    }

    private isFeaturePanel(panel: InspectionPanelModel<FeatureWrapper> | undefined): boolean {
        return !!panel && panel.features.length > 0 && panel.sourceData === undefined;
    }

    private panelMap(): Map<number, InspectionPanelModel<FeatureWrapper>> {
        return new Map(this.mapService.selectionTopic.getValue().map(panel => [panel.id, panel]));
    }
}
