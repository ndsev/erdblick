/**
 * AppState values are staged together but their RxJS notifications are delivered
 * one at a time. combineLatest caches those deliveries and can therefore expose
 * an intermediate marker, view or layer configuration from an otherwise atomic
 * transaction. Completed projections belong in AppStateService.observe().
 *
 * Use type information rather than a property-name convention: ordinary RxJS
 * streams remain valid inputs. Follow local aliases, input collections, pipe()
 * and asObservable(), so wrapping a slot does not accidentally bypass the rule.
 */
import ts from "typescript";

export default {
    meta: {
        type: "problem",
        docs: { description: "Require coherent AppState observations instead of independently cached slot notifications." },
        schema: [],
        messages: {
            incoherent: "Do not combine AppState slot notifications with {{operator}}. Read the related values together through AppStateService.observe(() => (...)); keep combineLatest for independent RxJS streams."
        }
    },

    /** Resolve actual RxJS operators and AppState types through the lint program. */
    create(context) {
        const services = context.sourceCode.parserServices;
        if (!services?.program || !services.esTreeNodeToTSNodeMap) {
            throw new Error("erdblick/no-combine-app-state requires the configured TypeScript lint project.");
        }
        const checker = services.program.getTypeChecker();

        /** Recognize the primitives and subclasses, not similarly named domain containers. */
        function isAppStateType(type, seen = new Set()) {
            if (!type || seen.has(type)) return false;
            seen.add(type);
            if (type.isUnionOrIntersection()) return type.types.some(part => isAppStateType(part, seen));
            const symbol = type.getSymbol();
            if (symbol && ["AppState", "PerViewState", "StyleState"].includes(symbol.name) &&
                symbol.declarations?.some(declaration => declaration.getSourceFile().fileName.replaceAll("\\", "/").endsWith("/app/appstate/appstate.model.ts"))) {
                return true;
            }
            return type.getBaseTypes?.()?.some(base => isAppStateType(base, seen)) ?? false;
        }

        /** Trace a local source expression without interpreting arbitrary application code. */
        function comesFromSlot(node, seen = new Set()) {
            if (!node || seen.has(node)) return false;
            seen.add(node);
            if (isAppStateType(checker.getTypeAtLocation(node))) return true;
            if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ||
                ts.isNonNullExpression(node) || ts.isSpreadElement(node)) return comesFromSlot(node.expression, seen);
            if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => comesFromSlot(element, seen));
            if (ts.isObjectLiteralExpression(node)) {
                return node.properties.some(property => {
                    if (ts.isPropertyAssignment(property)) return comesFromSlot(property.initializer, seen);
                    if (ts.isShorthandPropertyAssignment(property)) return comesFromSlot(property.name, seen);
                    if (ts.isSpreadAssignment(property)) return comesFromSlot(property.expression, seen);
                    return false;
                });
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                ["pipe", "asObservable"].includes(node.expression.name.text)) {
                return comesFromSlot(node.expression.expression, seen);
            }
            if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
                const symbol = checker.getSymbolAtLocation(node);
                const declaration = symbol?.valueDeclaration;
                if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))) {
                    return comesFromSlot(declaration.initializer, seen);
                }
            }
            return false;
        }

        return {
            /** Inspect aliases and namespace calls as well as the usual named imports. */
            CallExpression(node) {
                const call = services.esTreeNodeToTSNodeMap.get(node);
                let symbol = checker.getSymbolAtLocation(call.expression);
                if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
                if (!symbol || !["combineLatest", "combineLatestWith"].includes(symbol.name) ||
                    !symbol.declarations?.some(declaration => declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/rxjs/"))) return;

                let unsafe = call.arguments.some(argument => comesFromSlot(argument));
                if (symbol.name === "combineLatestWith") {
                    // The receiver of slot.pipe(combineLatestWith(...)) is also
                    // an input, even when every explicit argument is independent.
                    const parent = call.parent;
                    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "pipe") {
                        unsafe ||= comesFromSlot(parent.expression.expression);
                    }
                }
                if (unsafe) context.report({ node, messageId: "incoherent", data: { operator: symbol.name } });
            }
        };
    }
};
