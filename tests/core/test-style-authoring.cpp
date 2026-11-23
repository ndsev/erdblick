#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "erdblick/style-authoring.h"
#include "erdblick/style-filter-plan.h"
#include "erdblick/subset-renderer.h"
#include "mapget/model/featurelayer-filter.h"
#include "mapget/model/validity.h"

using namespace erdblick;

namespace {

/** Builds two ranges, an attribute without validity, and two excluded matches. */
mapget::PartitionFeatureLayer::Ptr searchStyleSource(bool includeSingleValueAttributes = true)
{
    auto info = mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json({
        "layerId":"Road", "type":"Features", "featureTypes":[
          {"name":"Road","uniqueIdCompositions":[[{"partId":"id","datatype":"U32"}]]},
          {"name":"Other","uniqueIdCompositions":[[{"partId":"id","datatype":"U32"}]]}
        ]
    })json"));
    auto strings = std::make_shared<mapget::StringPool>("StyleSearch");
    auto source = std::make_shared<mapget::PartitionFeatureLayer>(
        mapget::TileId::fromWgs84(11., 48., 13), "StyleSearch", "Map", info, strings);
    for (auto type : {"Road", "Other"}) {
        auto feature = source->newFeature(type, {{"id", int64_t{1}}});
        auto line = feature->geom()->newGeometry(mapget::GeomType::Line, 5, true);
        for (int i = 0; i < 5; ++i) line->append({11. + i * .001, 48., 0.});
        auto layer = feature->attributeLayers()->newLayer("rules");
        auto speed = layer->newAttribute("speed");
        speed->addField("speedLimitKmh", source->newValue(int64_t{90}));
        auto nested = source->newObject();
        nested->addField("speedLimitKmh", source->newValue(int64_t{100}));
        speed->addField("details", nested);
        speed->validity()->newRange(mapget::Validity::BufferOffset, int32_t{1}, int32_t{2});
        speed->validity()->newRange(mapget::Validity::BufferOffset, int32_t{3}, int32_t{4});
        if (!includeSingleValueAttributes) continue;
        auto whole = layer->newAttribute("speed");
        whole->addField("speedLimitKmh", source->newValue(int64_t{100}));
        auto slow = layer->newAttribute("speed");
        slow->addField("speedLimitKmh", source->newValue(int64_t{20}));
    }
    return source;
}

}

TEST_CASE("Saved attribute membership renders its matched validity ranges", "[erdblick.style-authoring]")
{
    auto source = searchStyleSource();
    std::string query = "speedLimitKmh > 80";
    size_t expected = 3;
    bool enabled = true;
    SECTION("all validities and no-validity fallback") {}
    SECTION("one matching validity") { query += " and $hasValidity and $validityIndex == 1"; expected = 1; }
    SECTION("disabled option") { enabled = false; expected = 0; }
    SECTION("multi-valued wildcard query") { query = "**.speedLimitKmh > 80"; }

    auto text = std::string(R"yaml(
name: Saved attribute search
version: 2
category: search
options: [{id: showSearchStyle, type: bool, default: true}]
rules:
  - scope: attribute
    geometry: line
    color: red
    width: 4
    attribute-filter: showSearchStyle == true and (any($name == "speed") and any()yaml")
        + query + R"yaml() and any($feature.typeId == "Road"))
)yaml";
    FeatureLayerStyle style{SharedUint8Array(text)};
    REQUIRE(style.isValid());
    auto plan = planStyleFilter(style, *source->layerInfo(), FeatureStyleRule::NoHighlight, FeatureStyleRule::kMaximumLod);
    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1);
    mapget::FeatureLayerFilterRequest request{
        .filterId_ = "saved-search",
        .generation_ = 1,
        .channels_ = plan.channels,
        .bindings_ = {{"showSearchStyle", enabled}}
    };
    auto filtered = request.filter(*source);
    REQUIRE(filtered);
    REQUIRE(*filtered);
    auto channel = (*filtered)->at(0);
    REQUIRE(channel->attributeValidityEntryCount() == expected);
    channel->forEachAttributeValidityEntry([&](auto const& entry) {
        entry->geometry()->forEachGeometry([&](auto const& geometry) {
            auto points = geometry->toSelfContained().points_;
            if (!entry->hasValidity()) {
                CHECK(points.size() == 5);
            } else {
                REQUIRE(points.size() == 2);
                auto first = entry->validityIndex() == 0 ? 1 : 3;
                CHECK(points.front().x == Catch::Approx(11. + first * .001).margin(1e-8));
                CHECK(points.back().x == Catch::Approx(11. + (first + 1) * .001).margin(1e-8));
            }
            return true;
        });
        return true;
    });
    TileSubsetLayerRenderer renderer(0, "Features:Map:Road:0", style,
        static_cast<int>(FeatureStyleRule::NoHighlight), FeatureStyleRule::kMaximumLod);
    renderer.addTileSubsetContribution(TileSubsetLayer(*filtered), 1U, 0U, 0U, 0U, 1U);
    renderer.run();
    CHECK((renderer.vertexCount() > 0) == (expected > 0));
}

