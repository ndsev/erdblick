#include <catch2/catch_test_macros.hpp>

#include "erdblick/subset-renderer.h"
#include "mapget/model/info.h"
#include "mapget/model/stringpool.h"
#include "mapget/model/subsetlayer.h"

#include <nlohmann/json.hpp>

#include <cmath>

using namespace erdblick;

namespace
{

std::shared_ptr<mapget::LayerInfo> rendererLayerInfo()
{
    return mapget::LayerInfo::fromJson(
        nlohmann::json::parse(R"json(
        {
            "layerId": "Road",
            "type": "Features",
            "featureTypes": [
                {
                    "name": "Road",
                    "uniqueIdCompositions": [[
                        {"partId": "roadId", "datatype": "U64"}
                    ]]
                }
            ]
        })json"));
}

mapget::model_ptr<mapget::GeometryCollection> lineGeometry(
    mapget::TileSubsetLayer& layer,
    std::string_view name)
{
    auto collection = layer.newGeometryCollection(1, true);
    auto geometry = layer.newGeometry(
        mapget::GeomType::Line,
        2,
        true);
    geometry->setName(name);
    geometry->append({11.0, 48.0, 0.0});
    geometry->append({11.001, 48.001, 0.0});
    collection->addGeometry(geometry);
    return collection;
}

FeatureLayerStyle rendererStyle(std::string_view source)
{
    return FeatureLayerStyle(
        SharedUint8Array(std::string(source)));
}

} // namespace

TEST_CASE(
    "TileSubsetLayerRenderer consumes projected color scales and emits tuple picks",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererPool",
        "TestMap",
        info,
        strings,
        "roads",
        3);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{7}}});
    std::vector<std::string> featureFields{"roadClass"};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        featureFields);
    std::vector<simfil::ModelNode::Ptr> featureValues{
        subset->newValue(int64_t{2}),
    };
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        featureValues);

    auto style = rendererStyle(R"yaml(
name: SubsetRenderer
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    width: 4
    glow: {color: "#102030", radius: 5, opacity: 0.5}
    color-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, "#ff0000"]
        - [2, "#00ff00"]
      fallback: "#0000ff"
    width-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, 2]
        - [2, 6]
      fallback: 1
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto result = renderer.renderResult();
    REQUIRE(renderer.abiVersion() == 4);
    REQUIRE(renderer.vertexCount() == 2);
    REQUIRE(result["pathWorld"]["positions"].size() == 6);
    REQUIRE(result["pathWorld"]["colors"] == "AP8A/wD/AP8=");
    REQUIRE(result["pathWorld"]["widths"][0] == 6.0);
    REQUIRE(result["pathWorld"]["glowColors"] == "ECAwgA==");
    REQUIRE(result["pathWorld"]["glowRadii"] ==
        nlohmann::json::array({5.0}));
    REQUIRE(result["pathWorld"]["featureAddresses"][0] == 0);
    REQUIRE(result["pickRefs"] == nlohmann::json::array({0, 0, 0, 0}));
    REQUIRE(result["pickResults"][0]["subsetOrdinal"] == 0);
    REQUIRE(result["pickResults"][0]["featureId"] == "Road.7");
    REQUIRE(renderer.runtimeStyleIssues().empty());

    TileSubsetLayerRenderer blockRenderer(
        0,
        "z13/d1/p0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    blockRenderer.addTileSubsetLayer(TileSubsetLayer(subset));
    blockRenderer.addTileSubsetLayer(TileSubsetLayer(subset));
    blockRenderer.run();
    auto blockResult = blockRenderer.renderResult();
    REQUIRE(blockResult["pathWorld"]["featureAddresses"].size() == 2);
    REQUIRE(blockResult["pathWorld"]["featureAddresses"][0] == 0);
    REQUIRE(blockResult["pathWorld"]["featureAddresses"][1] == 1);
    REQUIRE(blockResult["pickResults"][0]["subsetOrdinal"] == 0);
    REQUIRE(blockResult["pickResults"][1]["subsetOrdinal"] == 1);
    REQUIRE(blockResult["subsetVertexCounts"] ==
        nlohmann::json::array({2, 2}));
}

TEST_CASE(
    "TileSubsetLayerRenderer rejects geometry with the wrong semantic name",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererNamePool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererNamePool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{8}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "topology"),
        {});

    auto style = rendererStyle(R"yaml(
name: SemanticGeometry
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(renderer.renderResult()["pathWorld"]["positions"].empty());
}

