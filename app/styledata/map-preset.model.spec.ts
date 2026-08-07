import {describe, expect, it} from "vitest";
import {
    MAP_PRESET_APP_STATE_SCHEMA,
    parseMapPresetDefinitions
} from "./map-preset.model";

describe("parseMapPresetDefinitions", () => {
    it("accepts a map-agnostic composition of qualified layer presets", () => {
        const result = parseMapPresetDefinitions([{
            id: "network",
            name: "Network",
            layerPresets: [
                {layerId: "Lane", styleId: "Lanes", presetId: "topology"},
                {layerId: "Road", styleId: "Roads", presetId: "geometry"}
            ]
        }]);

        expect(result.issues).toEqual([]);
        expect(result.presets[0]).toMatchObject({id: "network", enabled: true});
    });

    it("rejects duplicate layer targets while preserving independent valid siblings", () => {
        const result = parseMapPresetDefinitions([
            {
                id: "invalid",
                name: "Invalid",
                layerPresets: [
                    {layerId: "Lane", styleId: "Lanes", presetId: "one"},
                    {layerId: "Lane", styleId: "Lanes", presetId: "two"}
                ]
            },
            {
                id: "valid",
                name: "Valid",
                enabled: false,
                layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
            }
        ]);

        expect(result.presets.map(preset => preset.id)).toEqual(["valid"]);
        expect(result.issues).toHaveLength(1);
    });

    it("normalizes the complete catalog at the AppState schema boundary", () => {
        const presets = MAP_PRESET_APP_STATE_SCHEMA.parse([
            {id: "invalid"},
            {
                id: "valid",
                name: "Valid",
                layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
            }
        ]);

        expect(presets).toEqual([{
            id: "valid",
            name: "Valid",
            enabled: true,
            layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
        }]);
    });
});
