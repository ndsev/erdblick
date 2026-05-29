#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/rule.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"
#include "mapget/model/searchresultlayer.h"
#include "mapget/model/stringpool.h"
#include "nlohmann/json.hpp"

#include <algorithm>
#include <iostream>
#include <map>
#include <set>

using namespace erdblick;

namespace {
std::shared_ptr<mapget::LayerInfo> relationTestLayerInfo()
{
    return mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
    {
        "layerId": "RelationLayer",
        "type": "Features",
        "featureTypes": [
            {
                "name": "Diamond",
                "uniqueIdCompositions": [[
                    {"partId": "areaId", "datatype": "STR"},
                    {"partId": "diamondId", "datatype": "U32"}
                ]]
            },
            {
                "name": "PointOfInterest",
                "uniqueIdCompositions": [[
                    {"partId": "areaId", "datatype": "STR"},
                    {"partId": "pointId", "datatype": "U32"}
                ]]
            },
            {
                "name": "SecondaryPointOfInterest",
                "uniqueIdCompositions": [
                    [
                        {"partId": "areaId", "datatype": "STR"},
                        {"partId": "poiRef", "datatype": "U32"}
                    ],
                    [
                        {"partId": "poiRef", "datatype": "U32"}
                    ]
                ]
            }
        ]
    })json"));
}

std::shared_ptr<mapget::LayerInfo> lineTestLayerInfo()
{
    return mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
    {
        "layerId": "LineLayer",
        "type": "Features",
        "featureTypes": [
            {
                "name": "Way",
                "uniqueIdCompositions": [[
                    {"partId": "wayId", "datatype": "U32"}
                ]]
            }
        ]
    })json"));
}

/** Build a schema-backed layer with one range attribute field used by search-scope inference tests. */
nlohmann::json speedLimitLayerInfoJson(std::string const& layerId, std::string const& featureType, std::string const& attrLayerName)
{
    auto schema = nlohmann::json{
        {"$schema", "http://json-schema.org/draft-07/schema#"},
        {"oneOf", nlohmann::json::array({{{"$ref", "#/$defs/Feature"}}})},
        {"$defs", {
            {"Feature", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Feature"},
                    {"featureType", featureType}
                }},
                {"properties", {
                    {"typeId", {{"const", featureType}}},
                    {"properties", {{"$ref", "#/$defs/FeatureProperties"}}}
                }}
            }},
            {"FeatureProperties", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "FeatureProperties"},
                    {"featureType", featureType}
                }},
                {"properties", {
                    {"layer", {{"$ref", "#/$defs/AttributeLayerMap"}}}
                }}
            }},
            {"AttributeLayerMap", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeLayerMap"},
                    {"featureType", featureType}
                }},
                {"properties", {
                    {attrLayerName, {{"$ref", "#/$defs/RulesLayer"}}}
                }}
            }},
            {"RulesLayer", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeContainer"}
                }},
                {"properties", {
                    {"SPEED_LIMIT_METRIC", {{"$ref", "#/$defs/SpeedLimitMetric"}}}
                }}
            }},
            {"SpeedLimitMetric", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Attribute"},
                    {"attributeTypeCode", "SPEED_LIMIT_METRIC"}
                }},
                {"properties", {
                    {"attributeValue", {{"$ref", "#/$defs/SpeedLimitMetricValue"}}}
                }}
            }},
            {"SpeedLimitMetricValue", {
                {"type", "object"},
                {"properties", {
                    {"speedLimitKmh", {{"type", "number"}}}
                }}
            }}
        }}
    };

    return {
        {"layerId", layerId},
        {"type", "Features"},
        {"featureTypes", nlohmann::json::array({
            {
                {"name", featureType},
                {"uniqueIdCompositions", nlohmann::json::array({
                    nlohmann::json::array({{{"partId", "id"}, {"datatype", "U32"}}})
                })}
            }
        })},
        {"featureModelSchema", std::move(schema)}
    };
}

