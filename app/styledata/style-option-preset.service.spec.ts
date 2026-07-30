import "@angular/compiler";
import {HttpClient} from "@angular/common/http";
import {BehaviorSubject, firstValueFrom, of} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {AppConfigService} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";
import {
    FeatureStyleOptionWithStringType,
    StyleService
} from "./style.service";
import {
    parseStyleOptionPresetSource,
    StyleOptionPresetService,
    StyleOptionPresetStyleMetadata
} from "./style-option-preset.service";

/** Creates one style option accepted by the preset resolver. */
function option(
    id: string,
    type = "Bool",
    internal = false
): FeatureStyleOptionWithStringType {
    return {
        id,
        label: id,
        description: id,
        type,
        defaultValue: false,
        internal
    };
}

/** Creates the style metadata used by parser and service tests. */
function styles(): Map<string, StyleOptionPresetStyleMetadata> {
    return new Map([
        ["Example/Style", {
            options: [
                option("visible"),
                option("internal", "Bool", true),
                option("width", "Number")
            ],
            featureLayerStyle: {
                hasLayerAffinity: (layerId: string) => layerId === "Example"
            }
        }]
    ] as unknown as Array<[string, StyleOptionPresetStyleMetadata]>);
}

/** Builds one minimal valid preset document with an overridable identity. */
function validSource(id = "example", name = "Example"): string {
    return `
version: 1
presets:
  - id: ${id}
    name: ${name}
    layerAffinity: "^Example$"
    values:
      - styleId: Example/Style
        optionId: visible
        value: true
`;
}

describe("parseStyleOptionPresetSource", () => {
    it("parses and normalizes a valid document", () => {
        const result = parseStyleOptionPresetSource(validSource(), styles());

        expect(result.issues).toEqual([]);
        expect(result.document.presets).toEqual([{
            id: "example",
            name: "Example",
            enabled: true,
            layerAffinity: "^Example$",
            values: [{
                styleId: "Example/Style",
                optionId: "visible",
                value: true
            }]
        }]);
    });

    it("rejects unsupported versions and malformed YAML without throwing", () => {
        const unsupported = parseStyleOptionPresetSource(
            "version: 2\npresets: []\n",
            styles());
        const malformed = parseStyleOptionPresetSource("version: [", styles());

        expect(unsupported.document.presets).toEqual([]);
        expect(unsupported.issues[0].message).toContain("Unsupported");
        expect(malformed.document.presets).toEqual([]);
        expect(malformed.issues).toHaveLength(1);
    });

    it("keeps independent valid entries while excluding duplicate definitions", () => {
        const result = parseStyleOptionPresetSource(`
version: 1
presets:
  - id: first
    name: First
    values:
      - {styleId: Example/Style, optionId: visible, value: true}
  - id: first
    name: Duplicate ID
    values:
      - {styleId: Example/Style, optionId: visible, value: false}
  - id: duplicate-name
    name: First
    values:
      - {styleId: Example/Style, optionId: visible, value: false}
  - id: last
    name: Last
    values:
      - {styleId: Example/Style, optionId: visible, value: false}
`, styles());

        expect(result.document.presets.map(preset => preset.id)).toEqual(["first", "last"]);
        expect(result.issues.map(issue => issue.message)).toEqual([
            "Duplicate preset id 'first'.",
            "Duplicate preset name 'First'."
        ]);
    });

    it.each([
        [
            "invalid affinity",
            "layerAffinity: \"[\"\n    values:\n      - {styleId: Example/Style, optionId: visible, value: true}",
            "Invalid layer affinity"
        ],
        [
            "unknown style",
            "values:\n      - {styleId: Missing, optionId: visible, value: true}",
            "Unknown style"
        ],
        [
            "unknown option",
            "values:\n      - {styleId: Example/Style, optionId: missing, value: true}",
            "Unknown option"
        ],
        [
            "internal option",
            "values:\n      - {styleId: Example/Style, optionId: internal, value: true}",
            "not an editable Boolean"
        ],
        [
            "non-Boolean option",
            "values:\n      - {styleId: Example/Style, optionId: width, value: true}",
            "not an editable Boolean"
        ],
        [
            "duplicate option",
            "values:\n      - {styleId: Example/Style, optionId: visible, value: true}\n      - {styleId: Example/Style, optionId: visible, value: false}",
            "Duplicate option reference"
        ]
    ])("excludes a preset with an %s", (_label, body, expectedIssue) => {
        const result = parseStyleOptionPresetSource(`
version: 1
presets:
  - id: invalid
    name: Invalid
    ${body}
`, styles());

        expect(result.document.presets).toEqual([]);
        expect(result.issues.some(issue => issue.message.includes(expectedIssue))).toBe(true);
    });

    it.each([
        ["layer affinity", ["Other"], () => true],
        ["style affinity", ["Example"], () => false]
    ])("excludes a preset that cannot reach a known layer because of its %s", (
        _label,
        knownLayerIds,
        styleAppliesToLayer
    ) => {
        const result = parseStyleOptionPresetSource(
            validSource(),
            styles(),
            knownLayerIds,
            styleAppliesToLayer);

        expect(result.document.presets).toEqual([]);
        expect(result.issues).toEqual([{
            presetId: "example",
            message: "Preset affinity and style references do not apply to any known feature layer."
        }]);
    });
});

