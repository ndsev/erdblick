// Lightweight caret coordinates utility for HTMLTextAreaElement.
// Returns the pixel offset of the caret relative to the textarea's
// top-left corner. This avoids the CommonJS-only "textarea-caret"
// package and keeps the bundle fully ESM.

export interface CaretCoordinates { top: number; left: number }

export default function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): CaretCoordinates {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView || window;

  const computed = win.getComputedStyle(textarea);

  // Create a mirror div off-screen
  const div = doc.createElement("div");
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word"; // IE legacy compat
  div.style.overflow = "hidden";
  div.style.top = "0";
  div.style.left = "0";
  div.style.pointerEvents = "none";

  // Copy the relevant textarea styles that affect layout/metrics
  const properties = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "tabSize",
    "MozTabSize",
  ] as const;

  for (const prop of properties) {
    // @ts-expect-error – index signature for CSSStyleDeclaration
    div.style[prop] = (computed as any)[prop] || "";
  }

  // Normalize width to the textarea's content box to get consistent wrapping
  const isBorderBox = computed.boxSizing === "border-box";
  if (isBorderBox) {
    const borderLeft = parseFloat(computed.borderLeftWidth || "0");
    const borderRight = parseFloat(computed.borderRightWidth || "0");
    const paddingLeft = parseFloat(computed.paddingLeft || "0");
    const paddingRight = parseFloat(computed.paddingRight || "0");
    const width = textarea.clientWidth - paddingLeft - paddingRight;
    div.style.width = Math.max(0, width) + "px";
  } else {
    div.style.width = textarea.clientWidth + "px";
  }

  // Mirror the text content up to the caret
  const text = textarea.value.substring(0, Math.min(position, textarea.value.length));
  // Replace spaces to preserve width in HTML
  const textForHtml = text
    .replace(/\n$/g, "\n\u200b") // Ensure empty last line has height
    .replace(/\n/g, "<br/>")
    .replace(/ /g, "\u00a0");

  // Create a span that will represent the caret position
  const span = doc.createElement("span");
  span.textContent = textarea.value.substring(position) || "\u200b"; // keep height

  div.innerHTML = textForHtml;
  div.appendChild(span);
  doc.body.appendChild(div);

  const spanRect = span.getBoundingClientRect();
  const divRect = div.getBoundingClientRect();
  const top = spanRect.top - divRect.top;
  const left = spanRect.left - divRect.left;

  doc.body.removeChild(div);

  return { top, left };
}