/** Build a schema-backed layer where one enum value is shared by base and prefixed warning attributes. */
nlohmann::json warningSignLayerInfoJson()
{
    auto schema = nlohmann::json{
        {"$schema", "http://json-schema.org/draft-07/schema#"},
        {"oneOf", nlohmann::json::array({{{"$ref", "#/$defs/Feature"}}})},
        {"$defs", {
            {"Feature", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Feature"},
                    {"featureType", "Road"}
                }},
                {"properties", {
                    {"typeId", {{"const", "Road"}}},
                    {"properties", {{"$ref", "#/$defs/FeatureProperties"}}}
                }}
            }},
            {"FeatureProperties", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "FeatureProperties"},
                    {"featureType", "Road"}
                }},
                {"properties", {
                    {"layer", {{"$ref", "#/$defs/AttributeLayerMap"}}}
                }}
            }},
            {"AttributeLayerMap", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeLayerMap"},
                    {"featureType", "Road"}
                }},
                {"properties", {
                    {"RoadRulesLayer", {{"$ref", "#/$defs/RulesLayer"}}}
                }}
            }},
            {"RulesLayer", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeContainer"}
                }},
                {"properties", {
                    {"WARNING_SIGN", {{"$ref", "#/$defs/WarningSignAttribute"}}},
                    {"MOVABLE_WARNING_SIGN", {{"$ref", "#/$defs/MovableWarningSignAttribute"}}}
                }}
            }},
            {"WarningSignAttribute", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Attribute"},
                    {"attributeTypeCode", "WARNING_SIGN"},
                    {"attributeType", "synthetic.RulesAttributeType"}
                }},
                {"properties", {
                    {"attributeValue", {{"$ref", "#/$defs/WarningSignValue"}}}
                }}
            }},
            {"MovableWarningSignAttribute", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Attribute"},
                    {"attributeTypeCode", "MOVABLE_WARNING_SIGN"},
                    {"attributeType", "synthetic.RulesAttributeType"}
                }},
                {"properties", {
                    {"attributeValue", {{"$ref", "#/$defs/MovableWarningSignValue"}}}
                }}
            }},
            {"WarningSignValue", {
                {"type", "object"},
                {"properties", {
                    {"warningSign", {{"$ref", "#/$defs/WarningSignEnum"}}}
                }}
            }},
            {"MovableWarningSignValue", {
                {"type", "object"},
                {"properties", {
                    {"movableWarningSign", {{"$ref", "#/$defs/WarningSignEnum"}}}
                }}
            }},
            {"WarningSignEnum", {
                {"type", "string"},
                {"enum", nlohmann::json::array({"SPEED_LIMIT_END"})},
                {"x-mapget", {
                    {"zserioType", "nds.signs.warning.WarningSign"}
                }}
            }}
        }}
    };

    return {
        {"layerId", "Road"},
        {"type", "Features"},
        {"featureTypes", nlohmann::json::array({
            {
                {"name", "Road"},
                {"uniqueIdCompositions", nlohmann::json::array({
                    nlohmann::json::array({{{"partId", "id"}, {"datatype", "U32"}}})
                })}
            }
        })},
        {"featureModelSchema", std::move(schema)}
    };
}

std::shared_ptr<mapget::TileFeatureLayer> makeLineTestTile(mapget::TileId tileId)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "LineTestNode",
        "LineTestMap",
        lineTestLayerInfo(),
        std::make_shared<simfil::StringPool>());

    auto const center = tileId.center();
    auto feature = layer->newFeature("Way", {{"wayId", 1}});
    feature->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
    return layer;
}

