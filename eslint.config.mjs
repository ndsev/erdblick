import typescriptEslint from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [
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
            "no-restricted-imports": ["error", {
                paths: [{
                    name: "cesium",
                    message: "Please import Cesium modules only in app/integrations/cesium.ts.",
                }],

                patterns: [{
                    group: ["cesium/*"],
                    message: "Please import Cesium modules only in app/integrations/cesium.ts.",
                }],
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
        files: ["app/integrations/cesium.ts", "app/integrations/cesium.test.ts"],

        rules: {
            "no-restricted-imports": "off",
        },
    },
];