TEST_CASE(
    "TileSubsetLayerRenderer labels each semantic relation endpoint once",
    "[erdblick.subset-renderer][relation]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRelationLabelPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRelationLabelPool",
        "TestMap",
        info,
        strings,
        "relations",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto endpointGeometry = [&](double longitude) {
        auto collection = subset->newGeometryCollection(2, true);
        for (double latitude : {48.0, 48.0001}) {
            auto geometry = subset->newGeometry(
                mapget::GeomType::Line,
                2,
                true);
            geometry->setName("centerline");
            geometry->append({longitude, latitude, 0.0});
            geometry->append({longitude + 0.0001, latitude, 0.0});
            collection->addGeometry(geometry);
        }
        return collection;
    };
    auto road1 = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto road2 = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto road3 = subset->newFeatureId("Road", {{"roadId", int64_t{3}}});
    std::vector<std::string> endpointFields{"endpointLabel"};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Relation,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        endpointFields);
    auto endpoint = [&](mapget::model_ptr<mapget::FeatureId> const& featureId,
                        std::string_view label,
                        double longitude) {
        std::vector<simfil::ModelNode::Ptr> values{
            subset->newValue(label),
        };
        return channel->newFeatureEntry(
            featureId,
            endpointGeometry(longitude),
            values);
    };
    auto source1 = endpoint(road1, "1", 11.0);
    auto target2 = endpoint(road2, "2", 11.001);
    // Deliberately materialize the same semantic endpoint a second time to
    // cover both defensive renderer de-duplication and source/target role
    // changes in a recursive relation graph.
    auto source2 = endpoint(road2, "2", 11.001);
    auto target3 = endpoint(road3, "3", 11.002);
    channel->newRelationEntry(
        "Road.1/connectedTo/0",
        "connectedTo",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source1,
        target2,
        source1->geometry(),
        target2->geometry());
    channel->newRelationEntry(
        "Road.2/connectedTo/0",
        "connectedTo",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source2,
        target3,
        source2->geometry(),
        target3->geometry());

    auto style = rendererStyle(R"yaml(
name: RelationEndpointLabels
version: 2
rules:
  - type: Road
    scope: relation
    relation-type: connectedTo
    geometry: line
    width: 0
    relation-source-style:
      geometry: line
      geometry-name: centerline
      opacity: 0
      billboard: true
      label-text-expression: endpointLabel
    relation-target-style:
      geometry: line
      geometry-name: centerline
      opacity: 0
      billboard: true
      label-text-expression: endpointLabel
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto const labels = renderer.renderResult()["labelBillboard"];
    REQUIRE(labels.size() == 3);
    REQUIRE(labels[0]["text"] == "1");
    REQUIRE(labels[1]["text"] == "2");
    REQUIRE(labels[2]["text"] == "3");
}

