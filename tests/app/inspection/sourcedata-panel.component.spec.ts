import {afterEach, describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {TreeTableNode} from "primeng/api";
import {SourceDataPanelComponent} from "../../../app/inspection/sourcedata-panel.component";
import {MapTileStreamClientTiles} from "../../../app/mapdata/map-tile-stream.client";
import {coreLib} from "../../../app/integrations/wasm.adapter";
import {
    expandSingleChildSourceDataPaths,
    sourceDataTreePresentation
} from "../../../app/inspection/sourcedata-tree.presentation";

describe("source-data inspection schema readiness", () => {
    afterEach(() => vi.restoreAllMocks());

    /** Exercise the loader without Angular's template; it still owns a real WASM parser. */
    function fixture() {
        const component = Object.create(SourceDataPanelComponent.prototype) as any;
        component.loadController = new AbortController();
        component.loadRevision = 0;
        const finishLoading = vi.fn();
        component.tileStream = {
            beginInspectionLoad: () => finishLoading,
            cancelRetainedTileExpiries: vi.fn()
        };
        const mapTileKey = coreLib.getSourceDataLayerKey("Map", "Source", Number(coreLib.getTileIdFromPosition(10, 48, 13)));
        return {component, mapTileKey, finishLoading};
    }

    it("installs the ready map's schema in its private parser before decoding source data", async () => {
        const {component, mapTileKey} = fixture();
        let ready!: () => void;
        component.mapService = {
            dataSourceInfoChanged: new Subject<readonly string[]>(),
            waitForMapLayersReady: () => new Promise<void>(resolve => {ready = resolve;}),
            getSchemaArtifacts: () => [{schemaId: "source-schema", bytes: new Uint8Array([1])}],
            getDataSourceInfoJson: () => "source metadata"
        };
        const install = vi.spyOn((coreLib.TileLayerParser as any).prototype, "installMapSchema")
            .mockImplementation(() => {});
        const register = vi.spyOn(MapTileStreamClientTiles.prototype, "setDataSourceInfoJson")
            .mockImplementation(function (this: MapTileStreamClientTiles) {
                expect(install).toHaveBeenCalledWith(expect.anything(), "source-schema");
                return this;
            });
        const layer = {getError: () => "", delete: vi.fn()};
        let parser: any;
        const request = vi.spyOn(MapTileStreamClientTiles.prototype, "request")
            .mockImplementation(async function (this: MapTileStreamClientTiles) {
                expect(register).toHaveBeenCalledWith("source metadata");
                parser = this.parser;
                vi.spyOn(parser, "readTileLayerMetadata").mockReturnValue({});
                vi.spyOn(parser, "readTileSourceDataLayer").mockReturnValue(layer);
                this.onSourceData!(new Uint8Array([2]));
            });
        const loading = component.loadSourceDataLayer(mapTileKey);
        expect(request).not.toHaveBeenCalled();
        ready();
        expect((await loading).layer).toBe(layer);
        expect(request).toHaveBeenCalledOnce();
        expect(parser.isDeleted()).toBe(true);
        expect(layer.delete).not.toHaveBeenCalled();
    });

    it("releases the inspection loading indicator when the panel closes during schema loading", async () => {
        const {component, mapTileKey, finishLoading} = fixture();
        component.mapService = {
            dataSourceInfoChanged: new Subject<readonly string[]>(),
            waitForMapLayersReady: (_layers: unknown, signal: AbortSignal) => new Promise<void>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {once: true});
            })
        };
        const request = vi.spyOn(MapTileStreamClientTiles.prototype, "request");
        const loading = component.refreshSourceData(mapTileKey, undefined, 0, false);
        component.ngOnDestroy();
        await loading;
        expect(finishLoading).toHaveBeenCalledOnce();
        expect(request).not.toHaveBeenCalled();
    });

    it("aborts a pending source-data body when its datasource retires", async () => {
        const {component, mapTileKey} = fixture();
        const changes = new Subject<readonly string[]>();
        component.mapService = {
            dataSourceInfoChanged: changes,
            waitForMapLayersReady: async () => {},
            getSchemaArtifacts: () => [],
            getDataSourceInfoJson: () => "[]"
        };
        let fetchSignal: AbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
            fetchSignal = init.signal!;
            fetchSignal.addEventListener("abort", () => reject(fetchSignal!.reason), {once: true});
        })));
        try {
            const loading = component.loadSourceDataLayer(mapTileKey);
            const cancelled = expect(loading).rejects.toMatchObject({name: "AbortError"});
            await vi.waitFor(() => expect(fetchSignal).toBeDefined());
            changes.next(["Sibling"]);
            expect(fetchSignal!.aborted).toBe(false);
            changes.next(["Map"]);
            expect(fetchSignal!.aborted).toBe(true);
            await cancelled;
        } finally {vi.unstubAllGlobals();}
    });
});

