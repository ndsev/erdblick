/**
 * Check source roles once for the whole application import graph.
 * TypeScript resolves aliases and type-only imports just as it does for the
 * build. This keeps filename, dependency and reuse rules in one place rather
 * than rescanning the repository from every ESLint file visitor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** These roles describe the module's responsibility, not every declaration in it. */
export const sourceRoles = new Set([
    "adapter", "client", "component", "constants", "contract", "controller",
    "converter", "datasource", "directive", "extension", "host", "layer",
    "model", "module", "pipe", "presentation", "protocol", "service",
    "shaders", "state", "util", "visualization", "worker"
]);

/** Entrypoints and Angular replacement files have externally established names. */
const entrypoints = new Set([
    "app/main.ts", "app/zone-flags.ts", "app/application-registration.ts",
    "app/environments/environment.ts", "app/environments/environment.prod.ts",
    "app/environments/environment.visualization-only.ts"
]);
const angularRoles = new Map([
    ["component", "Component"], ["directive", "Directive"], ["pipe", "Pipe"],
    ["module", "NgModule"], ["service", "Injectable"], ["state", "Injectable"]
]);
const operationalRoles = new Set([
    "service", "state", "controller", "client", "component", "directive",
    "pipe", "module", "worker", "datasource"
]);
const modelOnlyRestrictions = new Set(["adapter", "presentation", "visualization", "layer", "host", "extension"]);
const valueRoles = new Set(["model", "contract", "protocol", "constants"]);

/** Normalize only filesystem separators; module resolution handles path aliases. */
function portable(file) {
    return file.replaceAll(path.sep, "/");
}

/** The last suffix is the role, including worker.protocol.ts and mirrored specs. */
function roleOf(file) {
    return path.basename(file).split(".").at(-2);
}

/** Extract all statically named module references, including erased type queries. */
function moduleReferences(source) {
    const references = [];
    const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            if (ts.isStringLiteral(node.moduleSpecifier)) references.push(node.moduleSpecifier.text);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)) {
            references.push(node.argument.literal.text);
        } else if (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                ts.isIdentifier(node.expression) && node.expression.text === "require") &&
            node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            references.push(node.arguments[0].text);
        } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === "URL" && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) {
            references.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return references;
}

/** Recognize Angular decorators by their imported name, including local aliases. */
function angularDecorators(source) {
    const names = new Map();
    const namespaces = new Set();
    for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "@angular/core") continue;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements) names.set(item.name.text, (item.propertyName ?? item.name).text);
        } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    }
    const result = new Set();
    for (const node of source.statements) {
        if (!ts.canHaveDecorators(node)) continue;
        for (const decorator of ts.getDecorators(node) ?? []) {
            const expression = ts.isCallExpression(decorator.expression)
                ? decorator.expression.expression : decorator.expression;
            if (ts.isIdentifier(expression) && names.has(expression.text)) result.add(names.get(expression.text));
            if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
                namespaces.has(expression.expression.text)) result.add(expression.name.text);
        }
    }
    return result;
}

/** Re-export-only modules do not manufacture a second consumer for a utility. */
function hasImplementation(source) {
    return source.statements.some(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) &&
        !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isEmptyStatement(node));
}

