#include "erdblick/parser.h"

namespace erdblick
{
mapget::CoverageQuery const* TileLayerParser::coverageQuery(
    std::string const& mapId, std::string const& layerId) const
{
    auto key = std::pair{mapId, layerId};
    if (auto query = coverageQueries_.find(key); query != coverageQueries_.end()) return &query->second;
    auto map = info_.find(mapId);
    if (map == info_.end()) return nullptr;
    auto layer = map->second.layers_.find(layerId);
    if (layer == map->second.layers_.end() || !layer->second) return nullptr;
    return &coverageQueries_.try_emplace(key, *layer->second).first->second;
}

bool TileLayerParser::permitsCoverageTile(std::string const& mapId, std::string const& layerId, int32_t tile) const
{
    auto query = coverageQuery(mapId, layerId);
    return !query || query->permits(mapget::TileId::fromValue(tile));
}

NativeJsValue TileLayerParser::selectCoverageTileIds(std::string const& mapId,
    std::string const& layerId, Viewport const& viewport, int level, int limit, bool restrict) const
{
    auto result = JsValue::List();
    for (auto tile : selectCoverageTiles(viewport, level, limit, restrict ? coverageQuery(mapId, layerId) : nullptr))
        result.push(JsValue(tile.value()));
    return *result;
}

NativeJsValue TileLayerParser::coverageDisplayBounds(std::string const& mapId,
    std::string const& layerId, int region, int level) const
{
    auto result = JsValue::List();
    auto query = coverageQuery(mapId, layerId);
    if (query) for (auto const& b : query->bounds(region < 0 ? std::nullopt : std::optional<size_t>(region), level))
        result.push(JsValue::List({JsValue(b.west_), JsValue(b.south_), JsValue(b.east_), JsValue(b.north_)}));
    return *result;
}

TileLayerParser::CoverageSummary TileLayerParser::coverageSummary(
    std::string const& mapId, std::string const& layerId) const
{
    auto query = coverageQuery(mapId, layerId);
    return query ? CoverageSummary{query->complete(), query->valid(), query->hasBounds(), query->regionCount()}
                 : CoverageSummary{};
}

NativeJsValue TileLayerParser::coverageRectangles(std::string const& mapId, std::string const& layerId,
    Viewport const& viewport, int level) const
{
    auto result = JsValue::List();
    auto query = coverageQuery(mapId, layerId);
    if (query) for (auto const& range : query->rectangles(
            {viewport.west, viewport.south, viewport.west + viewport.width, viewport.south + viewport.height}, level)) {
        auto b = range.bounds();
        result.push(JsValue::List({JsValue(b.west_), JsValue(b.south_), JsValue(b.east_), JsValue(b.north_)}));
    }
    return *result;
}

int TileLayerParser::coverageRegion(std::string const& mapId, std::string const& layerId, int32_t tile) const
{
    auto query = coverageQuery(mapId, layerId);
    auto region = query ? query->regionForTile(mapget::TileId::fromValue(tile)) : std::nullopt;
    return region ? static_cast<int>(*region) : -1;
}
}