describe("sourceDataTreePresentation", () => {
    it("extracts an SQL query and flattens result rows into named sections", () => {
        const firstRow = {
            key: 0,
            schemaType: "routingTileTable.row",
            children: [{key: "id", value: 1}]
        };
        const result = sourceDataTreePresentation({
            key: "root",
            schemaType: "routingTileTable",
            children: [
                {key: "query", value: "SELECT * FROM routingTileTable;"},
                {
                    key: "rows",
                    children: [
                        firstRow,
                        {
                            key: 1,
                            schemaType: "routingTileTable.row",
                            children: [{key: "id", value: 2}]
                        }
                    ]
                }
            ]
        });

        expect(result.sqlQuery).toBe("SELECT * FROM routingTileTable;");
        expect(result.treeData.map(row => row.data?.key)).toEqual([
            "Result row 1",
            "Result row 2"
        ]);
        expect(result.treeData[0].data?.styleClass).toBe("source-data-sql-result-row");
        expect(firstRow.key).toBe(0);
    });

    it("shows decoded blob addresses relative to their SQL cell", () => {
        const result = sourceDataTreePresentation({
            key: "root",
            schemaType: "routingTileTable",
            address: {offset: 0, size: 200},
            children: [
                {key: "query", value: "SELECT * FROM routingTileTable;"},
                {
                    key: "rows",
                    children: [{
                        key: 0,
                        schemaType: "routingTileTable.row",
                        address: {offset: 40, size: 100},
                        children: [
                            {
                                key: "id",
                                address: {offset: 40, size: 1}
                            },
                            {
                                key: "ndsData",
                                address: {offset: 80, size: 64},
                                addressScope: true,
                                children: [{
                                    key: "header",
                                    address: {offset: 88, size: 16}
                                }]
                            }
                        ]
                    }]
                }
            ]
        });

        const row = result.treeData[0];
        expect(row.data?.displayAddress).toBeUndefined();
        expect(row.children?.[0].data?.displayAddress).toBeUndefined();
        expect(row.children?.[1].data?.displayAddress).toEqual({offset: 0, size: 64});
        expect(row.children?.[1].children?.[0].data?.displayAddress)
            .toEqual({offset: 8, size: 16});
        expect(row.children?.[1].children?.[0].data?.address)
            .toEqual({offset: 88, size: 16});
    });

    it("hides structural SQL addresses even when the result has no blobs", () => {
        const result = sourceDataTreePresentation({
            key: "root",
            address: {offset: 0, size: 3},
            children: [
                {key: "query", value: "SELECT id FROM table;"},
                {
                    key: "rows",
                    children: [{
                        key: 0,
                        address: {offset: 0, size: 1},
                        children: [{
                            key: "id",
                            address: {offset: 0, size: 1}
                        }]
                    }]
                }
            ]
        });

        expect(result.treeData[0].data?.displayAddress).toBeUndefined();
        expect(result.treeData[0].children?.[0].data?.displayAddress).toBeUndefined();
    });

    it("preserves ordinary SourceData roots without the SQL-result convention", () => {
        const child = {
            key: "field",
            value: 7,
            address: {offset: 12, size: 4}
        };
        const result = sourceDataTreePresentation({
            key: "root",
            schemaType: "Example",
            children: [child]
        });

        expect(result.sqlQuery).toBeUndefined();
        expect(result.treeData[0].data?.displayAddress).toEqual({offset: 12, size: 4});
        expect(result.treeData[0].data?.address).toEqual({offset: 12, size: 4});
        expect(child).not.toHaveProperty("displayAddress");
    });

    it("adapts the shared flat inspection model without losing value summaries", () => {
        const result = sourceDataTreePresentation({
            key: "root",
            type: 0,
            schemaType: "Example.Root",
            children: [{
                key: "details",
                type: 0,
                schemaType: "Example.Details",
                valueBubbles: [{
                    label: "50",
                    targetNodeId: "0:details/0:speed",
                    kind: "scalar"
                }],
                children: [{
                    key: "speed",
                    value: 50,
                    type: 1,
                    nodeId: "0:details/0:speed"
                }]
            }]
        });

        expect(result.treeData[0].data?.schemaType).toBe("Example.Details");
        expect(result.treeData[0].data?.valueBubbles).toEqual([{
            label: "50",
            targetNodeId: "0:details/0:speed",
            kind: "scalar"
        }]);
        expect(result.treeData[0].children?.[0].data?.value).toBe(50);
    });

    it("expands roots only through unambiguous single-child paths", () => {
        const branch: TreeTableNode = {
            data: {key: "branch"},
            children: [
                {data: {key: "left"}, children: [{data: {key: "left-child"}}]},
                {data: {key: "right"}}
            ]
        };
        const chainLeaf: TreeTableNode = {data: {key: "leaf"}};
        const chainChild: TreeTableNode = {data: {key: "child"}, children: [chainLeaf]};
        const roots: TreeTableNode[] = [
            {data: {key: "chain"}, children: [chainChild]},
            branch
        ];

        expandSingleChildSourceDataPaths(roots);

        expect(roots[0].expanded).toBe(true);
        expect(chainChild.expanded).toBe(true);
        expect(chainLeaf.expanded).toBe(true);
        expect(branch.expanded).toBe(true);
        expect(branch.children?.[0].expanded).toBeUndefined();
        expect(branch.children?.[1].expanded).toBeUndefined();
    });
});
