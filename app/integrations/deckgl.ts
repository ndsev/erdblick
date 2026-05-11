// Avoid the @deck.gl/geo-layers root barrel because it re-exports optional
// layers that pull CommonJS-only transitive deps into Angular's import-graph
// analysis, even when those branches tree-shake away.
/** Narrow re-export of Deck's `TileLayer` to avoid the problematic geo-layers root barrel. */
export {default as TileLayer} from '../../node_modules/@deck.gl/geo-layers/dist/tile-layer/tile-layer.js';
/** Type re-export for the narrow `TileLayer` wrapper used by deck-backed raster backgrounds. */
export type {TileLayerProps} from '../../node_modules/@deck.gl/geo-layers/dist/tile-layer/tile-layer.js';
/** Narrow re-export of Deck's experimental `WMSLayer` without pulling in the geo-layers root barrel. */
export {WMSLayer} from '../../node_modules/@deck.gl/geo-layers/dist/wms-layer/wms-layer.js';
/** Type re-export for the narrow `WMSLayer` wrapper used by the map background integration. */
export type {WMSLayerProps} from '../../node_modules/@deck.gl/geo-layers/dist/wms-layer/wms-layer.js';