class PresetStateStub {
    readonly stylePresetAvailabilityState = new BehaviorSubject<Record<string, boolean>>({});
    stylePresetOverrideSource: string | null = null;

    /** Returns the current availability override map. */
    get stylePresetAvailability(): Record<string, boolean> {
        return this.stylePresetAvailabilityState.getValue();
    }

    /** Publishes a new availability override map. */
    set stylePresetAvailability(value: Record<string, boolean>) {
        this.stylePresetAvailabilityState.next(value);
    }
}

describe("StyleOptionPresetService", () => {
    /** Creates the service with small synchronous HTTP, config, state, and style doubles. */
    function createService(source: string) {
        const httpClient = {
            get: vi.fn(() => of(source))
        };
        const configService = {
            snapshot: {styleOptionPresets: "/presets.yaml"}
        };
        const stateService = new PresetStateStub();
        const styleService = {
            styles: styles(),
            styleGroups: new BehaviorSubject([])
        };
        const service = new StyleOptionPresetService(
            httpClient as unknown as HttpClient,
            configService as unknown as AppConfigService,
            stateService as unknown as AppStateService,
            styleService as unknown as StyleService);
        return {service, stateService};
    }

    it("keeps invalid raw Apply atomic and can reset a valid local override", async () => {
        const {service, stateService} = createService(validSource());
        await service.initialize();

        expect(service.presets.map(preset => preset.id)).toEqual(["example"]);
        expect(service.applyOverrideSource("version: [")).toBe(false);
        expect(service.presets.map(preset => preset.id)).toEqual(["example"]);
        expect(stateService.stylePresetOverrideSource).toBeNull();
        expect((await firstValueFrom(service.issues$)).length).toBeGreaterThan(0);
        service.restoreEffectiveIssues();
        expect(await firstValueFrom(service.issues$)).toEqual([]);

        expect(service.applyOverrideSource(validSource("local", "Local"))).toBe(true);
        expect(service.presets.map(preset => preset.id)).toEqual(["local"]);
        expect(stateService.stylePresetOverrideSource).toContain("id: local");

        service.resetToConfigured();

        expect(service.presets.map(preset => preset.id)).toEqual(["example"]);
        expect(stateService.stylePresetOverrideSource).toBeNull();
    });

    it("combines configured availability with minimal local overrides", async () => {
        const source = validSource().replace(
            "    layerAffinity:",
            "    enabled: false\n    layerAffinity:");
        const {service, stateService} = createService(source);
        await service.initialize();
        const preset = service.presets[0];

        expect(service.isAvailable(preset)).toBe(false);
        service.setAvailable(preset.id, true);
        expect(service.isAvailable(preset)).toBe(true);
        expect(stateService.stylePresetAvailability).toEqual({example: true});

        service.setAvailable(preset.id, false);
        expect(stateService.stylePresetAvailability).toEqual({});
    });

    it("offers a preset only when affinity and every option reference match the layer", async () => {
        const {service} = createService(validSource());
        await service.initialize();

        expect(service.presetsForLayer("Example", [
            {styleId: "Example/Style", id: "visible"}
        ]).map(preset => preset.id)).toEqual(["example"]);
        expect(service.presetsForLayer("Other", [
            {styleId: "Example/Style", id: "visible"}
        ])).toEqual([]);
        expect(service.presetsForLayer("Example", [])).toEqual([]);
    });

    it("revalidates presets when the concrete feature-layer catalog changes", async () => {
        const {service} = createService(validSource());
        await service.initialize();

        service.setKnownLayerIds(["Other"]);
        expect(service.presets).toEqual([]);

        service.setKnownLayerIds(["Example"]);
        expect(service.presets.map(preset => preset.id)).toEqual(["example"]);
    });
});
