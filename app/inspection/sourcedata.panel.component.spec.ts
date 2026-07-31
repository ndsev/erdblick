import {describe, expect, it} from "vitest";
import {TreeTableNode} from "primeng/api";
import {
    expandSingleChildSourceDataPaths,
    sourceDataTreePresentation
} from "./sourcedata-tree.presentation";

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