TEST_CASE("A lone multivalued attribute predicate projects one renderer value", "[erdblick.style-authoring]")
{
    auto source = searchStyleSource(false);
    FeatureLayerStyle style{SharedUint8Array(std::string(R"yaml(
name: Wildcard search
version: 2
rules:
  - scope: attribute
    geometry: line
    attribute-filter: any(**.speedLimitKmh)
    color: blue
)yaml"))};
    REQUIRE(style.isValid());
    auto plan = planStyleFilter(style, *source->layerInfo(), FeatureStyleRule::NoHighlight, FeatureStyleRule::kMaximumLod);
    REQUIRE(plan.valid);
    mapget::FeatureLayerFilterRequest request{.filterId_ = "wildcard", .generation_ = 1, .channels_ = plan.channels};
    auto filtered = request.filter(*source);
    REQUIRE(filtered);
    REQUIRE(*filtered);
    REQUIRE((*filtered)->at(0)->attributeValidityEntryCount() == 4);
    TileSubsetLayerRenderer renderer(0, "Features:Map:Road:0", style,
        static_cast<int>(FeatureStyleRule::NoHighlight), FeatureStyleRule::kMaximumLod);
    renderer.addTileSubsetContribution(TileSubsetLayer(*filtered), 1U, 0U, 0U, 0U, 1U);
    renderer.run();
    CHECK(renderer.vertexCount() > 0);
}

TEST_CASE("Authoring geometry choices agree with native acceptance", "[erdblick.style-authoring]")
{
    for (auto const& geometry : styleAuthoringEnumValues("rule", "geometry")) {
        FeatureLayerStyle style{SharedUint8Array(std::string("name: Choice\nversion: 2\nrules: [{geometry: ") + geometry + "}]\n")};
        INFO(geometry);
        CHECK(style.isValid());
    }
    FeatureLayerStyle invalid{SharedUint8Array(std::string("name: Invalid\nversion: 2\nrules: [{geometry: invented}]\n"))};
    CHECK_FALSE(invalid.isValid());
}

TEST_CASE("Shape-point rule branches reject options that require an attribute or relation entry",
          "[erdblick.style-authoring][shapepoint]")
{
    auto accepts = [](std::string const& branch) {
        FeatureLayerStyle style{SharedUint8Array(
            "name: Vertices\nversion: 2\nrules:\n  - scope: shapepoint\n    geometry: line\n    all-of:\n      - " +
            branch + "\n")};
        return style.isValid();
    };
    CHECK(accepts("color: blue"));
    CHECK(accepts("point-filter: $pointIndex == 2"));
    CHECK_FALSE(accepts("relation-line-geometry: centers"));
    CHECK_FALSE(accepts("attribute-validity-geom: required"));
}

TEST_CASE("A style can select original vertices before sending them to the renderer",
          "[erdblick.style-authoring][shapepoint]")
{
    auto source = searchStyleSource();
    FeatureLayerStyle style{SharedUint8Array(std::string(R"yaml(
name: Third vertex
version: 2
rules:
  - type: Road
    scope: shapepoint
    geometry: line
    point-filter: $pointIndex == 2
    color: blue
)yaml"))};
    REQUIRE(style.isValid());
    auto plan = planStyleFilter(style, *source->layerInfo(), FeatureStyleRule::NoHighlight, FeatureStyleRule::kMaximumLod);
    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1);
    REQUIRE(plan.channels[0].entryFilter_ == "$pointIndex == 2");
    auto result = mapget::FeatureLayerFilterRequest{.filterId_ = "third", .generation_ = 1, .channels_ = plan.channels}.filter(*source);
    REQUIRE(result);
    REQUIRE(*result);
    auto entries = (*result)->at(0);
    REQUIRE(entries->shapePointEntryCount() == 1);
    CHECK(entries->shapePointEntryAt(0)->pointIndex() == 2);
}
