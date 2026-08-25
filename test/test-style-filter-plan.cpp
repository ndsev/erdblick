#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "erdblick/style-filter-plan.h"
#include "mapget/model/info.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>

using namespace erdblick;

namespace
{

std::shared_ptr<mapget::LayerInfo> plannerLayerInfo()
{
    return mapget::LayerInfo::fromJson(
        nlohmann::json::parse(R"json(
        {
            "layerId": "TestLayer",
            "type": "Features",
            "featureTypes": [
                {
                    "name": "Road",
                    "uniqueIdCompositions": [[
                        {"partId": "id", "datatype": "U32"}
                    ]]
                },
                {
                    "name": "POI",
                    "uniqueIdCompositions": [[
                        {"partId": "id", "datatype": "U32"}
                    ]]
                }
            ]
        })json"));
}

FeatureLayerStyle style(std::string_view source)
{
    return FeatureLayerStyle(
        SharedUint8Array(std::string(source)));
}

}

TEST_CASE(
    "Style schema version 2 accepts a minimal rule",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Minimal
version: 2
rules:
  - geometry: line
    color: "#ff0000"
)yaml");
    REQUIRE(parsed.isValid());
}

TEST_CASE(
    "Style fidelity is parsed only as canonical LOD range shorthand",
    "[erdblick.style-plan][lod]")
{
    auto parsed = style(R"yaml(
name: FidelityShorthand
version: 2
rules:
  - type: Road
    geometry: line
    fidelity: low
  - type: Road
    geometry: line
    fidelity: high
  - type: Road
    geometry: line
    fidelity: any
  - type: Road
    geometry: line
)yaml");
    REQUIRE(parsed.isValid());
    REQUIRE(parsed.rules().size() == 4U);
    CHECK(parsed.rules()[0].lodRange().minimum == 0U);
    CHECK(parsed.rules()[0].lodRange().maximum == 2U);
    CHECK(parsed.rules()[1].lodRange().minimum == 3U);
    CHECK(parsed.rules()[1].lodRange().maximum == 7U);
    CHECK(parsed.rules()[2].lodRange().minimum == 0U);
    CHECK(parsed.rules()[2].lodRange().maximum == 7U);
    CHECK(parsed.rules()[3].lodRange().minimum == 0U);
    CHECK(parsed.rules()[3].lodRange().maximum == 7U);
}

TEST_CASE(
    "Style filter ownership changes only at authored LOD range boundaries",
    "[erdblick.style-plan][lod]")
{
    auto parsed = style(R"yaml(
name: LodRanges
version: 2
rules:
  - type: Road
    geometry: line
    lod-range: [0, 2]
  - type: Road
    geometry: line
    lod-range: [3, 7]
)yaml");
    REQUIRE(parsed.isValid());

    auto const overview = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        2U);
    auto const detail = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        3U);

    REQUIRE(overview.valid);
    REQUIRE(detail.valid);
    REQUIRE(overview.channels.size() == 1U);
    REQUIRE(detail.channels.size() == 1U);
    CHECK(overview.channels[0].channelId_ == "style-rule:0");
    CHECK(detail.channels[0].channelId_ == "style-rule:1");
}

TEST_CASE(
    "Style LOD authoring rejects ambiguous and malformed declarations",
    "[erdblick.style-plan][lod]")
{
    SECTION("fidelity and lod-range") {
        auto parsed = style(R"yaml(
name: AmbiguousLod
version: 2
rules:
  - geometry: line
    fidelity: low
    lod-range: [0, 2]
)yaml");
        CHECK_FALSE(parsed.isValid());
    }
    SECTION("nested lod-range") {
        auto parsed = style(R"yaml(
name: NestedLod
version: 2
rules:
  - geometry: line
    all-of:
      - lod-range: [0, 2]
        color: red
)yaml");
        CHECK_FALSE(parsed.isValid());
    }
    SECTION("threshold count") {
        auto parsed = style(R"yaml(
name: InvalidThresholds
version: 2
lod-thresholds: [512, 256, 128]
rules:
  - geometry: line
)yaml");
        CHECK_FALSE(parsed.isValid());
    }
}