std::shared_ptr<mapget::TileFeatureLayer> makeRelationTestTile(
    mapget::TileId tileId,
    bool includeSource,
    bool includeTarget)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "RelationTestNode",
        "RelationTestMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    layer->setIdPrefix({{"areaId", "Area"}});

    auto const center = tileId.center();
    if (includeSource) {
        auto source = layer->newFeature("Diamond", {{"diamondId", 1}});
        source->addLine({
            {center.x - 0.0005, center.y, 0.0},
            {center.x + 0.0005, center.y, 0.0},
        });
        source->addRelation("hasPoi", "PointOfInterest", {{"areaId", "Area"}, {"pointId", 200}});
    }
    if (includeTarget) {
        auto target = layer->newFeature("PointOfInterest", {{"pointId", 200}});
        target->addPoint({center.x, center.y + 0.0005, 0.0});
    }
    return layer;
}

FeatureLayerStyle relationTestStyle()
{
    return FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "RelationTestStyle"
rules:
  - type: "Diamond"
    aspect: relation
    relation-type: "hasPoi"
    color: "#ff5500"
    width: 4
)yaml"));
}

std::shared_ptr<mapget::TileFeatureLayer> makeSecondaryReferenceSourceTile(mapget::TileId tileId)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "RelationTestNode",
        "RelationTestMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    layer->setIdPrefix({{"areaId", "Area"}});

    auto const center = tileId.center();
    auto source = layer->newFeature("Diamond", {{"diamondId", 1}});
    source->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
    source->addRelation("hasPoi", "SecondaryPointOfInterest", {{"poiRef", 77}});
    return layer;
}

/** Build a minimal feature layer used to exercise detached feature references in inspection output. */
std::shared_ptr<mapget::LayerInfo> externalReferenceInspectionLayerInfo()
{
    return mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
    {
        "layerId": "InspectionReferenceLayer",
        "type": "Features",
        "featureTypes": [
            {
                "name": "Way",
                "uniqueIdCompositions": [[
                    {"partId": "wayId", "datatype": "U32"}
                ]]
            }
        ]
    })json"));
}

/** Create one feature whose relation and validity both point to a detached external-map feature id. */
std::shared_ptr<mapget::TileFeatureLayer> makeExternalReferenceInspectionTile(mapget::TileId tileId)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "InspectionReferenceNode",
        "InspectionReferenceMap",
        externalReferenceInspectionLayerInfo(),
        std::make_shared<simfil::StringPool>());

    auto const center = tileId.center();
    auto source = layer->newFeature("Way", {{"wayId", 1}});
    source->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });

    source->addRelation(
        "linkedWay",
        layer->newFeatureId("Way", {{"wayId", 2}}, "ValidationMap"));

    auto attr = source->attributeLayers()->newLayer("limits")->newAttribute("speed");
    attr->validity()->newFeatureId(
        layer->newFeatureId("Way", {{"wayId", 3}}, "ValidationMap"),
        mapget::Validity::Positive);

    return layer;
}

/** Recursively collect rendered FeatureId rows from the inspection tree for focused assertions. */
void collectFeatureReferenceRows(
    nlohmann::json const& node,
    std::vector<std::pair<std::string, std::string>>& featureRefs)
{
    if (node.is_array()) {
        for (auto const& child : node) {
            collectFeatureReferenceRows(child, featureRefs);
        }
        return;
    }

    if (!node.is_object()) {
        return;
    }

    if (node.value("type", 0U) == static_cast<uint32_t>(InspectionConverter::ValueType::FeatureId)) {
        featureRefs.emplace_back(
            node.value("value", std::string{}),
            node.value("mapId", std::string{}));
    }

    if (node.contains("children")) {
        collectFeatureReferenceRows(node.at("children"), featureRefs);
    }
}

bool hasRenderedPathGeometry(nlohmann::json const& renderResult)
{
    auto const& pathWorld = renderResult["pathWorld"]["positions"];
    if (pathWorld.is_array() && !pathWorld.empty()) {
        return true;
    }
    auto const& pathBillboard = renderResult["pathBillboard"]["positions"];
    return pathBillboard.is_array() && !pathBillboard.empty();
}

