import typescriptEslint from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import noCombineAppState from "./tools/eslint/no-combine-app-state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [
    // Catalog output is generated and type-checked; lint the generator and owners.
    { ignores: ["app/action/generated/**"] },
    ...compat.extends("eslint:recommended", "plugin:@typescript-eslint/recommended"),
    {
        plugins: {
            "@typescript-eslint": typescriptEslint,
        },

        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                Atomics: "readonly",
                SharedArrayBuffer: "readonly",
            },

            parser: tsParser,
            ecmaVersion: 2020,
            sourceType: "module",
        },

        rules: {
            "max-lines": ["warn", {
                max: 2000,
                skipBlankLines: false,
                skipComments: false,
            }],
            "prefer-const": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/ban-types": "off",
            "no-extra-semi": "off",
            "no-prototype-builtins": "off",
            "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
            "no-constant-condition": "off",
            "no-useless-escape": "off",
            "@typescript-eslint/no-loss-of-precision": "off",
        },
    },
    {
        files: ["app/**/*.ts", "tests/app/**/*.ts", "tests/support/**/*.ts"],
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.eslint.json",
                tsconfigRootDir: __dirname
            }
        },
        plugins: {
            erdblick: { rules: { "no-combine-app-state": noCombineAppState } }
        },
        rules: { "erdblick/no-combine-app-state": "error" }
    },
    {
        // Angular only discovers tests/app. Catch a misplaced spec during lint
        // instead of silently leaving it out of the test run.
        files: ["app/**/*.spec.ts"],
        rules: {
            "no-restricted-syntax": ["error", {
                selector: "Program",
                message: "Place application specs under tests/app/, mirroring their app/ domain path."
            }]
        }
    },
];
