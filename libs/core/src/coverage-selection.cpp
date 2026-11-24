#include "erdblick/coverage-selection.h"
#include "erdblick/aabb.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>

namespace erdblick
{
std::vector<mapget::TileId> selectCoverageTiles(
    Viewport const& vp, int level, int limit, mapget::CoverageQuery const* coverage)
{
    if (level < 0 || level > 15 || limit <= 0 || limit > (1 << 20) ||
        !std::isfinite(vp.camPosLon) || !std::isfinite(vp.camPosLat) ||
        !std::isfinite(vp.orientation) || !std::isfinite(vp.width) ||
        !std::isfinite(vp.height) || vp.width < 0 || vp.width > 360 ||
        vp.height < 0 || vp.height > 180)
        return {};
    if (coverage && !coverage->complete()) coverage = nullptr;
    auto camLon = std::fmod(std::fmod(vp.camPosLon + 180., 360.) + 360., 360.) - 180.;
    auto priority = Wgs84AABB::radialDistancePrioFn({camLon, vp.camPosLat}, vp.orientation);
    /** One lazy subdivision node; interior nodes use a conservative score bound. */
    struct Node {
        mapget::CoverageTileRange range;
        double score;
        bool inside;
        bool operator<(Node const& other) const { return score > other.score; }
    };
    std::priority_queue<Node> pending;
    // The existing score is planar distance times (1 + angular penalty). Distance
    // to the complete rectangle is a lower bound. Round down to account for the
    // float arithmetic in the legacy score, including level-zero pole centers.
    auto enqueue = [&](mapget::CoverageTileRange const& range, bool inside) {
        auto box = range.bounds();
        if (!inside && coverage) {
            auto relation = coverage->classify(box);
            if (relation == mapget::CoverageQuery::Relation::Outside) return;
            inside = relation == mapget::CoverageQuery::Relation::Inside;
        }
        bool single = range.minX_ == range.maxX_ && range.minY_ == range.maxY_;
        auto dx = std::max({box.west_ - camLon, 0., camLon - box.east_});
        auto dy = std::max({box.south_ - vp.camPosLat, 0., vp.camPosLat - box.north_});
        auto bound = std::max(0., std::hypot(dx, dy) * (1. - 2e-6) - 1e-4);
        pending.push({range, single ? priority(range.tile()) : bound, inside});
    };
    for (auto const& range : mapget::CoverageQuery::viewportRanges(
            {vp.west, vp.south, vp.west + vp.width, vp.south + vp.height}, level))
        enqueue(range, coverage == nullptr);
    std::vector<std::pair<double, mapget::TileId>> selected;
    selected.reserve(limit);
    auto cutoff = std::numeric_limits<double>::infinity();
    while (!pending.empty() && pending.top().score <= cutoff) {
        auto node = pending.top(); pending.pop();
        if (node.range.minX_ == node.range.maxX_ && node.range.minY_ == node.range.maxY_) {
            selected.emplace_back(node.score, node.range.tile());
            if (selected.size() == static_cast<size_t>(limit)) cutoff = node.score;
        }
        else {
            auto [left, right] = mapget::CoverageQuery::split(node.range);
            enqueue(left, node.inside); enqueue(right, node.inside);
        }
    }
    std::ranges::sort(selected, [](auto const& a, auto const& b) {
        return a.first == b.first ? a.second.value() < b.second.value() : a.first < b.first;
    });
    std::vector<mapget::TileId> result;
    result.reserve(std::min(selected.size(), static_cast<size_t>(limit)));
    for (size_t i = 0; i < selected.size() && i < static_cast<size_t>(limit); ++i)
        result.push_back(selected[i].second);
    return result;
}
}