bool reportHasProperty(nlohmann::json const& report, std::string const& property)
{
    if (!report.contains("issues") || !report["issues"].is_array()) {
        return false;
    }
    for (auto const& issue : report["issues"]) {
        if (issue.value("property", std::string()) == property) {
            return true;
        }
    }
    return false;
}

BoundEvalFun booleanEvalFun(std::map<std::string, bool> values)
{
    return BoundEvalFun{
        simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::null()),
        [values = std::move(values)](std::string const& expression) {
            auto key = expression;
            if (key.starts_with("any(") && key.ends_with(")")) {
                key = key.substr(4, key.size() - 5);
            }
            auto found = values.find(key);
            return simfil::Value(found != values.end() && found->second);
        },
        {}
    };
}
}

TEST_CASE("DeckFeatureLayerVisualization", "[erdblick.renderer]")
{
    auto style = TestDataProvider::style();
    DeckFeatureLayerVisualization visualization(0, "Features:Test:Test:0", style, {}, {});
    REQUIRE(visualization.abiVersion() == 1);
}

TEST_CASE("FeatureInspection", "[erdblick.inspection]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    for (auto const& f : *testLayer) {
        auto inspection = InspectionConverter().convert(f);
        std::cout << inspection.value_.dump(4) << std::endl;

        REQUIRE(inspection.size() > 0);
        REQUIRE(inspection.at(0)["key"].as<std::string>() == "Identifiers");

        bool hasFeatureRoot = false;
        for (uint32_t i = 0; i < inspection.size(); ++i) {
            if (inspection.at(i)["key"].as<std::string>() == "Feature") {
                hasFeatureRoot = true;
                break;
            }
        }
        REQUIRE_FALSE(hasFeatureRoot);
    }
}

TEST_CASE("FeatureInspection preserves external feature-reference map ids", "[erdblick.inspection]")
{
    auto tile = makeExternalReferenceInspectionTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto inspection = InspectionConverter().convert(feature);
    std::vector<std::pair<std::string, std::string>> featureRefs;
    collectFeatureReferenceRows(*inspection, featureRefs);

    REQUIRE(
        std::find(
            featureRefs.begin(),
            featureRefs.end(),
            std::pair<std::string, std::string>{"Way.2", "ValidationMap"}) != featureRefs.end());
    REQUIRE(
        std::find(
            featureRefs.begin(),
            featureRefs.end(),
            std::pair<std::string, std::string>{"Way.3", "ValidationMap"}) != featureRefs.end());
}

TEST_CASE("Feature search auto-scope accepts one attribute across different attribute layers", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"nodeId", "SearchScopeNode"},
        {"mapId", "SearchScopeMap"},
        {"layers", {
            {"Lane", speedLimitLayerInfoJson("Lane", "Lane", "LaneRulesLayer")},
            {"Road", speedLimitLayerInfoJson("Road", "Road", "RoadRulesLayer")}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));

    REQUIRE(parser.isAttributeScopeSearchQuery("**.speedLimitKmh"));

    auto scopes = parser.getAttributeScopeForQuery("**.speedLimitKmh");
    REQUIRE(scopes.is_array());
    REQUIRE(scopes.size() == 2);

    std::set<std::tuple<std::string, std::string, std::string>> scopeKeys;
    for (auto const& scope : scopes) {
        REQUIRE(scope.at("attrName") == "SPEED_LIMIT_METRIC");
        scopeKeys.emplace(
            scope.at("layerId").get<std::string>(),
            scope.at("featureType").get<std::string>(),
            scope.at("attrLayerName").get<std::string>());
    }

    REQUIRE(scopeKeys.contains({"Lane", "Lane", "LaneRulesLayer"}));
    REQUIRE(scopeKeys.contains({"Road", "Road", "RoadRulesLayer"}));
}

