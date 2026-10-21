import {z} from "zod";
import {indexSchema, text} from "../actions/action-schema";

export const VIEWER_SCREENSHOT_MAX_BASE64 = 240000;

/** Public operations owned and bound by the adjacent service. */
export const viewerDocumentActions = {
    viewer_screenshot: {
        name: "viewer_screenshot",
        description:
            "Capture the visible application viewport, including maps, labels, highlights, panels and overlays, but not browser chrome. The JPEG is already attached as image content in this tool result; refer to the captured image in prose and continue the requested report. Never transcribe image bytes, emit a base64/data URI, or invent a download/attachment URL. DOM-based capture is approximate and is not a render-ready fence. No clipboard or file download. maxWidth/maxHeight bound the whole image without cropping; defaults 1280x960. Requires viewer-read and an explicit tab.",
        mutation: false,
        inputSchema: z.strictObject({
            maxWidth: z.number().int().min(128).max(1920).optional(),
            maxHeight: z.number().int().min(128).max(1920).optional(),
            viewLayoutRevision: indexSchema.optional()
        }),
        // Native MCP promotes image to ImageContent and advertises/returns only this self-contained metadata schema as structuredContent.
        outputSchema: z.strictObject({
            image: z.strictObject({
                mimeType: z.literal("image/jpeg"),
                data: z.string().min(4).max(VIEWER_SCREENSHOT_MAX_BASE64)
            }),
            metadata: z.strictObject({
                scope: z.literal("application-viewport"),
                width: z.number().int().min(1).max(1920),
                height: z.number().int().min(1).max(1920),
                viewportWidth: z.number().int().min(1).max(32768),
                viewportHeight: z.number().int().min(1).max(32768),
                viewLayoutRevision: indexSchema,
                capturedAt: z.string(),
                readiness: z.strictObject({status: z.literal("unknown")}),
                warnings: z.array(text).max(10)
            })
        })
    }
} as const;