TEST_CASE(
    "Styles map canonical visible-tile density onto eight LODs",
    "[erdblick.style-plan][lod]")
{
    auto defaults = style(R"yaml(
name: DefaultThresholds
version: 2
rules:
  - geometry: line
)yaml");
    REQUIRE(defaults.isValid());
    CHECK(defaults.lodForVisibleTileCount(512U, 128U) == 0U);
    CHECK(defaults.lodForVisibleTileCount(511U, 128U) == 1U);
    CHECK(defaults.lodForVisibleTileCount(128U, 128U) == 2U);
    CHECK(defaults.lodForVisibleTileCount(127U, 128U) == 3U);
    CHECK(defaults.lodForVisibleTileCount(8U, 128U) == 6U);
    CHECK(defaults.lodForVisibleTileCount(7U, 128U) == 7U);
    CHECK(defaults.presentationLodForVisibleTileCount(512U, 128U) == 0.0);
    CHECK(defaults.presentationLodForVisibleTileCount(256U, 128U) == 1.0);
    CHECK(defaults.presentationLodForVisibleTileCount(192U, 128U) ==
        Catch::Approx(std::log2(512.0 / 192.0)));
    CHECK(defaults.presentationLodForVisibleTileCount(8U, 128U) == 6.0);
    CHECK(defaults.presentationLodForVisibleTileCount(4U, 128U) == 7.0);
    CHECK(defaults.presentationLodForVisibleTileCount(0U, 128U) == 7.0);

    auto overridden = style(R"yaml(
name: CustomThresholds
version: 2
lod-thresholds: [700, 600, 500, 400, 300, 200, 100]
rules:
  - geometry: line
)yaml");
    REQUIRE(overridden.isValid());
    CHECK(overridden.lodForVisibleTileCount(450U, 128U) == 3U);
    CHECK(overridden.lodForVisibleTileCount(99U, 128U) == 7U);
    CHECK(overridden.presentationLodForVisibleTileCount(450U, 128U) ==
        Catch::Approx(2.0 + std::log(500.0 / 450.0) /
            std::log(500.0 / 400.0)));
}

TEST_CASE(
    "Per-entry minimum LOD expressions are projected without changing channels",
    "[erdblick.style-plan][lod]")
{
    auto parsed = style(R"yaml(
name: DataDrivenLod
version: 2
rules:
  - type: Road
    geometry: line
    min-lod-expression: detailLod
)yaml");
    REQUIRE(parsed.isValid());
    auto const plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        4U);
    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1U);
    CHECK(std::ranges::find(
        plan.channels[0].featureFields_,
        "detailLod") != plan.channels[0].featureFields_.end());
}

TEST_CASE(
    "One style rule can serve hover and selection highlight passes",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Shared interaction rule
version: 2
rules:
  - type: Road
    scope: attribute
    mode: [hover, selection]
    geometry: line
    color: "#ff0000"
)yaml");
    REQUIRE(parsed.isValid());
    REQUIRE(parsed.supportsHighlightMode(FeatureStyleRule::HoverHighlight));
    REQUIRE(parsed.supportsHighlightMode(FeatureStyleRule::SelectionHighlight));
    REQUIRE_FALSE(parsed.supportsHighlightMode(FeatureStyleRule::NoHighlight));

    auto const hover = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::HoverHighlight,
        FeatureStyleRule::kMaximumLod);
    auto const selection = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::SelectionHighlight,
        FeatureStyleRule::kMaximumLod);

    REQUIRE(hover.valid);
    REQUIRE(selection.valid);
    REQUIRE(hover.channels.size() == 1);
    REQUIRE(selection.channels.size() == 1);
    REQUIRE(hover.channels[0].channelId_ == "style-rule:0");
    REQUIRE(selection.channels[0].channelId_ == "style-rule:0");
}

