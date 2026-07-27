import {describe, expect, it} from "vitest";
import {sourceDataTreePresentation} from "./sourcedata-tree.presentation";

describe("sourceDataTreePresentation", () => {
    it("extracts an SQL query and flattens result rows into named sections", () => {
        const firstRow = {
            data: {key: 0, type: "routingTileTable.row"},
            children: [{data: {key: "id", value: 1}}]
        };
        const result = sourceDataTreePresentation({
            data: {key: "root", type: "routingTileTable"},
            children: [
                {data: {key: "query", value: "SELECT * FROM routingTileTable;"}},
                {
                    data: {key: "rows"},
                    children: [
                        firstRow,
                        {
                            data: {key: 1, type: "routingTileTable.row"},
                            children: [{data: {key: "id", value: 2}}]
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
        expect(firstRow.data.key).toBe(0);
    });

    it("shows decoded blob addresses relative to their SQL cell", () => {
        const result = sourceDataTreePresentation({
            data: {
                key: "root",
                type: "routingTileTable",
                address: {offset: 0, size: 200}
            },
            children: [
                {data: {key: "query", value: "SELECT * FROM routingTileTable;"}},
                {
                    data: {key: "rows"},
                    children: [{
                        data: {
                            key: 0,
                            type: "routingTileTable.row",
                            address: {offset: 40, size: 100}
                        },
                        children: [
                            {
                                data: {
                                    key: "id",
                                    address: {offset: 40, size: 1}
                                }
                            },
                            {
                                data: {
                                    key: "ndsData",
                                    address: {offset: 80, size: 64},
                                    addressScope: true
                                },
                                children: [{
                                    data: {
                                        key: "header",
                                        address: {offset: 88, size: 16}
                                    }
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
            data: {key: "root", address: {offset: 0, size: 3}},
            children: [
                {data: {key: "query", value: "SELECT id FROM table;"}},
                {
                    data: {key: "rows"},
                    children: [{
                        data: {key: 0, address: {offset: 0, size: 1}},
                        children: [{
                            data: {key: "id", address: {offset: 0, size: 1}}
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
            data: {
                key: "field",
                value: 7,
                address: {offset: 12, size: 4}
            }
        };
        const result = sourceDataTreePresentation({
            data: {key: "root", type: "Example"},
            children: [child]
        });

        expect(result.sqlQuery).toBeUndefined();
        expect(result.treeData[0].data?.displayAddress).toEqual({offset: 12, size: 4});
        expect(result.treeData[0].data?.address).toEqual({offset: 12, size: 4});
        expect(child.data).not.toHaveProperty("displayAddress");
    });
});