TEST_CASE("Feature search auto-scope keeps all shared enum attribute scopes", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"nodeId", "WarningSignScopeNode"},
        {"mapId", "WarningSignScopeMap"},
        {"layers", {
            {"Road", warningSignLayerInfoJson()}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));

    REQUIRE(parser.isAttributeScopeSearchQuery("SPEED_LIMIT_END"));

    auto scopes = parser.getAttributeScopeForQuery("SPEED_LIMIT_END");
    REQUIRE(scopes.is_array());
    REQUIRE(scopes.size() == 2);

    std::set<std::string> attrNames;
    for (auto const& scope : scopes) {
        attrNames.insert(scope.at("attrName").get<std::string>());
        REQUIRE(scope.at("attrLayerName") == "RoadRulesLayer");
    }
    REQUIRE(attrNames.contains("WARNING_SIGN"));
    REQUIRE(attrNames.contains("MOVABLE_WARNING_SIGN"));

    auto styleFields = parser.searchStyleFieldsForQuery("SPEED_LIMIT_END", "auto");
    REQUIRE(styleFields.is_array());

    std::set<std::pair<std::string, std::string>> fieldOwners;
    for (auto const& field : styleFields) {
        if (!field.contains("attrName") || !field.at("attrName").is_string()) {
            continue;
        }
        fieldOwners.emplace(
            field.at("path").get<std::string>(),
            field.at("attrName").get<std::string>());
    }
    REQUIRE(fieldOwners.contains({"attributeValue.warningSign", "WARNING_SIGN"}));
    REQUIRE(fieldOwners.contains({"attributeValue.movableWarningSign", "MOVABLE_WARNING_SIGN"}));
}

TEST_CASE("Feature search completion labels enum-backed constants", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"nodeId", "WarningSignCompletionNode"},
        {"mapId", "WarningSignCompletionMap"},
        {"layers", {
            {"Road", warningSignLayerInfoJson()}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));

    auto warningCompletions = parser.completeSearchQuery("WARNING", 7, nlohmann::json{{"limit", 20}});
    auto speedCompletions = parser.completeSearchQuery("SPEED", 5, nlohmann::json{{"limit", 20}});

    auto hasHint = [](NativeJsValue const& completions, std::string const& text, std::string const& hint) {
        for (auto const& completion : completions) {
            if (completion.at("text") == text && completion.at("hint") == hint) {
                return true;
            }
        }
        return false;
    };
    auto hasCompletionType = [](NativeJsValue const& completions, std::string const& type) {
        for (auto const& completion : completions) {
            if (completion.value("type", std::string{}) == type) {
                return true;
            }
        }
        return false;
    };

    REQUIRE(hasHint(warningCompletions, "WARNING_SIGN", "enum RulesAttributeType"));
    REQUIRE(hasHint(speedCompletions, "SPEED_LIMIT_END", "enum WarningSign"));
    REQUIRE_FALSE(hasCompletionType(warningCompletions, "Hint"));
    REQUIRE_FALSE(hasCompletionType(speedCompletions, "Hint"));
}

TEST_CASE("Feature search diagnostics expose schema ASTs used by scope inference", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"nodeId", "WarningSignAstNode"},
        {"mapId", "WarningSignAstMap"},
        {"layers", {
            {"Road", warningSignLayerInfoJson()}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));

    auto diagnostics = parser.searchQueryAstDiagnostics("WARNING_SIGN", "auto");
    REQUIRE(diagnostics.is_array());

    bool hasAutoScopeAst = false;
    bool hasAttributeScopeAst = false;
    for (auto const& diagnostic : diagnostics) {
        auto const message = diagnostic.value("message", std::string{});
        hasAutoScopeAst = hasAutoScopeAst
            || (message.find("Auto-scope schema AST via WarningSignAstMap/Road/Road.RoadRulesLayer.WARNING_SIGN") != std::string::npos
                && message.find("WARNING_SIGN") != std::string::npos);
        hasAttributeScopeAst = hasAttributeScopeAst
            || (message.find("Schema AST for attribute scope WarningSignAstMap/Road/Road.RoadRulesLayer.WARNING_SIGN") != std::string::npos
                && message.find("WARNING_SIGN") != std::string::npos);
    }
    REQUIRE(hasAutoScopeAst);
    REQUIRE(hasAttributeScopeAst);
}