TEST_CASE(
    "Highlight mode lists reject unsupported values",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Invalid shared interaction rule
version: 2
rules:
  - mode: [hover, sometimes]
    geometry: line
)yaml");
    REQUIRE_FALSE(parsed.isValid());
}

TEST_CASE(
    "Flat search styles retain one planner channel per top-level rule",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Search/Flat
category: search
version: 2
default: false
rules:
  - geometry: line
    filter: speed > 20
    color: "#ff0000"
  - geometry: point
    filter: isJunction
    color: "#0000ff"
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);

    REQUIRE(plan.valid);
    REQUIRE(plan.issues.empty());
    REQUIRE(plan.channels.size() == 2);
    REQUIRE(plan.channels[0].channelId_ == "style-rule:0");
    REQUIRE(plan.channels[1].channelId_ == "style-rule:1");
}

TEST_CASE(
    "Style filter planning preserves rule channels and expression contexts",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Planner
version: 2
rules:
  - type: Road
    geometry: line
    filter: enabled
    all-of:
      - filter: speed > 20
        color-scale:
          mode: linear
          expression: speed
          stops:
            - [0, "#ff0000"]
            - [100, "#0000ff"]
        width-scale:
          mode: categorical
          expression: speed
          stops:
            - [0, 1]
            - [100, 4]
      - filter: toll
        label-text-expression: name
        z-index-expression: drawOrder
  - scope: attribute
    type: Road
    geometry: line
    filter: showAttributes
    attribute-filter: speedLimit > 80
    color-expression: colorValue
  - type: POI
    geometry: point
    point-merge-grid-cell: [1, 2, 3]
    filter: showPoints
    color-expression: "$mergeCount > 1 and '#ff0000' or '#0000ff'"
    label-text-expression: "$mergeCount as string"
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);

    REQUIRE(plan.valid);
    REQUIRE(plan.issues.empty());
    REQUIRE(plan.channels.size() == 3);

    auto const& feature = plan.channels[0];
    REQUIRE(feature.channelId_ == "style-rule:0");
    REQUIRE(
        feature.scope_ ==
        mapget::FeatureLayerFilterScope::Feature);
    REQUIRE(feature.featureTypes_ == std::vector<std::string>{"Road"});
    REQUIRE(feature.featureFilter_);
    REQUIRE(feature.featureFilter_->find("enabled") != std::string::npos);
    REQUIRE(feature.featureFilter_->find("speed > 20") != std::string::npos);
    REQUIRE(feature.featureFilter_->find("toll") != std::string::npos);
    REQUIRE(feature.entryFields_.empty());
    REQUIRE(feature.featureFields_.size() == 5);
    REQUIRE(std::ranges::none_of(
        feature.featureFields_,
        [](auto const& field) { return field == "any(enabled)"; }));
    REQUIRE(std::ranges::any_of(
        feature.featureFields_,
        [](auto const& field) { return field == "drawOrder"; }));

    auto const& attribute = plan.channels[1];
    REQUIRE(
        attribute.scope_ ==
        mapget::FeatureLayerFilterScope::Attribute);
    REQUIRE(attribute.featureFilter_);
    REQUIRE(attribute.entryFilter_);
    REQUIRE(attribute.featureFields_.size() == 1);
    REQUIRE(attribute.entryFields_.size() == 2);
    REQUIRE(attribute.featureFields_[0].find("showAttributes") != std::string::npos);
    REQUIRE(attribute.entryFields_[0] == "speedLimit > 80");

    auto const& group = plan.channels[2];
    REQUIRE(group.group_);
    REQUIRE(group.featureFields_.empty());
    REQUIRE(group.entryFields_.size() == 3);
    REQUIRE(
        group.entryFields_[1].find("count($features.*)") !=
        std::string::npos);
    REQUIRE(
        group.entryFields_[2] ==
        "count($features.*) as string");
}

