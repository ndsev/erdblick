/** Exercise the rule against real imported types, including aliases and wrappers. */
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RuleTester } from "eslint";
import parser from "@typescript-eslint/parser";
import rule from "./no-combine-app-state.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const root = fileURLToPath(new URL("../../", import.meta.url));
const filename = path.join(root, "rule-test.ts");
const tester = new RuleTester({
    languageOptions: {
        parser,
        parserOptions: {
            projectService: { allowDefaultProject: ["rule-test.ts"], defaultProject: "tsconfig.eslint.json" },
            tsconfigRootDir: root
        }
    }
});
const declarations = `
    import { BehaviorSubject, combineLatest, combineLatestWith, map } from "rxjs";
    import { AppState, PerViewState } from "./app/appstate/appstate.model";
    import { AppStateService } from "./app/appstate/appstate.service";
    declare const left: AppState<number>;
    declare const perView: PerViewState<number>;
    declare const right: AppState<number>;
    declare const independent: BehaviorSubject<number>;
    declare const persistence: AppStateService;
`;
const valid = code => ({ filename, code: declarations + code });
const invalid = (code, operator = "combineLatest") => ({
    ...valid(code), errors: [{ messageId: "incoherent", data: { operator } }]
});

tester.run("no-combine-app-state", rule, {
    valid: [
        valid("combineLatest([independent, independent.asObservable()]);"),
        valid("independent.pipe(combineLatestWith(independent));"),
        valid("persistence.observe(() => ({ left: left.value, right: right.value }));"),
        valid("combineLatest([persistence.observe(() => [left.value, right.value]), independent]);"),
        { filename, code: "function combineLatest(inputs: unknown[]) { return inputs; } combineLatest([1, 2]);" }
    ],
    invalid: [
        invalid("combineLatest([left, right]);"),
        invalid("combineLatest([perView, independent]);"),
        invalid("combineLatest({ left, right });"),
        invalid("combineLatest([left.pipe(map(value => value * 2)), independent]);"),
        invalid("const renamed = left.asObservable(); const sources = [renamed, independent]; combineLatest(sources);"),
        invalid("const owner = { current: left }; combineLatest([owner.current, independent]);"),
        invalid('import { combineLatest as join } from "rxjs"; join([left, right]);'),
        invalid('import * as rx from "rxjs"; rx.combineLatest([left, right]);'),
        invalid("independent.pipe(combineLatestWith(left));", "combineLatestWith"),
        invalid("left.pipe(map(value => value), combineLatestWith(independent));", "combineLatestWith")
    ]
});
