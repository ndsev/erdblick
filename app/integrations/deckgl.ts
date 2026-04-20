// Avoid the @deck.gl/geo-layers root barrel because it re-exports optional
// layers that pull CommonJS-only transitive deps into Angular's import-graph
// analysis, even when those branches tree-shake away.
/** Narrow re-export of Deck's `TileLayer` to avoid the problematic geo-layers root barrel. */
export {default as TileLayer} from '../../node_modules/@deck.gl/geo-layers/dist/tile-layer/tile-layer.js';