TEST_CASE(
    "Style filter planning rejects attribute point grouping",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: InvalidAttributeGroup
version: 2
rules:
  - scope: attribute
    type: Road
    geometry: point
    point-merge-grid-cell: [1, 1, 1]
    color: "#ff0000"
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);
    REQUIRE_FALSE(plan.valid);
    REQUIRE(plan.channels.empty());
    REQUIRE(plan.issues.size() == 1);
}

TEST_CASE(
    "Style filter planning shares equivalent feature geometry channels",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: SharedFeatureGeometry
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    filter: enabled
    color-expression: casingColor
  - type: Road
    geometry: line
    geometry-name: centerline
    filter: enabled
    color-expression: fillColor
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);

    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1);
    REQUIRE(plan.channels[0].channelId_ == "style-rules:0,1");
    REQUIRE(plan.channels[0].featureFields_ ==
        std::vector<std::string>{"casingColor", "fillColor"});
}

TEST_CASE(
    "Point-group membership preserves branch-specific feature types",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: TypedGroup
version: 2
rules:
  - geometry: point
    point-merge-grid-cell: [1, 1, 1]
    all-of:
      - type: Road
        filter: roadVisible
        color: "#ff0000"
      - type: POI
        filter: poiVisible
        color: "#0000ff"
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);
    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1);
    REQUIRE(plan.channels[0].featureFilter_);
    REQUIRE(
        plan.channels[0].featureFilter_->find(
            "typeId == \"Road\"") !=
        std::string::npos);
    REQUIRE(
        plan.channels[0].featureFilter_->find(
            "typeId == \"POI\"") !=
        std::string::npos);
}

TEST_CASE(
    "Relation planning separates relation and endpoint expressions",
    "[erdblick.style-plan]")
{
    auto parsed = style(R"yaml(
name: Relations
version: 2
rules:
  - scope: relation
    type: Road
    geometry: line
    filter: $twoway
    relation-type: "next|previous"
    relation-recursive: true
    relation-merge-twoway: true
    color-expression: relationColor
    relation-line-end-markers:
      geometry: line
      color-expression: markerColor
    relation-source-style:
      geometry: line
      filter: sourceVisible
      label-text-expression: sourceName
    relation-target-style:
      geometry: point
      filter: targetVisible
      label-text-expression: targetName
)yaml");
    REQUIRE(parsed.isValid());

    auto plan = planStyleFilter(
        parsed,
        *plannerLayerInfo(),
        FeatureStyleRule::NoHighlight,
        FeatureStyleRule::kMaximumLod);
    REQUIRE(plan.valid);
    REQUIRE(plan.channels.size() == 1);

    auto const& relation = plan.channels[0];
    REQUIRE(
        relation.scope_ ==
        mapget::FeatureLayerFilterScope::Relation);
    REQUIRE(relation.entryFilter_ == "any($twoway)");
    REQUIRE(relation.relation_);
    REQUIRE(
        relation.relation_->relationNamePattern_ ==
        "next|previous");
    REQUIRE(relation.relation_->recursive_);
    REQUIRE(relation.relation_->mergeTwoway_);
    REQUIRE(
        std::ranges::find(
            relation.entryFields_,
            "markerColor") !=
        relation.entryFields_.end());
    REQUIRE(
        std::ranges::find(
            relation.featureFields_,
            "any(sourceVisible)") !=
        relation.featureFields_.end());
    REQUIRE(
        std::ranges::find(
            relation.featureFields_,
            "targetName") !=
        relation.featureFields_.end());
}

TEST_CASE(
    "Merge-count expansion respects identifier boundaries",
    "[erdblick.style-plan]")
{
    REQUIRE(
        expandStyleExpressionForFilter(
            "$mergeCount > 1 and object.$mergeCounter") ==
        "count($features.*) > 1 and object.$mergeCounter");
}
