import {Extension} from "@codemirror/state";
import {EditorView} from "@codemirror/view";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {oneDark} from "@codemirror/theme-one-dark";

export const CODEMIRROR_DARK_MODE_CLASS = "erdblick-dark";

/** Returns the current app-wide CodeMirror syntax theme. */
export function currentCodeMirrorTheme(extraTheme?: Extension): Extension[] {
    const isDark = document.documentElement.classList.contains(CODEMIRROR_DARK_MODE_CLASS);
    const lightTheme = EditorView.theme({}, {dark: false});
    const syntaxTheme: Extension[] = isDark ? [oneDark] : [lightTheme, syntaxHighlighting(defaultHighlightStyle)];
    return extraTheme ? [...syntaxTheme, extraTheme] : syntaxTheme;
}

/** Builds a compact CodeMirror theme that visually behaves like a PrimeNG text input. */
export function currentInlineCodeMirrorTheme(): Extension[] {
    const isDark = document.documentElement.classList.contains(CODEMIRROR_DARK_MODE_CLASS);
    return [EditorView.theme({
        "&": {
            "--simfil-token-keyword": isDark ? "#93c5fd" : "#1d4ed8",
            "--simfil-token-operator": isDark ? "#cbd5e1" : "#475569",
            "--simfil-token-field": isDark ? "#5eead4" : "#047857",
            "--simfil-token-function": isDark ? "#fbbf24" : "#b45309",
            "--simfil-token-string": isDark ? "#86efac" : "#15803d",
            "--simfil-token-number": isDark ? "#c4b5fd" : "#7e22ce",
            "--simfil-token-comment": isDark ? "#94a3b8" : "#64748b",
            backgroundColor: "var(--p-inputtext-background)",
            border: "1px solid var(--p-inputtext-border-color)",
            borderRadius: "var(--p-inputtext-border-radius, 4px)",
            color: "var(--p-inputtext-color)",
            minHeight: "2.25em",
            transition: "border-color 0.2s, box-shadow 0.2s"
        },
        "&.cm-focused": {
            borderColor: "var(--p-focus-ring-color)",
            boxShadow: "var(--p-focus-ring-shadow, none)",
            outline: "none"
        },
        ".cm-scroller": {
            fontFamily: "inherit",
            lineHeight: "1.35",
            overflow: "auto"
        },
        ".cm-content": {
            caretColor: "var(--p-inputtext-color)",
            minHeight: "2.25em",
            padding: "0.45em 0.6em"
        },
        ".cm-line": {
            padding: "0"
        },
        ".cm-gutters": {
            display: "none"
        },
        ".cm-placeholder": {
            color: "var(--p-inputtext-placeholder-color)",
            opacity: "1"
        },
        "&.simfil-expression-single-line .cm-content": {
            whiteSpace: "pre"
        },
        "&.simfil-expression-single-line .cm-scroller": {
            overflow: "hidden"
        }
    }, {dark: isDark})];
}