TEST_CASE("FeatureStyleRuleLodFilterParsing", "[erdblick.style]")
{
    auto yamlWithLod = YAML::Load(R"(
type: Road
geometry: [line]
lod: 3
)");
    FeatureStyleRule ruleWithLod(yamlWithLod, 0);
    REQUIRE(ruleWithLod.lod().has_value());
    REQUIRE(*ruleWithLod.lod() == 3);

    auto yamlWithInvalidLod = YAML::Load(R"(
type: Road
geometry: [line]
lod: 42
)");
    FeatureStyleRule ruleWithInvalidLod(yamlWithInvalidLod, 0);
    REQUIRE_FALSE(ruleWithInvalidLod.lod().has_value());
}

TEST_CASE("FeatureStyleRuleOffsetIncrementParsing", "[erdblick.style]")
{
    auto yaml = YAML::Load(R"(
type: Road
geometry: [line]
offset: [1.0, 2.0, 3.0]
offset-increment: [4.0, 5.0, 6.0]
)");
    FeatureStyleRule rule(yaml, 0);
    REQUIRE(rule.offset() == glm::dvec3(1.0, 2.0, 3.0));
    REQUIRE(rule.offsetIncrement() == glm::dvec3(4.0, 5.0, 6.0));
}

TEST_CASE("FeatureStyleRuleAllOfParsing", "[erdblick.style]")
{
    auto yaml = YAML::Load(R"(
type: Way
geometry: [line]
all-of:
  - color: red
  - dashed: true
)");
    FeatureStyleRule rule(yaml, 0);
    REQUIRE(rule.branchMode() == FeatureStyleRule::BranchMode::AllOf);
    REQUIRE(rule.subRules().size() == 2);
    REQUIRE(rule.subRules()[0].supports(mapget::GeomType::Line));
    REQUIRE(rule.subRules()[1].supports(mapget::GeomType::Line));
    REQUIRE(rule.effectiveGeometryTypesMask() == rule.geometryTypesMask());
}

TEST_CASE("FeatureStyleRuleLateralOffsetParsing", "[erdblick.style]")
{
    auto yaml = YAML::Load(R"(
type: Way
geometry: [line]
lateral-offset: 2.0
vertical-offset: 3.0
)");
    FeatureStyleRule rule(yaml, 0);
    REQUIRE(rule.offset() == glm::dvec3(2.0, 0.0, 3.0));
}

TEST_CASE("FeatureStyleRuleOffsetOverridesLateralOffset", "[erdblick.style]")
{
    auto yaml = YAML::Load(R"(
type: Way
geometry: [line]
lateral-offset: 2.0
offset: [4.0, 5.0, 6.0]
)");
    FeatureStyleRule rule(yaml, 0);
    REQUIRE(rule.offset() == glm::dvec3(4.0, 5.0, 6.0));
}

TEST_CASE("FeatureStyleRuleAllOfMatching", "[erdblick.style]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto yaml = YAML::Load(R"(
type: Way
geometry: [line]
all-of:
  - filter: A
    width: 1
  - filter: B
    dashed: true
)");
    FeatureStyleRule rule(yaml, 0);

    std::vector<FeatureStyleRule const*> matches;
    auto evalFun = booleanEvalFun({{"A", true}, {"B", false}});
    REQUIRE(rule.forEachMatchingRule(*feature, evalFun, [&](auto const& matchingRule) {
        matches.push_back(&matchingRule);
    }));
    REQUIRE(matches.size() == 1);
    REQUIRE(matches[0]->width() == 1.0f);

    matches.clear();
    evalFun = booleanEvalFun({{"A", true}, {"B", true}});
    REQUIRE(rule.forEachMatchingRule(*feature, evalFun, [&](auto const& matchingRule) {
        matches.push_back(&matchingRule);
    }));
    REQUIRE(matches.size() == 2);
    REQUIRE(matches[1]->isDashed());
}

