#include <catch2/catch_test_macros.hpp>
#include "erdblick/coverage-selection.h"
#include "erdblick/aabb.h"
#include <algorithm>
#include <set>

using namespace erdblick;

/** Exhaustive oracle uses the established camera score after coverage admission. */
static std::vector<mapget::TileId> exhaustive(Viewport const& vp, int level, int limit,
    mapget::CoverageQuery const* query)
{
    auto score = Wgs84AABB::radialDistancePrioFn({vp.camPosLon, vp.camPosLat}, vp.orientation);
    std::vector<mapget::TileId> result;
    for (auto range : mapget::CoverageQuery::viewportRanges(
            {vp.west, vp.south, vp.west + vp.width, vp.south + vp.height}, level))
        for (auto y = range.minY_; y <= range.maxY_; ++y)
            for (auto x = range.minX_; x <= range.maxX_; ++x) {
                auto tile = mapget::CoverageTileRange{x, y, x, y, level}.tile();
                if (!query || query->permits(tile)) result.push_back(tile);
            }
    std::ranges::sort(result, [&](auto a, auto b) {
        return score(a) == score(b) ? a.value() < b.value() : score(a) < score(b);
    });
    if (result.size() > static_cast<size_t>(limit)) result.resize(limit);
    return result;
}

TEST_CASE("Coverage selection matches exhaustive priority after intersection", "[coverage-selection]")
{
    mapget::LayerInfo layer;
    layer.coverageComplete_ = true;
    layer.spatialExtent_ = std::vector<mapget::SpatialExtent>{
        {{-70, -60, 50, 60}, std::vector<std::array<double, 2>>{{-70,-60},{50,-60},{50,60},{-70,60}},
            {{{-25,-20},{-25,20},{25,20},{25,-20}}}},
        {{170,-45,-170,45}}};
    mapget::CoverageQuery query(layer);
    REQUIRE(query.complete());
    for (auto const vp : std::vector<Viewport>{{-90,-180,360,180,0,0,0},
            {-20,175,350,60,-179,0,1.3}, {-80,-40,45,65,-30,-70,4.2},
            {0,120,10,10,0,0,0}, {-80,-180,360,160,175,70,6.1}})
        for (int level = 0; level < 6; ++level)
            for (int limit : {1, 5, 60, 10000})
                for (auto coverage : {&query, static_cast<mapget::CoverageQuery*>(nullptr)}) {
                    auto expected = exhaustive(vp, level, limit, coverage);
                    auto actual = selectCoverageTiles(vp, level, limit, coverage);
                    CHECK(actual == expected);
                    CHECK(std::set<mapget::TileId>(actual.begin(), actual.end()).size() == actual.size());
                }
}

TEST_CASE("A distant eligible island receives capacity at the finest level", "[coverage-selection]")
{
    mapget::LayerInfo layer;
    layer.coverageComplete_ = true;
    layer.spatialExtent_ = std::vector<mapget::SpatialExtent>{{{100, 40, 101, 41}}};
    mapget::CoverageQuery query(layer);
    Viewport vp{-85, -180, 360, 170, 0, 0, 0};
    auto selected = selectCoverageTiles(vp, 15, 200, &query);
    REQUIRE(selected.size() == 200);
    for (auto tile : selected) CHECK(query.permits(tile));
    layer.spatialExtent_->clear();
    mapget::CoverageQuery empty(layer);
    CHECK(selectCoverageTiles(vp, 15, 200, &empty).empty());
    layer.coverageComplete_ = false;
    mapget::CoverageQuery unknown(layer);
    CHECK(selectCoverageTiles(vp, 15, 200, &unknown) == selectCoverageTiles(vp, 15, 200));
}
