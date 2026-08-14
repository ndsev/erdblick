#include <catch2/catch_test_macros.hpp>

#include "erdblick/style-filter-plan.h"
#include "mapget/model/info.h"

#include <nlohmann/json.hpp>

#include <algorithm>

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
        FeatureStyleRule::AnyFidelity);

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
        FeatureStyleRule::AnyFidelity);

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
        FeatureStyleRule::AnyFidelity);
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
        FeatureStyleRule::AnyFidelity);

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
        FeatureStyleRule::AnyFidelity);
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
        FeatureStyleRule::AnyFidelity);
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