TEST_CASE("FeatureStyleRuleNestedBranchesMatchInOrder", "[erdblick.style]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto yaml = YAML::Load(R"(
type: Way
geometry: [line]
first-of:
  - filter: A
    all-of:
      - width: 1
      - width: 2
  - filter: B
    width: 3
)");
    FeatureStyleRule rule(yaml, 0);
    std::vector<float> widths;
    auto evalFun = booleanEvalFun({{"A", true}, {"B", true}});
    REQUIRE(rule.forEachMatchingRule(*feature, evalFun, [&](auto const& matchingRule) {
        widths.push_back(matchingRule.width());
    }));
    auto const expectedWidths = std::vector<float>{1.0f, 2.0f};
    REQUIRE(widths == expectedWidths);

    uint32_t renderIndex = 0;
    rule.assignRenderRuleIndices(renderIndex);
    std::vector<uint32_t> renderIndices;
    rule.forEachConcreteRule([&](auto const& concreteRule) {
        renderIndices.push_back(concreteRule.renderIndex());
    });
    auto const expectedRenderIndices = std::vector<uint32_t>{0, 1, 2};
    REQUIRE(renderIndices == expectedRenderIndices);
}

TEST_CASE("FeatureLayerStyleValidatesAllOfAndOffsetAliases", "[erdblick.style]")
{
    auto valid = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "AllOfValidation"
rules:
  - type: Way
    geometry: [line]
    lateral-offset: 1
    offset-type: miter
    all-of:
      - color: red
)yaml"));
    REQUIRE(valid.isValid());

    auto badAllOf = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "BadAllOf"
rules:
  - type: Way
    all-of: {}
)yaml"));
    REQUIRE_FALSE(badAllOf.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badAllOf.validationReport()), "all-of"));

    auto mixedBranches = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "MixedBranches"
rules:
  - type: Way
    first-of:
      - color: red
    all-of:
      - color: blue
)yaml"));
    REQUIRE_FALSE(mixedBranches.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(mixedBranches.validationReport()), "all-of"));

    auto badOffsetType = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "BadOffsetType"
rules:
  - type: Way
    geometry: [line]
    offset-type: screen
)yaml"));
    REQUIRE_FALSE(badOffsetType.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badOffsetType.validationReport()), "offset-type"));

    auto badLateralOffset = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "BadLateralOffset"
rules:
  - type: Way
    geometry: [line]
    lateral-offset: [1]
)yaml"));
    REQUIRE_FALSE(badLateralOffset.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badLateralOffset.validationReport()), "lateral-offset"));
}

TEST_CASE("DeckFeatureLayerVisualization renders all-of line leaves", "[erdblick.renderer]")
{
    auto style = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "AllOfRender"
rules:
  - type: Way
    geometry: [line]
    all-of:
      - color: red
        lateral-offset: 1
      - color: blue
        dashed: true
        dash-length: 7
        lateral-offset: -1
        selectable: false
)yaml"));
    REQUIRE(style.isValid());

    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13));
    DeckFeatureLayerVisualization visualization(0, "LineTestMap/LineLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(tile));
    visualization.run();

    auto result = nlohmann::json(visualization.renderResult());
    auto const& pathWorld = result["pathWorld"];
    REQUIRE(pathWorld["startIndices"].size() == 3);
    REQUIRE(pathWorld["featureAddresses"].size() == 2);
    REQUIRE(pathWorld["dashArrays"].size() == 8);
    REQUIRE(pathWorld["dashArrays"][0].get<float>() == 1.0f);
    REQUIRE(pathWorld["dashArrays"][4].get<float>() == 7.0f);
}

