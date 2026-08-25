/** Sanitized, non-interactive HTML and its compact plain-text representation. */
export interface InspectionHtmlPresentation {
    html: string;
    text: string;
}

const presentationTags = new Set([
    "a", "b", "blockquote", "br", "code", "dd", "del", "div", "dl", "dt",
    "em", "hr", "i", "li", "mark", "ol", "p", "pre", "s", "small", "span",
    "strong", "sub", "sup", "u", "ul"
]);

const discardedTags = new Set([
    "audio", "embed", "iframe", "img", "link", "object", "script", "source", "style",
    "svg", "template", "video"
]);

/**
 * Recognizes sanitized formatting markup and reduces it to a small, inert HTML subset.
 * Attributes and resource-bearing elements are removed because inspection previews are
 * descriptive rather than interactive content.
 */
export function inspectionHtmlPresentation(
    value: unknown,
    sanitize: (html: string) => string | null
): InspectionHtmlPresentation | undefined {
    if (typeof value !== "string" || !value.includes("<") || !value.includes(">")) {
        return undefined;
    }

    const sanitized = sanitize(value);
    if (!sanitized) {
        return undefined;
    }

    const template = document.createElement("template");
    template.innerHTML = sanitized;
    const elements = Array.from(template.content.querySelectorAll("*")).reverse();
    for (const element of elements) {
        const tag = element.localName;
        if (discardedTags.has(tag)) {
            element.remove();
        } else if (presentationTags.has(tag)) {
            for (const attribute of Array.from(element.attributes)) {
                element.removeAttribute(attribute.name);
            }
        } else {
            element.replaceWith(...Array.from(element.childNodes));
        }
    }

    if (!template.content.querySelector(Array.from(presentationTags).join(","))) {
        return undefined;
    }

    const textContent = template.content.cloneNode(true) as DocumentFragment;
    for (const element of textContent.querySelectorAll("blockquote,br,dd,div,dl,dt,hr,li,ol,p,pre,ul")) {
        element.replaceWith(" ", ...Array.from(element.childNodes), " ");
    }
    return {
        html: template.innerHTML,
        text: (textContent.textContent ?? "").replace(/\s+/g, " ").trim()
    };
}
