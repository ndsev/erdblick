import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {coreLib, uint8ArrayToWasmOrThrow} from "../../../app/integrations/wasm.adapter";

/**
 * The native mapget generator writes this fixture. Run generate-shape-point-fixture
 * with tests/fixtures/shape-points as its output directory after a wire format change.
 * A restricted /tiles response has one feature, while the original snapshot has two.
 */
const fixture = (file: string) => readFileSync(join("tests", "fixtures", "shape-points", file));
interface InspectionRow {
    key: string | number;
    value: unknown;
    nodeId?: string;
    sourceNodeId?: string;
    children?: InspectionRow[];
}

function child(parent: InspectionRow | InspectionRow[], key: string | number): InspectionRow {
    const row = (Array.isArray(parent) ? parent : parent.children)?.find(item => item.key === key);
    if (row === undefined) throw new Error(`Missing inspection row ${key}`);
    return row;
}

describe("native shape-point streams in the browser WASM", () => {
    it("decodes the exact lane row and finds its original curvature record through the restricted feature", () => {
        const expected = JSON.parse(fixture("expected.json").toString());
        const parser = new coreLib.TileLayerParser();
        try {
            uint8ArrayToWasmOrThrow(data => parser.installMapSchema(data, expected.schemaId), fixture("schema.bin"));
            uint8ArrayToWasmOrThrow(data => parser.setDataSourceInfo(data), fixture("catalog.json"));
            uint8ArrayToWasmOrThrow(data => parser.readFieldDictUpdate(data), fixture("dictionary.frame"));
            const subset = uint8ArrayToWasmOrThrow(data => parser.readTileSubsetLayer(data), fixture("subset.bin"));
            try {
                expect(JSON.parse(subset.toJson()).channels[0].shapePointEntries).toEqual([expected.row]);
                const hit = subset.resolvePick(expected.channelOrdinal, expected.entryOrdinal, 0);
                const {featureId, geometryOrdinal, pointIndex} = expected.row;
                expect(hit).toMatchObject({scope: "shapepoint", featureId, geometryOrdinal, pointIndex,
                    sourceId: expected.sourceId});
                expect(subset.findShapePointPickReferences(featureId, geometryOrdinal, pointIndex,
                    expected.sourceId)).toHaveLength(1);
                expect(subset.findShapePointPickReferences(featureId, 0, pointIndex,
                    expected.sourceId)).toEqual([]);
                expect(subset.findShapePointPickReferences(featureId, geometryOrdinal, pointIndex,
                    "other-source")).toEqual([]);
                for (const [file, count] of [["source.bin", 2], ["selected.bin", 1]] as const) {
                    const bytes = fixture(file);
                    const meta = uint8ArrayToWasmOrThrow(data => parser.readTileLayerMetadata(data), bytes);
                    expect(meta).toMatchObject({numFeatures: count, sourceId: expected.sourceId});
                    const tile = uint8ArrayToWasmOrThrow(data => parser.readTileFeatureLayer(data), bytes);
                    try {
                        const feature = tile.find(featureId);
                        try {
                            const tree = feature.inspectionModelAtShapePoint(geometryOrdinal, pointIndex, hit.sourceId);
                            const vertex = child(child(child(tree, "Geometry"), geometryOrdinal), pointIndex);
                            const occurrence = child(child(vertex, "Point attributes"), `${expected.attributeLayer}.${expected.attribute}`);
                            const sample = child(child(child(occurrence, "Measurements"), "curvature"), 0);
                            expect(child(sample, "value").value).toBeCloseTo(expected.row.values[0][0], 9);
                            expect(child(sample, "unit").value).toBe(expected.unit);
                            const record = child(child(sample, "contributors"), 0);
                            expect(child(record, "raw").value).toBe(expected.raw);
                            const raw = child(child(child(tree, "Attribute Layers"), expected.attributeLayer), expected.attribute);
                            expect(record.sourceNodeId).toBe(expected.recordPath.reduce(child, raw).nodeId);
                            const missing = feature.inspectionModelAtShapePoint(geometryOrdinal, 0xffffffff, hit.sourceId);
                            expect(child(missing, "Shape point unavailable")).toBeDefined();
                            expect(feature.shapePointPosition(geometryOrdinal, 0xffffffff, hit.sourceId)).toBeFalsy();
                            expect(feature.shapePointPosition(geometryOrdinal, pointIndex, "other-source")).toBeFalsy();
                        } finally { feature.delete(); }
                    } finally { tile.delete(); }
                }
            } finally { subset.delete(); }
        } finally { parser.delete(); }
    });
});