TEST_CASE("DeckTileSearchResultLayerVisualization does not connect point-cloud validity hits", "[erdblick.renderer]")
{
    auto strings = std::make_shared<mapget::StringPool>("SearchResultNode");
    auto layer = std::make_shared<mapget::TileSearchResultLayer>(
        mapget::TileId::fromWgs84(42.0, 11.0, 13),
        strings->nodeId_,
        "LineTestMap",
        lineTestLayerInfo(),
        strings);

    auto const center = layer->tileId().center();
    auto geometry = layer->newGeometryCollection();
    auto line = geometry->newGeometry(mapget::GeomType::Line);
    for (auto pointIndex = 0; pointIndex < 10; ++pointIndex) {
        line->append({
            center.x + (pointIndex % 2 == 0 ? -0.04 : 0.04),
            center.y + static_cast<double>(pointIndex) * 0.0004,
            0.0});
    }

    auto featureId = layer->newFeatureId("Way", {{"wayId", int64_t(1)}});
    std::vector<simfil::ModelNode::Ptr> values;
    layer->newSearchResult(featureId, geometry, values, 0U, 0U, 10U);

    DeckTileSearchResultLayerVisualization visualization(0, "LineTestMap/LineLayer/0", R"json({})json");
    visualization.addTileSearchResultLayer(TileSearchResultLayer(layer));
    visualization.run();

    auto result = nlohmann::json(visualization.renderResult());
    REQUIRE(result["pathWorld"]["positions"].empty());
    REQUIRE(result["pointWorld"]["positions"].size() == 30);
}

TEST_CASE("DeckFeatureLayerVisualization renders intra-tile relations", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto tile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13), true, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(tile));
    visualization.run();

    REQUIRE(hasRenderedPathGeometry(nlohmann::json(visualization.renderResult())));
}

TEST_CASE("DeckFeatureLayerVisualization resolves relation targets from added auxiliary tiles", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTileId = mapget::TileId::fromWgs84(42.0, 11.0, 13);
    auto sourceTile = makeRelationTestTile(sourceTileId, true, false);
    auto auxiliaryTile = makeRelationTestTile(sourceTileId.neighbor(1, 0), false, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.addTileFeatureLayer(TileFeatureLayer(auxiliaryTile));
    visualization.run();

    REQUIRE(hasRenderedPathGeometry(nlohmann::json(visualization.renderResult())));
}

TEST_CASE("DeckFeatureLayerVisualization exposes unresolved external relation references", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13), true, false);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.run();

    auto unresolvedReferences =
        nlohmann::json(visualization.externalRelationReferences());
    REQUIRE(unresolvedReferences.is_array());
    REQUIRE(unresolvedReferences.size() == 1);
    REQUIRE(unresolvedReferences[0]["mapId"].get<std::string>() == "RelationTestMap");
    REQUIRE(unresolvedReferences[0]["typeId"].get<std::string>() == "PointOfInterest");
}

TEST_CASE("DeckFeatureLayerVisualization resolves external relations with canonical locate ids", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTile = makeSecondaryReferenceSourceTile(mapget::TileId::fromWgs84(42.0, 11.0, 13));
    auto targetTile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13).neighbor(1, 0), false, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.run();

    visualization.addTileFeatureLayer(TileFeatureLayer(targetTile));
    visualization.processResolvedExternalReferences(nlohmann::json::array({
        nlohmann::json::array({
            {
                {"tileId", "RelationTestMap/RelationLayer/1"},
                {"typeId", "PointOfInterest"},
                {"featureId", nlohmann::json::array({"areaId", "Area", "pointId", 200})}
            }
        })
    }));

    REQUIRE(hasRenderedPathGeometry(nlohmann::json(visualization.renderResult())));
}
