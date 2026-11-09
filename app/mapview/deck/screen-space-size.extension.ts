import {LayerExtension} from "@deck.gl/core";

/**
 * Keep billboard icons and text at their authored CSS-pixel size.
 *
 * Deck's pixel unit describes a size on the camera's focal plane. Its stock
 * billboard shaders still attenuate that size with perspective depth, so an
 * elevated location marker near a tilted camera can fill the screen. Convert
 * the offset at the actual anchor depth, on every draw, instead of resizing
 * layer data when the camera moves. Attach only to pixel-sized billboards;
 * metre-sized labels and geometry must retain their physical perspective.
 */
export class ScreenSpaceSizeExtension extends LayerExtension {
    static override extensionName = "ScreenSpaceSizeExtension";

    /** Applies equally to TextLayer's glyph and background sublayers. */
    override getShaders(): unknown {
        return {
            inject: {
                "vs:DECKGL_FILTER_SIZE": `
  float anchorDepth = project_common_position_to_clipspace(geometry.position).w;
  size.xy *= anchorDepth / project.focalDistance;
`
            }
        };
    }
}
