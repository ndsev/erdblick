#include <catch2/catch_test_macros.hpp>
#include "erdblick/parser.h"

namespace
{
/** Small legacy catalogue uses the same normalization as incoming source metadata. */
nlohmann::json source(std::string const& map, nlohmann::json extents, bool complete = true)
{
    nlohmann::json layer = {
        {"type", "Features"}, {"featureTypes", nlohmann::json::array()},
        {"spatialExtent", std::move(extents)}, {"coverageComplete", complete}};
    return {{"mapId", map}, {"stringPoolId", map}, {"layers", {{"Road", std::move(layer)}}}};
}

/** Exercise the transactional delta boundary, including its exception guarantees. */
void change(erdblick::TileLayerParser& parser, nlohmann::json removed, nlohmann::json added)
{
    parser.applyDataSourceChanges(erdblick::SharedUint8Array(
        nlohmann::json{{"removedMapIds", std::move(removed)}, {"addedSources", std::move(added)}}.dump()));
}
}

TEST_CASE("Coverage summaries retain unknown and complete-empty semantics", "[erdblick.coverage]")
{
    erdblick::TileLayerParser parser;
    auto missing = parser.coverageSummary("Missing", "Road");
    CHECK_FALSE(missing.complete);
    CHECK(missing.valid);
    CHECK_FALSE(missing.hasBounds);
    CHECK(missing.regionCount == 0);

    change(parser, nlohmann::json::array(), {source("Empty", nlohmann::json::array())});
    auto empty = parser.coverageSummary("Empty", "Road");
    CHECK(empty.complete);
    CHECK(empty.valid);
    CHECK_FALSE(empty.hasBounds);
    CHECK(empty.regionCount == 0);
    CHECK(parser.coverageDisplayBounds("Empty", "Road", -1, 13).empty());
}

TEST_CASE("Coverage queries follow accepted map deltas without retiring unrelated owners", "[erdblick.coverage]")
{
    erdblick::TileLayerParser parser;
    auto first = source("First", {{{"bounds", {10, 40, 11, 41}}}});
    change(parser, nlohmann::json::array(), {first});
    auto const* retained = parser.coverageQuery("First", "Road");
    REQUIRE(retained);
    CHECK(parser.coverageSummary("First", "Road").hasBounds);

    change(parser, nlohmann::json::array(), {source("Other", {{{"bounds", {-10, -41, -9, -40}}}})});
    CHECK(parser.coverageQuery("First", "Road") == retained);
    change(parser, {"Other"}, nlohmann::json::array());
    CHECK(parser.coverageQuery("First", "Road") == retained);
    CHECK_FALSE(parser.coverageSummary("Other", "Road").hasBounds);

    auto rejected = first;
    rejected["schemaId"] = "schema-not-installed";
    CHECK_THROWS(change(parser, {"First"}, {rejected}));
    CHECK(parser.coverageQuery("First", "Road") == retained);
    CHECK(parser.coverageSummary("First", "Road").hasBounds);

    change(parser, {"First"}, {source("First", nlohmann::json::array())});
    CHECK(parser.coverageSummary("First", "Road").complete);
    CHECK_FALSE(parser.coverageSummary("First", "Road").hasBounds);
    parser.setDataSourceInfo(erdblick::SharedUint8Array(nlohmann::json::array({first}).dump()));
    CHECK(parser.coverageSummary("First", "Road").hasBounds);
    CHECK(parser.coverageSummary("First", "Road").regionCount == 1);
}