/** Inspect production sources without constructing an Angular app or running code. */
export function checkSourceStructure(root) {
    root = path.resolve(root);
    const configPath = path.join(root, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
    const files = ts.sys.readDirectory(root, [".ts", ".mjs"], ["**/node_modules/**"], ["app/**/*", "tools/**/*"])
        .filter(file => !file.endsWith(".d.ts") && !/\.(spec|test)\.(ts|mjs)$/.test(file) &&
            !portable(path.relative(root, file)).startsWith("app/action/generated/"));
    const modules = new Map(files.map(file => [file, {
        file: portable(path.relative(root, file)),
        role: roleOf(file),
        source: ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
        dependencies: new Set()
    }]));
    const diagnostics = [];
    const report = (severity, rule, file, message) => diagnostics.push({ severity, rule, file, message });

    for (const [absolute, module] of modules) {
        for (const specifier of moduleReferences(module.source)) {
            const resolved = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule?.resolvedFileName;
            if (resolved && modules.has(resolved)) module.dependencies.add(resolved);
        }
        if (!module.file.startsWith("app/") || entrypoints.has(module.file)) continue;
        if (!sourceRoles.has(module.role)) {
            report("error", "filename-role", module.file, "Use an established role suffix for this domain module.");
        }
        const decorators = angularDecorators(module.source);
        const expected = angularRoles.get(module.role);
        if (expected && !decorators.has(expected)) {
            report("error", "angular-role", module.file, `The .${module.role} role requires @${expected}.`);
        }
        const independent = valueRoles.has(module.role) || module.role === "util";
        if (independent && decorators.size) {
            report("error", "independent-role", module.file, "Models and utilities must not declare Angular participants.");
        }
        if (independent) {
            for (const node of module.source.statements) {
                if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "@angular/core") continue;
                const bindings = node.importClause?.namedBindings;
                if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(item =>
                    ["inject", "Injector", "EnvironmentInjector", "runInInjectionContext", "createEnvironmentInjector"]
                        .includes((item.propertyName ?? item.name).text))) {
                    report("error", "independent-role", module.file, "Value modules and utilities must not request Angular injection facilities.");
                }
            }
        }
        for (const dependency of module.dependencies) {
            const target = modules.get(dependency);
            if (!target.file.startsWith("app/")) continue;
            const restricted = operationalRoles.has(target.role) ||
                valueRoles.has(module.role) && modelOnlyRestrictions.has(target.role);
            if (independent && restricted) {
                report("error", "role-dependency", module.file,
                    `.${module.role} must not depend on ${target.file}, including through a type-only import.`);
            }
            if (module.role === "state" && operationalRoles.has(target.role) && target.role !== "state" &&
                target.file !== "app/appstate/appstate.service.ts") {
                report("error", "state-dependency", module.file,
                    `State containers must not depend on ${target.file}; retain only the value contract.`);
            }
            if (module.file.startsWith("app/utils/") && !target.file.startsWith("app/utils/")) {
                report("error", "shared-utility-domain", module.file,
                    `Shared utilities must not depend on domain module ${target.file}.`);
            }
        }
    }

    for (const [absolute, module] of modules) {
        if (module.role !== "util" || !module.file.startsWith("app/")) continue;
        const consumers = [...modules.values()].filter(other => other.dependencies.has(absolute) && hasImplementation(other.source));
        if (consumers.length < 2) {
            report("warning", "utility-reuse", module.file,
                `${consumers.length} production consumer(s)${consumers.length ? `: ${consumers.map(c => c.file).join(", ")}` : ""}. Review colocation; tests and re-export barrels do not count.`);
        }
    }

    // Low-level cycles undermine independent value contracts even when every
    // individual import has an allowed suffix. Service graphs have different
    // lifecycle concerns and are deliberately outside this focused rule.
    const visited = new Set();
    const active = [];
    const visit = absolute => {
        if (active.includes(absolute)) {
            const cycle = active.slice(active.indexOf(absolute)).concat(absolute).map(file => modules.get(file).file);
            report("error", "value-cycle", modules.get(absolute).file, cycle.join(" -> "));
            return;
        }
        if (visited.has(absolute)) return;
        visited.add(absolute);
        active.push(absolute);
        for (const target of modules.get(absolute).dependencies) {
            if (valueRoles.has(modules.get(target).role) || modules.get(target).role === "util") visit(target);
        }
        active.pop();
    };
    for (const [absolute, module] of modules) {
        if (valueRoles.has(module.role) || module.role === "util") visit(absolute);
    }
    return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

/** The build fails on role/dependency errors; reuse remains an explicit review warning. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const diagnostics = checkSourceStructure(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    for (const item of diagnostics) console.log(`${item.severity}: ${item.file} [${item.rule}] ${item.message}`);
    const errors = diagnostics.filter(item => item.severity === "error").length;
    console.log(`Source structure: ${errors} errors, ${diagnostics.length - errors} reuse warnings.`);
    process.exitCode = errors ? 1 : 0;
}
