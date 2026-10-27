import {HighlightStyle, StreamLanguage, StringStream} from "@codemirror/language";
import {tags} from "@lezer/highlight";

const simfilKeywords = new Set([
    "and",
    "or",
    "not",
    "in",
    "contains",
    "true",
    "false",
    "null",
    "NULL",
    "COMPLETE"
]);

/** Lightweight SIMFIL tokenizer for inline expression highlighting. */
export const simfilLanguage = StreamLanguage.define({
    token(stream: StringStream): string | null {
        if (stream.eatSpace()) {
            return null;
        }
        if (stream.match(/\/\/.*/)) {
            return "comment";
        }
        if (stream.match(/"(?:[^"\\]|\\.)*"?/) || stream.match(/'(?:[^'\\]|\\.)*'?/)) {
            return "string";
        }
        if (stream.match(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) {
            return "number";
        }
        if (stream.match(/\*\*/)) {
            return "atom";
        }
        if (stream.match(/\$[A-Za-z_][\w$]*/)) {
            return "atom";
        }
        if (stream.match(/[<>!]=|==|&&|\|\||[+\-*/%<>=!.,:;()[\]{}]/)) {
            return "operator";
        }

        const identifier = stream.match(/[A-Za-z_][\w]*/);
        if (Array.isArray(identifier)) {
            const text = identifier[0];
            if (simfilKeywords.has(text)) {
                return ["true", "false"].includes(text) ? "bool" : "keyword";
            }
            const next = stream.match(/\s*\(/, false);
            return next ? "variableName.function" : "variableName";
        }

        stream.next();
        return null;
    }
});

/** Explicit SIMFIL colors avoid default-theme surprises such as red field tokens in dark mode. */
export const simfilHighlightStyle = HighlightStyle.define([
    {tag: tags.keyword, color: "var(--simfil-token-keyword)"},
    {tag: tags.operator, color: "var(--simfil-token-operator)"},
    {tag: tags.atom, color: "var(--simfil-token-field)", fontWeight: "500"},
    {tag: tags.variableName, color: "var(--simfil-token-field)"},
    {tag: tags.function(tags.variableName), color: "var(--simfil-token-function)"},
    {tag: tags.string, color: "var(--simfil-token-string)"},
    {tag: tags.number, color: "var(--simfil-token-number)"},
    {tag: tags.bool, color: "var(--simfil-token-number)"},
    {tag: tags.comment, color: "var(--simfil-token-comment)", fontStyle: "italic"}
]);
