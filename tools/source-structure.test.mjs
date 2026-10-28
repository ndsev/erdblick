/** Validate architectural boundaries using isolated source graphs, not the current inventory. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSourceStructure } from "./source-structure.mjs";

/** Give module resolution a real filesystem, including configurable TypeScript aliases. */
function check(files, compilerOptions = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "erdblick-roles-"));
    try {
        files = { "tsconfig.json": JSON.stringify({ compilerOptions }), ...files };
        for (const [file, source] of Object.entries(files)) {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, source);
        }
        return checkSourceStructure(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test("type-only service dependencies are rejected through path aliases", () => {
    const result = check({
        "app/search/search.model.ts": 'import type { Search } from "@search/search.service"; export type Value = Search;',
        "app/search/search.service.ts": 'import { Injectable } from "@angular/core"; @Injectable() export class Search {}'
    }, { baseUrl: ".", paths: { "@search/*": ["app/search/*"] } });
    assert.ok(result.some(item => item.rule === "role-dependency" && item.file.endsWith("search.model.ts")));
});

test("re-exports and import type queries cannot hide operational dependencies", () => {
    const result = check({
        "app/search/search.model.ts": 'export type { Controller } from "./search.controller";',
        "app/search/query.model.ts": 'export type Query = import("./search.controller").Controller;',
        "app/search/search.controller.ts": 'export class Controller {}'
    });
    assert.equal(result.filter(item => item.rule === "role-dependency").length, 2);
});

test("a data-contract barrel cannot introduce a service dependency into a model", () => {
    const result = check({
        "app/search/search.model.ts": 'import type { Search } from "./search.contract"; export type Value = Search;',
        "app/search/search.contract.ts": 'export type { Search } from "./search.service";',
        "app/search/search.service.ts": 'import { Injectable } from "@angular/core"; @Injectable() export class Search {}'
    });
    assert.ok(result.some(item => item.rule === "role-dependency" && item.file.endsWith("search.contract.ts")));
});

test("utilities cannot use aliased injection to discover hidden dependencies", () => {
    const result = check({
        "app/search/value.util.ts": 'import { inject as resolve } from "@angular/core"; export const value = () => resolve("token");'
    });
    assert.ok(result.some(item => item.rule === "independent-role"));
});

test("shared utilities cannot import domain values even when imports are erased", () => {
    const result = check({
        "app/utils/format.util.ts": 'import type { Camera } from "../mapview/camera.model"; export const format = (c: Camera) => c.x;',
        "app/mapview/camera.model.ts": 'export interface Camera { x: number; }'
    });
    assert.ok(result.some(item => item.rule === "shared-utility-domain"));
});

test("stateful utilities and service-supplied component controllers remain valid", () => {
    const result = check({
        "app/utils/loop.util.ts": 'export class Loop { private timer = setTimeout(() => {}, 1); dispose() { clearTimeout(this.timer); } }',
        "app/search/search.controller.ts": 'import { Loop } from "../utils/loop.util"; export class Tree { loop = new Loop(); }',
        "app/mapdata/mapdata.service.ts": 'import { Injectable as Owned } from "@angular/core"; import { Tree } from "../search/search.controller"; import { Loop } from "../utils/loop.util"; @Owned() export class Data { tree = new Tree(); loop = new Loop(); }'
    });
    assert.deepEqual(result, []);
});

test("test files and barrels do not satisfy utility reuse", () => {
    const result = check({
        "app/search/value.util.ts": 'export const value = () => 1;',
        "app/search/read.adapter.ts": 'import { value } from "./value.util"; export const read = value;',
        "app/search/public.adapter.ts": 'export { value } from "./value.util";',
        "tools/value.test.mjs": 'import { value } from "../app/search/value.util"; value();'
    });
    assert.match(result.find(item => item.rule === "utility-reuse").message, /^1 production consumer/);
});

test("domain filenames and Angular decorators must agree with the role", () => {
    const result = check({
        "app/main.ts": 'export {};',
        "app/search/search.ts": 'export const query = "";',
        "app/search/search.service.ts": 'export class Search {}',
        "app/action/generated/unsuffixed.ts": 'export {};'
    });
    assert.deepEqual(result.map(item => item.rule).sort(), ["angular-role", "filename-role"]);
});

test("state containers can use persistence but not a domain service", () => {
    const result = check({
        "app/appstate/appstate.service.ts": 'import { Injectable } from "@angular/core"; @Injectable() export class Persistence {}',
        "app/search/search.service.ts": 'import { Injectable } from "@angular/core"; @Injectable() export class Search {}',
        "app/search/search.state.ts": 'import { Injectable } from "@angular/core"; import { Persistence } from "../appstate/appstate.service"; import type { Search } from "./search.service"; @Injectable() export class State { constructor(p: Persistence) {} }'
    });
    assert.equal(result.filter(item => item.rule === "state-dependency").length, 1);
    assert.match(result[0].message, /search\/search.service/);
});

test("cycles among otherwise valid value modules are rejected", () => {
    const result = check({
        "app/search/a.model.ts": 'import type { B } from "./b.model"; export interface A { b: B; }',
        "app/search/b.model.ts": 'import type { A } from "./a.model"; export interface B { a: A; }'
    });
    assert.ok(result.some(item => item.rule === "value-cycle"));
});