TEST_CASE(
    "TileSubsetLayerRenderer offsets every terminal attribute validity entry",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererValidityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererValidityPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        0,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        1,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");

    auto style = rendererStyle(R"yaml(
name: ValidityOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    offset-increment: [0, 0, 5]
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto result = renderer.renderResult();
    auto const& positions = result["pathWorld"]["positions"];
    REQUIRE(positions.size() == 12);
    REQUIRE(positions[2] == 0.0);
    REQUIRE(positions[5] == 0.0);
    REQUIRE(positions[8] == 5.0);
    REQUIRE(positions[11] == 5.0);
}

TEST_CASE(
    "TileSubsetLayerRenderer stacks shared validity line segments independently",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererSegmentStackPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererSegmentStackPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    auto transitionGeometry =
        [&](std::array<mapget::Point, 3> const& points) {
            auto collection = subset->newGeometryCollection(1, true);
            auto geometry = subset->newGeometry(
                mapget::GeomType::Line,
                3,
                true);
            geometry->setName("centerline");
            for (auto const& point : points) {
                geometry->append(point);
            }
            collection->addGeometry(geometry);
            return collection;
        };
    channel->newAttributeValidityEntry(
        featureId,
        transitionGeometry({{
            {10.999, 48.0, 0.0},
            {11.0, 48.0, 0.0},
            {11.001, 48.0, 0.0},
        }}),
        0,
        true,
        0,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");
    channel->newAttributeValidityEntry(
        featureId,
        transitionGeometry({{
            {11.001, 48.0, 0.0},
            {11.0, 48.0, 0.0},
            {11.0, 47.999, 0.0},
        }}),
        0,
        true,
        1,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");

    auto style = rendererStyle(R"yaml(
name: SegmentValidityOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    offset: [2, 0, 0]
    offset-increment: [2, 0, 0]
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto const result = renderer.renderResult();
    auto const& starts = result["pathWorld"]["startIndices"];
    auto const& positions = result["pathWorld"]["positions"];
    REQUIRE(starts.size() == 3);
    REQUIRE(starts[0] == 0);
    REQUIRE(starts[1].get<size_t>() > 2);
    REQUIRE(starts[2].get<size_t>() > starts[1].get<size_t>() + 2);
    // The shared east/west link is traversed in opposite directions.  A
    // positive authored offset is relative to each transition's visible
    // traversal, so the two occurrences occupy opposite physical sides.  The
    // later transition still reserves the next lane for the shared leg.
    auto rightmostY = [&](size_t pathIndex) {
        auto const begin = starts[pathIndex].get<size_t>();
        auto const end = starts[pathIndex + 1].get<size_t>();
        auto rightmostX = positions[begin * 3].get<double>();
        auto y = positions[begin * 3 + 1].get<double>();
        for (auto pointIndex = begin + 1; pointIndex < end; ++pointIndex) {
            auto const x = positions[pointIndex * 3].get<double>();
            if (x > rightmostX) {
                rightmostX = x;
                y = positions[pointIndex * 3 + 1].get<double>();
            }
        }
        return y;
    };
    auto const firstSharedRightY = rightmostY(0);
    auto const secondSharedRightY = rightmostY(1);
    REQUIRE(firstSharedRightY * secondSharedRightY < 0.0);
    REQUIRE(std::abs(secondSharedRightY) > std::abs(firstSharedRightY));
}

TEST_CASE(
    "TileSubsetLayerRenderer diagnoses entries which match no concrete rule",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRuleMatchPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRuleMatchPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{9}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: RuleMismatch
version: 2
rules:
  - type: Lane
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    auto issues = renderer.runtimeStyleIssues();
    REQUIRE(issues.size() == 1);
    REQUIRE(issues[0]["property"] == "rule-match");
    REQUIRE(issues[0]["expression"] == "Road");
}

TEST_CASE(
    "TileSubsetLayerRenderer stacks typed transition legs by physical road side",
    "[erdblick.subset-renderer][transition]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererTypedTransitionPool");
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId::fromWgs84(11.0, 48.0, 13),
        "SubsetRendererTypedTransitionPool",
        "TestMap",
        info,
        strings,
        "transitions",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});
    auto host = subset->newFeatureId("Road", {{"roadId", int64_t{11}}});
    auto from = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto toRight = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto toSharperRight = subset->newFeatureId("Road", {{"roadId", int64_t{3}}});
    auto toLeft = subset->newFeatureId("Road", {{"roadId", int64_t{5}}});
    auto hairpinHost = subset->newFeatureId("Road", {{"roadId", int64_t{21}}});
    auto hairpinFrom = subset->newFeatureId("Road", {{"roadId", int64_t{22}}});
    auto hairpinTo = subset->newFeatureId("Road", {{"roadId", int64_t{23}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    auto geometry = [&](mapget::Point const& outerTo) {
        auto collection = subset->newGeometryCollection(1, true);
        auto line = subset->newGeometry(mapget::GeomType::Line, 5, true);
        line->setName("centerline");
        for (auto const& point : {
                 mapget::Point{10.9999, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 outerTo})
        {
            line->append(point);
        }
        collection->addGeometry(line);
        return collection;
    };
    channel->newAttributeValidityEntry(
        host,
        geometry({11.0, 47.9999, 0.0}),
        0,
        true,
        0,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toRight,
        mapget::ValidityData::Start,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({10.99995, 47.9999, 0.0}),
        0,
        true,
        1,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toSharperRight,
        mapget::ValidityData::Start,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({11.0, 48.0001, 0.0}),
        0,
        true,
        2,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toLeft,
        mapget::ValidityData::End,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({10.9999, 48.0, 0.0}),
        0,
        true,
        3,
        4,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        from,
        mapget::ValidityData::End,
        2);
    channel->newAttributeValidityEntry(
        hairpinHost,
        geometry({10.9999, 48.00002, 0.0}),
        0,
        true,
        0,
        1,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        hairpinFrom,
        mapget::ValidityData::End,
        hairpinTo,
        mapget::ValidityData::Start,
        2);

    auto style = rendererStyle(R"yaml(
name: TypedTransitionOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
    offset: [2, 0, 0]
    offset-increment: [2, 0, 0]
    lateral-offset-unit: px
    arrow: forward
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();
    auto const result = renderer.renderResult();
    auto const& starts = result["transitionPathWorld"]["startIndices"];
    auto const& offsets =
        result["transitionPathWorld"]["lateralOffsetsPx"];
    REQUIRE(starts.size() == 6);
    auto pathStartOffset = [&](size_t pathIndex) {
        return offsets[starts[pathIndex].get<size_t>()].get<float>();
    };
    auto pathEndOffset = [&](size_t pathIndex) {
        return offsets[starts[pathIndex + 1].get<size_t>() - 1].get<float>();
    };
    // The first two maneuvers are right turns. Their common incoming road's
    // physical right-side stack advances independently of either outgoing
    // road, which starts at its own first slot.
    REQUIRE(pathStartOffset(0) == 2.0f);
    REQUIRE(pathEndOffset(0) == 2.0f);
    REQUIRE(pathStartOffset(1) == 4.0f);
    REQUIRE(pathEndOffset(1) == 2.0f);
    // A left turn takes the negative (left-of-traversal) side even though the
    // YAML's distance is positive. Reversed connected ends affect only the
    // canonical road-side key, not the visible turn side.
    REQUIRE(pathStartOffset(2) == -2.0f);
    REQUIRE(pathEndOffset(2) == -2.0f);
    // The U-turn occupies the common road's already-used canonical left and
    // right stacks independently. Its path remains left-of-traversal on both
    // legs while the magnitudes reflect the two distinct stack depths.
    REQUIRE(pathStartOffset(3) == -4.0f);
    REQUIRE(pathEndOffset(3) == -6.0f);
    auto const& scaleThresholds =
        result["transitionPathWorld"]["lateralOffsetScaleThresholds"];
    REQUIRE(scaleThresholds.size() == 5);
    // One host/rule uses one path-wide factor, including its U-turn. The
    // compact U-turn's correctly wound vector arc does not independently
    // reduce the lateral stack distance.
    auto const ordinaryScaleThreshold = scaleThresholds[0].get<float>();
    REQUIRE(ordinaryScaleThreshold > 0.0f);
    REQUIRE(scaleThresholds[1].get<float>() == ordinaryScaleThreshold);
    REQUIRE(scaleThresholds[2].get<float>() == ordinaryScaleThreshold);
    auto const uTurnScaleThreshold = scaleThresholds[3].get<float>();
    REQUIRE(uTurnScaleThreshold == ordinaryScaleThreshold);
    // A nearly reversing transition between different roads remains an
    // ordinary turn. It therefore contributes a real motion-derived safety
    // threshold instead of being misclassified as the compact U-turn above.
    auto const hairpinScaleThreshold = scaleThresholds[4].get<float>();
    REQUIRE(hairpinScaleThreshold > 0.0f);
    REQUIRE(hairpinScaleThreshold < ordinaryScaleThreshold);
    auto const& positions = result["transitionPathWorld"]["positions"];
    auto const uTurnStart = starts[3].get<size_t>();
    auto const uTurnEnd = starts[4].get<size_t>();
    auto const uTurnBaseY = positions[uTurnStart * 3 + 1].get<double>();
    auto maxUturnLateralDeparture = 0.0;
    for (auto pointIndex = uTurnStart + 1;
         pointIndex < uTurnEnd;
         ++pointIndex)
    {
        maxUturnLateralDeparture = std::max(
            maxUturnLateralDeparture,
            std::abs(
                positions[pointIndex * 3 + 1].get<double>() -
                uTurnBaseY));
    }
    // Pixel-offset U-turns keep the undisplaced bridge on the source road.
    // The screen-space vector stream below owns the visible hairpin. Mixing a
    // second world-space side loop into it creates zoom-dependent loops.
    REQUIRE(maxUturnLateralDeparture < 1.0e-5);
    auto const& offsetVectors =
        result["transitionPathWorld"]["lateralOffsetVectorsPx"];
    REQUIRE(offsetVectors.size() == positions.size() / 3 * 2);
    auto vectorAt = [&](size_t pointIndex) {
        return std::pair{
            offsetVectors[pointIndex * 2].get<float>(),
            offsetVectors[pointIndex * 2 + 1].get<float>(),
        };
    };
    // The first right turn starts south of its eastbound incoming road and
    // ends west of its southbound outgoing road.
    REQUIRE(vectorAt(starts[0].get<size_t>()) ==
        std::pair{0.0f, -2.0f});
    REQUIRE(vectorAt(starts[1].get<size_t>() - 1) ==
        std::pair{-2.0f, 0.0f});
    // The bridge rotates its screen-space road normal without shrinking the
    // authored lane radius. Component-wise interpolation would collapse a
    // right-angle lane below either endpoint and drive a U-turn through zero.
    auto vectorMagnitude = [&](size_t pointIndex) {
        auto const [x, y] = vectorAt(pointIndex);
        return std::hypot(x, y);
    };
    for (size_t pathIndex = 0; pathIndex + 1 < starts.size(); ++pathIndex) {
        auto const begin = starts[pathIndex].get<size_t>();
        auto const end = starts[pathIndex + 1].get<size_t>();
        auto const minimumMagnitude = std::min(
            std::abs(pathStartOffset(pathIndex)),
            std::abs(pathEndOffset(pathIndex)));
        auto const maximumMagnitude = std::max(
            std::abs(pathStartOffset(pathIndex)),
            std::abs(pathEndOffset(pathIndex)));
        for (auto pointIndex = begin; pointIndex < end; ++pointIndex) {
            REQUIRE(vectorMagnitude(pointIndex) >=
                minimumMagnitude - 1.0e-4f);
            REQUIRE(vectorMagnitude(pointIndex) <=
                maximumMagnitude + 1.0e-4f);
        }
    }
    // The U-turn bridge rotates between the two independently stacked sides
    // rather than deriving an offset from its projected curve radius.
    REQUIRE(vectorAt(uTurnStart) == std::pair{0.0f, 4.0f});
    REQUIRE(vectorAt(uTurnEnd - 1) == std::pair{0.0f, -6.0f});
    auto maximumUturnForwardOffset = 0.0f;
    auto minimumUturnForwardOffset = 0.0f;
    for (auto pointIndex = uTurnStart;
         pointIndex < uTurnEnd;
         ++pointIndex)
    {
        auto const [x, unusedY] = vectorAt(pointIndex);
        static_cast<void>(unusedY);
        maximumUturnForwardOffset = std::max(
            maximumUturnForwardOffset,
            x);
        minimumUturnForwardOffset = std::min(
            minimumUturnForwardOffset,
            x);
    }
    // The conventional left U-turn bows forward (east in this fixture). The
    // opposite winding bows backward and creates the inverted terminal hook.
    REQUIRE(maximumUturnForwardOffset > 3.0f);
    REQUIRE(minimumUturnForwardOffset >= -1.0e-4f);
    auto const& arrowOffsets =
        result["arrowWorld"]["lateralOffsetsPx"];
    REQUIRE(arrowOffsets.size() == 15);
    for (auto const& value : arrowOffsets) {
        REQUIRE(value.get<float>() == 0.0f);
    }
    auto const& arrowVectors =
        result["arrowWorld"]["lateralOffsetVectorsPx"];
    REQUIRE(arrowVectors.size() == 30);
    auto arrowTipVector = [&](size_t pathIndex) {
        auto const tipVertex = pathIndex * 3 + 1;
        return std::pair{
            arrowVectors[tipVertex * 2].get<float>(),
            arrowVectors[tipVertex * 2 + 1].get<float>(),
        };
    };
    REQUIRE(arrowTipVector(0) == std::pair{-2.0f, 0.0f});
    REQUIRE(arrowTipVector(3) == std::pair{0.0f, -6.0f});
    auto const& arrowScaleThresholds =
        result["arrowWorld"]["lateralOffsetScaleThresholds"];
    REQUIRE(arrowScaleThresholds.size() == 5);
    for (size_t pathIndex = 0; pathIndex < 5; ++pathIndex) {
        REQUIRE(arrowScaleThresholds[pathIndex].get<float>() ==
            scaleThresholds[pathIndex].get<float>());
    }
}

TEST_CASE(
    "TileSubsetLayerRenderer silently skips an inactive fidelity channel",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererFidelityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererFidelityPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{10}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: FidelitySwitch
version: 2
rules:
  - type: Road
    fidelity: low
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::HighFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(renderer.runtimeStyleIssues().empty());
}
