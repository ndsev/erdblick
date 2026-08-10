#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/rule.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"
#include "mapget/model/point.h"
#include "mapget/model/sourceinfo.h"
#include "mapget/model/sourcedatareference.h"
#include "mapget/model/stringpool.h"
#include "nlohmann/json.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <variant>

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

/** Serializes a minimal datasource string-pool update for parser cache tests. */
SharedUint8Array serializedStringPool(std::string const& stringPoolId, std::string const& dynamicEntry)
{
    mapget::StringPool pool(stringPoolId);
    pool.emplace(dynamicEntry);
    std::ostringstream stream;
    auto writeResult = pool.write(stream, 0);
    REQUIRE(writeResult);
    return SharedUint8Array(stream.str());
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
                    {"_sourceData", {
                        {"type", "array"},
                        {"items", {
                            {"type", "object"},
                            {"properties", {
                                {"address", {{"type", "integer"}}}
                            }}
                        }}
                    }},
                    {"attributeValue", {{"$ref", "#/$defs/SpeedLimitMetricValue"}}},
                    {"conditions", {
                        {"type", "object"},
                        {"properties", {
                            {"conditionValue", {{"type", "integer"}}}
                        }}
                    }},
                    {"properties", {
                        {"type", "object"},
                        {"properties", {
                            {"propertyValue", {{"type", "integer"}}}
                        }}
                    }},
                    {"references", {
                        {"type", "object"},
                        {"properties", {
                            {"referenceValue", {{"type", "integer"}}}
                        }}
                    }},
                    {"validity", {
                        {"type", "object"},
                        {"properties", {
                            {"validityValue", {{"type", "integer"}}}
                        }}
                    }}
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

/** Build a Classic-style schema where SPEED_LIMIT exposes speedLimit directly on the attribute object. */
nlohmann::json classicSpeedLimitLayerInfoJson()
{
    auto schema = nlohmann::json{
        {"$schema", "http://json-schema.org/draft-07/schema#"},
        {"oneOf", nlohmann::json::array({{{"$ref", "#/$defs/Feature"}}})},
        {"$defs", {
            {"Feature", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "Feature"},
                    {"featureType", "Link"}
                }},
                {"properties", {
                    {"typeId", {{"const", "Link"}}},
                    {"properties", {{"$ref", "#/$defs/FeatureProperties"}}}
                }}
            }},
            {"FeatureProperties", {
                {"type", "object"},
                {"properties", {
                    {"layer", {{"$ref", "#/$defs/AttributeLayerMap"}}}
                }}
            }},
            {"AttributeLayerMap", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeLayerMap"}
                }},
                {"properties", {
                    {"Guidance", {{"$ref", "#/$defs/GuidanceLayer"}}}
                }}
            }},
            {"GuidanceLayer", {
                {"type", "object"},
                {"x-mapget", {
                    {"metaType", "AttributeContainer"}
                }},
                {"properties", {
                    {"SPEED_LIMIT", {
                        {"anyOf", nlohmann::json::array({
                            {
                                {"type", "object"},
                                {"x-mapget", {
                                    {"metaType", "Attribute"},
                                    {"attributeTypeCode", "SPEED_LIMIT"},
                                    {"rdsValueField", "speedLimit"}
                                }},
                                {"properties", {
                                    {"speedLimit", {
                                        {"type", "integer"},
                                        {"minimum", 0},
                                        {"maximum", 255}
                                    }},
                                    {"value", {
                                        {"anyOf", nlohmann::json::array({
                                            {{"type", "null"}},
                                            {{"type", "integer"}},
                                            {{"type", "string"}}
                                        })}
                                    }}
                                }}
                            },
                            {
                                {"type", "array"},
                                {"items", {
                                    {"type", "object"},
                                    {"x-mapget", {
                                        {"metaType", "Attribute"},
                                        {"attributeTypeCode", "SPEED_LIMIT"},
                                        {"rdsValueField", "speedLimit"}
                                    }},
                                    {"properties", {
                                        {"speedLimit", {
                                            {"type", "integer"},
                                            {"minimum", 0},
                                            {"maximum", 255}
                                        }}
                                    }}
                                }}
                            }
                        })},
                        {"x-mapget", {
                            {"metaType", "Attribute"},
                            {"attributeTypeCode", "SPEED_LIMIT"},
                            {"rdsValueField", "speedLimit"}
                        }},
                        {"x-mapget-multimap", true}
                    }}
                }}
            }}
        }}
    };

    return {
        {"layerId", "NDS.Classic-Routing"},
        {"type", "Features"},
        {"featureTypes", nlohmann::json::array({
            {
                {"name", "Link"},
                {"uniqueIdCompositions", nlohmann::json::array({
                    nlohmann::json::array({{{"partId", "linkId"}, {"datatype", "U32"}}})
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

    auto const center = mapget::Point(tileId.centerWgs84());
    auto feature = layer->newFeature("Way", {{"wayId", 1}});
    feature->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
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

    auto const center = mapget::Point(tileId.centerWgs84());
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

/** Creates a single source-data reference collection for inspection provenance tests. */
mapget::model_ptr<mapget::SourceDataReferenceCollection> makeInspectionSourceDataRefs(
    mapget::TileFeatureLayer& tile,
    std::string const& layerId,
    size_t bitOffset)
{
    auto const layerIdString = tile.strings()->emplace(layerId).value();
    auto const qualifierString = tile.strings()->emplace("Value").value();
    mapget::QualifiedSourceDataReference ref{
        .address_ = mapget::SourceDataAddress::fromBitPosition(bitOffset, 8),
        .layerId_ = layerIdString,
        .qualifier_ = qualifierString,
    };
    return tile.newSourceDataReferenceCollection({&ref, 1});
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

/** Recursively collect inspection hover ids so URL-facing row identities can be asserted. */
void collectInspectionHoverIds(
    nlohmann::json const& node,
    std::vector<std::string>& hoverIds)
{
    if (node.is_array()) {
        for (auto const& child : node) {
            collectInspectionHoverIds(child, hoverIds);
        }
        return;
    }

    if (!node.is_object()) {
        return;
    }

    if (node.contains("hoverId")) {
        hoverIds.push_back(node.value("hoverId", std::string{}));
    }

    if (node.contains("children")) {
        collectInspectionHoverIds(node.at("children"), hoverIds);
    }
}

nlohmann::json const* findInspectionNode(
    nlohmann::json const& node,
    std::function<bool(nlohmann::json const&)> const& predicate)
{
    if (node.is_array()) {
        for (auto const& child : node) {
            if (auto const* result = findInspectionNode(child, predicate)) {
                return result;
            }
        }
        return nullptr;
    }

    if (!node.is_object()) {
        return nullptr;
    }

    if (predicate(node)) {
        return &node;
    }

    if (node.contains("children")) {
        return findInspectionNode(node.at("children"), predicate);
    }
    return nullptr;
}

nlohmann::json const* findInspectionNodeByKey(nlohmann::json const& node, std::string const& key)
{
    return findInspectionNode(node, [&key](nlohmann::json const& candidate) {
        return candidate.value("key", nlohmann::json{}) == key;
    });
}

/** Find a direct inspection child by key without searching grandchildren. */
nlohmann::json const* findInspectionDirectChildByKey(nlohmann::json const& node, std::string const& key)
{
    if (!node.contains("children") || !node.at("children").is_array()) {
        return nullptr;
    }
    for (auto const& child : node.at("children")) {
        if (child.value("key", nlohmann::json{}) == key) {
            return &child;
        }
    }
    return nullptr;
}

/** Collect the labels from value bubbles attached directly to one inspection node. */
std::vector<std::string> inspectionValueBubbleLabels(nlohmann::json const& node)
{
    std::vector<std::string> labels;
    if (!node.contains("valueBubbles") || !node.at("valueBubbles").is_array()) {
        return labels;
    }
    for (auto const& bubble : node.at("valueBubbles")) {
        labels.push_back(bubble.value("label", std::string{}));
    }
    return labels;
}

/** Collect the labels from key-column metadata bubbles attached to one inspection node. */
std::vector<std::string> inspectionKeyBubbleLabels(nlohmann::json const& node)
{
    std::vector<std::string> labels;
    if (!node.contains("keyBubbles") || !node.at("keyBubbles").is_array()) {
        return labels;
    }
    for (auto const& bubble : node.at("keyBubbles")) {
        labels.push_back(bubble.value("label", std::string{}));
    }
    return labels;
}

nlohmann::json const* findInspectionNodeByGeoJsonPath(nlohmann::json const& node, std::string const& path)
{
    return findInspectionNode(node, [&path](nlohmann::json const& candidate) {
        return candidate.value("geoJsonPath", std::string{}) == path;
    });
}

void collectInspectionGeoJsonPaths(nlohmann::json const& node, std::vector<std::string>& paths)
{
    if (node.is_array()) {
        for (auto const& child : node) {
            collectInspectionGeoJsonPaths(child, paths);
        }
        return;
    }

    if (!node.is_object()) {
        return;
    }

    if (node.contains("geoJsonPath")) {
        paths.push_back(node.value("geoJsonPath", std::string{}));
    }

    if (node.contains("children")) {
        collectInspectionGeoJsonPaths(node.at("children"), paths);
    }
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

TEST_CASE("FeatureInspection", "[erdblick.inspection]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    for (auto const& f : *testLayer) {
        auto inspection = InspectionConverter().convert(f);
        REQUIRE(inspection.size() > 0);
        REQUIRE(inspection.at(0)["key"].as<std::string>() == "Identifiers");

        auto const* typeNode = findInspectionDirectChildByKey((*inspection).at(0), "type");
        REQUIRE(typeNode);
        REQUIRE(typeNode->value("geoJsonPath", std::string{}) == "typeId");

        auto const* featureIdNode = findInspectionDirectChildByKey((*inspection).at(0), "featureId");
        REQUIRE(featureIdNode);
        REQUIRE_FALSE(featureIdNode->contains("children"));
        REQUIRE(featureIdNode->value("value", std::string{}) == f->id()->toString());
        REQUIRE(featureIdNode->value("type", 0U) == static_cast<uint32_t>(InspectionConverter::ValueType::FeatureId));
        REQUIRE(featureIdNode->value("mapId", std::string{}) == f->model().mapId());
        REQUIRE(featureIdNode->value("geoJsonPath", std::string{}) == "id");

        for (auto const& [key, value] : f->id()->keyValuePairs()) {
            auto const* idPartNode = findInspectionDirectChildByKey((*inspection).at(0), std::string(key));
            REQUIRE(idPartNode);
            REQUIRE_FALSE(idPartNode->contains("children"));
            REQUIRE(idPartNode->value("geoJsonPath", std::string{}) == key);
            if (std::holds_alternative<int64_t>(value)) {
                REQUIRE(idPartNode->at("value").get<int64_t>() == std::get<int64_t>(value));
            } else {
                REQUIRE(idPartNode->value("value", std::string{}) == std::get<std::string_view>(value));
            }
        }

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

TEST_CASE("FeatureInspection exposes traversal-based attribute hover ids", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto firstLayer = feature->attributeLayers()->newLayer("first-layer");
    auto first = firstLayer->newAttribute("first");
    first->addField("value", tile->newValue(int64_t(1)));
    auto secondLayer = feature->attributeLayers()->newLayer("second-layer");
    auto second = secondLayer->newAttribute("second");
    second->addField("value", tile->newValue(int64_t(2)));
    second->validity()->newFeatureId(
        tile->newFeatureId("Way", {{"wayId", 1}}),
        mapget::Validity::Positive);

    auto inspection = InspectionConverter().convert(feature);
    std::vector<std::string> hoverIds;
    collectInspectionHoverIds(*inspection, hoverIds);

    REQUIRE(
        std::find(
            hoverIds.begin(),
            hoverIds.end(),
            "Way.1:attribute#0") != hoverIds.end());
    REQUIRE(
        std::find(
            hoverIds.begin(),
            hoverIds.end(),
            "Way.1:attribute#1") != hoverIds.end());
    REQUIRE(
        std::find(
            hoverIds.begin(),
            hoverIds.end(),
            "Way.1:attribute#1:validity#0") != hoverIds.end());
}

TEST_CASE("FeatureInspection copies canonical array search paths", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto testObject = tile->newObject();
    auto items = tile->newArray();
    items->append(tile->newValue("A"));
    items->append(tile->newValue("B"));
    REQUIRE(testObject->addField("items", items).has_value());

    auto emptyItems = tile->newArray();
    REQUIRE(testObject->addField("emptyItems", emptyItems).has_value());

    auto objectItems = tile->newArray();
    auto objectItem = tile->newObject();
    REQUIRE(objectItem->addField("code", "C").has_value());
    objectItems->append(objectItem);
    REQUIRE(testObject->addField("objectItems", objectItems).has_value());

    REQUIRE(feature->attributes()->addField("test", testObject).has_value());

    auto inspection = InspectionConverter().convert(feature);
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "attributes.test.items.*"));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "attributes.test.items[0]"));
    auto const* emptyItemsNode = findInspectionNodeByGeoJsonPath(*inspection, "attributes.test.emptyItems.*");
    REQUIRE(emptyItemsNode);
    REQUIRE(emptyItemsNode->at("value").is_null());
    REQUIRE(emptyItemsNode->value("valueCount", std::string{}) == "0");
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "attributes.test.objectItems.*"));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "attributes.test.objectItems[0].code"));

    std::vector<std::string> paths;
    collectInspectionGeoJsonPaths(*inspection, paths);
    REQUIRE(std::ranges::none_of(paths, [](std::string const& path) {
        return path.find(".[\"0\"]") != std::string::npos;
    }));
}

TEST_CASE("FeatureInspection copies geometry search paths", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto inspection = InspectionConverter().convert(feature);

    auto const* geometryType = findInspectionNodeByGeoJsonPath(*inspection, "geometry.type");
    REQUIRE(geometryType);
    REQUIRE(geometryType->value("value", std::string{}) == "Polyline");
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "geometry.coordinates[0]"));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "geometry.coordinates[1]"));
    REQUIRE_FALSE(findInspectionNodeByGeoJsonPath(*inspection, "geometry[0]"));
    REQUIRE_FALSE(findInspectionNodeByGeoJsonPath(*inspection, "geometry[0][0]"));
}

TEST_CASE("FeatureInspection copies geometry collection search paths", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto const center = mapget::Point(tile->tileId().centerWgs84());
    feature->addPoint({center.x, center.y + 0.0005, 0.0});

    auto inspection = InspectionConverter().convert(feature);

    auto const* firstGeometryType = findInspectionNodeByGeoJsonPath(*inspection, "geometry.geometries[0].type");
    REQUIRE(firstGeometryType);
    REQUIRE(firstGeometryType->value("value", std::string{}) == "Polyline");
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "geometry.geometries[0].coordinates[0]"));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "geometry.geometries[0].coordinates[1]"));

    auto const* secondGeometryType = findInspectionNodeByGeoJsonPath(*inspection, "geometry.geometries[1].type");
    REQUIRE(secondGeometryType);
    REQUIRE(secondGeometryType->value("value", std::string{}) == "Points");
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, "geometry.geometries[1].coordinates[0]"));
    REQUIRE_FALSE(findInspectionNodeByGeoJsonPath(*inspection, "geometry[1]"));
}

TEST_CASE("FeatureInspection keeps scalar value paths on leaf nodes", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("SPEED_LIMIT_METRIC");
    auto attrValue = tile->newObject();
    REQUIRE(attrValue->addField("speedLimitKmh", int64_t(50)).has_value());
    REQUIRE(attr->addField("attributeValue", attrValue).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* attrNode = findInspectionNodeByKey(*inspection, "SPEED_LIMIT_METRIC");
    REQUIRE(attrNode);
    REQUIRE(attrNode->at("value").is_null());
    REQUIRE(
        attrNode->value("geoJsonPath", std::string{}) ==
        "attributes.layer.rules.SPEED_LIMIT_METRIC");

    auto const* speedLimitNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.SPEED_LIMIT_METRIC.attributeValue.speedLimitKmh");
    REQUIRE(speedLimitNode);
    REQUIRE(speedLimitNode->value("value", 0) == 50);
}

TEST_CASE("FeatureInspection exposes propagated scalar value bubbles", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("ROAD_LOCATION_ID");
    auto roadLocation = tile->newObject();
    REQUIRE(roadLocation->addField("locationId", int64_t(418182439)).has_value());
    REQUIRE(roadLocation->addField("locationIndex", int64_t(0)).has_value());

    auto attrValue = tile->newObject();
    REQUIRE(attrValue->addField("numLocations", int64_t(1)).has_value());
    REQUIRE(attrValue->addField("roadLocationId", roadLocation).has_value());
    REQUIRE(attrValue->addBool("sameDirectionAsSource", true).has_value());
    REQUIRE(attrValue->addBool("completeLocation", true).has_value());
    REQUIRE(attrValue->addBool("optionalFlag", false).has_value());
    REQUIRE(attr->addField("attributeValue", attrValue).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* attrNode = findInspectionNodeByKey(*inspection, "ROAD_LOCATION_ID");
    REQUIRE(attrNode);
    auto labels = inspectionValueBubbleLabels(*attrNode);
    REQUIRE(std::find(labels.begin(), labels.end(), "418182439 0") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "sameDirectionAsSource") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "completeLocation") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "numLocations") == labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "optionalFlag") == labels.end());

    auto const* completeLocationNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.ROAD_LOCATION_ID.attributeValue.completeLocation");
    REQUIRE(completeLocationNode);
    auto leafLabels = inspectionValueBubbleLabels(*completeLocationNode);
    REQUIRE(std::find(leafLabels.begin(), leafLabels.end(), "true") != leafLabels.end());

    auto const* rulesLayer = findInspectionNodeByKey(*inspection, "rules");
    REQUIRE(rulesLayer);
    REQUIRE_FALSE(rulesLayer->contains("valueBubbles"));

    auto const* identifiersNode = findInspectionNodeByKey(*inspection, "Identifiers");
    REQUIRE(identifiersNode);
    REQUIRE_FALSE(identifiersNode->contains("valueBubbles"));
    auto const* featureIdNode = findInspectionDirectChildByKey(*identifiersNode, "featureId");
    REQUIRE(featureIdNode);
    REQUIRE_FALSE(featureIdNode->contains("valueBubbles"));
}

TEST_CASE("FeatureInspection exposes attribute layer ids as key bubbles", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto firstLayer = feature->attributeLayers()->newLayer("rules");
    firstLayer->setId(7);
    firstLayer->newAttribute("SPEED_LIMIT_METRIC");

    auto secondLayer = feature->attributeLayers()->newLayer("rules");
    secondLayer->setId(8);
    secondLayer->newAttribute("ROAD_LOCATION_ID");

    auto inspection = InspectionConverter().convert(feature);
    auto const* attributeLayersNode = findInspectionNodeByKey(*inspection, "Attribute Layers");
    REQUIRE(attributeLayersNode);
    REQUIRE(attributeLayersNode->contains("children"));

    std::vector<std::string> idLabels;
    for (auto const& child : attributeLayersNode->at("children")) {
        if (child.value("key", std::string{}) != "rules") {
            continue;
        }
        auto labels = inspectionKeyBubbleLabels(child);
        REQUIRE(labels.size() == 1);
        idLabels.push_back(labels.front());
    }

    REQUIRE(idLabels == std::vector<std::string>{"#7", "#8"});
}

TEST_CASE("FeatureInspection summarizes boolean arrays as named bit vectors", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("BOOLEAN_FLAGS");
    auto flags = tile->newArray();
    flags->append(tile->newSmallValue(false));
    flags->append(tile->newSmallValue(false));
    flags->append(tile->newSmallValue(true));
    flags->append(tile->newSmallValue(false));

    auto attrValue = tile->newObject();
    REQUIRE(attrValue->addField("myBool", flags).has_value());
    REQUIRE(attr->addField("attributeValue", attrValue).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* flagsNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.BOOLEAN_FLAGS.attributeValue.myBool.*");
    REQUIRE(flagsNode);
    auto flagsLabels = inspectionValueBubbleLabels(*flagsNode);
    REQUIRE(std::find(flagsLabels.begin(), flagsLabels.end(), "0 0 1 0") != flagsLabels.end());

    auto const* attrNode = findInspectionNodeByKey(*inspection, "BOOLEAN_FLAGS");
    REQUIRE(attrNode);
    auto attrLabels = inspectionValueBubbleLabels(*attrNode);
    REQUIRE(std::find(attrLabels.begin(), attrLabels.end(), "myBool 0 0 1 0") != attrLabels.end());
}

TEST_CASE("FeatureInspection summarizes days of week as compact value bubbles", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("ACTIVE_DAYS");
    auto daysOfWeek = tile->newObject();
    REQUIRE(daysOfWeek->addBool("isMonday", true).has_value());
    REQUIRE(daysOfWeek->addBool("isTuesday", true).has_value());
    REQUIRE(daysOfWeek->addBool("isWednesday", true).has_value());
    REQUIRE(daysOfWeek->addBool("isThursday", false).has_value());
    REQUIRE(daysOfWeek->addBool("isFriday", false).has_value());
    REQUIRE(daysOfWeek->addBool("isSaturday", true).has_value());
    REQUIRE(daysOfWeek->addBool("isSunday", false).has_value());
    REQUIRE(daysOfWeek->addBool("isInclusive", true).has_value());

    auto attrValue = tile->newObject();
    REQUIRE(attrValue->addField("daysOfWeek", daysOfWeek).has_value());
    REQUIRE(attr->addField("attributeValue", attrValue).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* daysNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.ACTIVE_DAYS.attributeValue.daysOfWeek");
    REQUIRE(daysNode);
    auto labels = inspectionValueBubbleLabels(*daysNode);
    REQUIRE(std::find(labels.begin(), labels.end(), "Mon-Wed,Sat") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "isInclusive") != labels.end());
}

TEST_CASE("FeatureInspection summarizes months of year as compact value bubbles", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("ACTIVE_MONTHS");
    auto monthsOfYear = tile->newObject();
    REQUIRE(monthsOfYear->addBool("january", true).has_value());
    REQUIRE(monthsOfYear->addBool("february", true).has_value());
    REQUIRE(monthsOfYear->addBool("march", false).has_value());
    REQUIRE(monthsOfYear->addBool("april", false).has_value());
    REQUIRE(monthsOfYear->addBool("may", true).has_value());
    REQUIRE(monthsOfYear->addBool("june", true).has_value());
    REQUIRE(monthsOfYear->addBool("july", true).has_value());
    REQUIRE(monthsOfYear->addBool("august", false).has_value());
    REQUIRE(monthsOfYear->addBool("september", false).has_value());
    REQUIRE(monthsOfYear->addBool("october", false).has_value());
    REQUIRE(monthsOfYear->addBool("november", false).has_value());
    REQUIRE(monthsOfYear->addBool("december", true).has_value());
    REQUIRE(monthsOfYear->addBool("isInclusive", true).has_value());

    auto attrValue = tile->newObject();
    REQUIRE(attrValue->addField("monthsOfYear", monthsOfYear).has_value());
    REQUIRE(attr->addField("attributeValue", attrValue).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* monthsNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.ACTIVE_MONTHS.attributeValue.monthsOfYear");
    REQUIRE(monthsNode);
    auto labels = inspectionValueBubbleLabels(*monthsNode);
    REQUIRE(std::find(labels.begin(), labels.end(), "Jan-Feb,May-Jul,Dec") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "isInclusive") != labels.end());
}

TEST_CASE("FeatureInspection exposes compact validity value bubbles", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("SPEED_LIMIT_METRIC");
    REQUIRE(attr->addField("value", int64_t(30)).has_value());
    attr->validity()->newFeatureId(
        tile->newFeatureId("Way", {{"wayId", 1}}),
        mapget::Validity::Positive);

    auto inspection = InspectionConverter().convert(feature);
    auto const* attrNode = findInspectionNodeByKey(*inspection, "SPEED_LIMIT_METRIC");
    REQUIRE(attrNode);
    auto labels = inspectionValueBubbleLabels(*attrNode);
    REQUIRE(std::find(labels.begin(), labels.end(), "30") != labels.end());
    REQUIRE(std::find(labels.begin(), labels.end(), "+ Way.1") != labels.end());
}

TEST_CASE("FeatureInspection keeps complete validity bubbles local when values add more information", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attr = feature->attributeLayers()->newLayer("rules")->newAttribute("SPEED_LIMIT_METRIC");
    REQUIRE(attr->addField("value", int64_t(30)).has_value());
    attr->validity()->newDirection(mapget::Validity::Both);

    auto inspection = InspectionConverter().convert(feature);
    auto const* attrNode = findInspectionNodeByKey(*inspection, "SPEED_LIMIT_METRIC");
    REQUIRE(attrNode);
    auto attrLabels = inspectionValueBubbleLabels(*attrNode);
    REQUIRE(std::find(attrLabels.begin(), attrLabels.end(), "30") != attrLabels.end());
    REQUIRE(std::find(attrLabels.begin(), attrLabels.end(), "COMPLETE") == attrLabels.end());

    auto const* validityNode = findInspectionNodeByKey(*attrNode, "validity");
    REQUIRE(validityNode);
    auto validityLabels = inspectionValueBubbleLabels(*validityNode);
    REQUIRE(std::find(validityLabels.begin(), validityLabels.end(), "COMPLETE") != validityLabels.end());
}

TEST_CASE("FeatureInspection keeps attributes in model layers with source data references", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto attrLayer = feature->attributeLayers()->newLayer("RoadRulesLayer");
    auto speed = attrLayer->newAttribute("SPEED_LIMIT_METRIC");
    REQUIRE(speed->addField("value", int64_t(30)).has_value());
    speed->setSourceDataReferences(makeInspectionSourceDataRefs(*tile, "SourceData-RoadRulesLayer-3", 8));

    auto warning = attrLayer->newAttribute("WARNING_SIGN");
    REQUIRE(warning->addField("value", "YIELD").has_value());
    warning->setSourceDataReferences(makeInspectionSourceDataRefs(*tile, "SourceData-RoadRulesLayer-9", 24));

    auto inspection = InspectionConverter().convert(feature);
    auto const* rulesLayer = findInspectionNodeByKey(*inspection, "RoadRulesLayer");
    REQUIRE(rulesLayer);
    REQUIRE(rulesLayer->contains("children"));

    auto const& attributes = rulesLayer->at("children");
    REQUIRE(attributes.is_array());
    REQUIRE(attributes.size() == 2);
    REQUIRE(attributes.at(0).value("key", std::string{}) == "SPEED_LIMIT_METRIC");
    REQUIRE(attributes.at(1).value("key", std::string{}) == "WARNING_SIGN");

    auto const* speedNode = findInspectionNodeByKey(*rulesLayer, "SPEED_LIMIT_METRIC");
    REQUIRE(speedNode);
    REQUIRE(
        speedNode->value("geoJsonPath", std::string{}) ==
        "attributes.layer.RoadRulesLayer.SPEED_LIMIT_METRIC");
    REQUIRE(speedNode->value("hoverId", std::string{}) == "Way.1:attribute#0");
    REQUIRE(speedNode->contains("sourceDataReferences"));
    REQUIRE(
        speedNode->at("sourceDataReferences").at(0).value("mapTileKey", std::string{})
            .find("SourceData-RoadRulesLayer-3") != std::string::npos);

    auto const* warningNode = findInspectionNodeByKey(*rulesLayer, "WARNING_SIGN");
    REQUIRE(warningNode);
    REQUIRE(warningNode->value("hoverId", std::string{}) == "Way.1:attribute#1");
    REQUIRE(
        warningNode->at("sourceDataReferences").at(0).value("mapTileKey", std::string{})
            .find("SourceData-RoadRulesLayer-9") != std::string::npos);
}

TEST_CASE("FeatureInspection attaches nested source references to their object", "[erdblick.inspection]")
{
    auto tile = makeLineTestTile(mapget::TileId::fromWgs84(42., 11., 13));
    auto feature = tile->find("Way.1");
    REQUIRE(feature);

    auto category = tile->newObject(2, true);
    REQUIRE(category->addField("catId", tile->newValue(int64_t{17})).has_value());
    REQUIRE(category->addField(
        "_sourceData",
        makeInspectionSourceDataRefs(*tile, "SourceData-Classic-poiCategoryTable", 32))
        .has_value());
    auto attr = feature->attributeLayers()->newLayer("Categories")
        ->newAttribute("category");
    REQUIRE(attr->addField("resolved", category).has_value());

    auto inspection = InspectionConverter().convert(feature);
    auto const* resolved = findInspectionNodeByKey(*inspection, "resolved");
    REQUIRE(resolved);
    REQUIRE(resolved->contains("sourceDataReferences"));
    REQUIRE(
        resolved->at("sourceDataReferences").at(0)
            .value("mapTileKey", std::string{})
            .find("SourceData-Classic-poiCategoryTable") != std::string::npos);
    REQUIRE_FALSE(findInspectionDirectChildByKey(*resolved, "_sourceData"));
}

TEST_CASE("FeatureInspection copies relation search paths", "[erdblick.inspection]")
{
    auto tile = std::make_shared<mapget::TileFeatureLayer>(
        mapget::TileId::fromWgs84(42., 11., 13),
        "RelationInspectionNode",
        "RelationInspectionMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    tile->setIdPrefix({{"areaId", "Area"}});

    auto const center = mapget::Point(tile->tileId().centerWgs84());
    auto source = tile->newFeature("Diamond", {{"diamondId", 1}});
    source->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
    auto relation = source->addRelation(
        "hasPoi",
        "PointOfInterest",
        {{"areaId", "Area"}, {"pointId", 200}});
    relation->sourceValidity()->newDirection(mapget::Validity::Direction::Positive);
    relation->targetValidity()->newDirection(mapget::Validity::Direction::Negative);
    source->addRelation(
        "hasPoi",
        "PointOfInterest",
        {{"areaId", "Area"}, {"pointId", 201}});

    auto inspection = InspectionConverter().convert(source);

    auto const* relationGroup = findInspectionNodeByKey(*inspection, "hasPoi");
    REQUIRE(relationGroup);
    REQUIRE(relationGroup->value("geoJsonPath", std::string{}) == "relations.*{name = \"hasPoi\"}");

    auto const relationPath = std::string{"select(relations.*{name = \"hasPoi\"}, 0)"};
    auto const secondRelationPath = std::string{"select(relations.*{name = \"hasPoi\"}, 1)"};
    auto const* relationRow = findInspectionNodeByGeoJsonPath(*inspection, relationPath);
    REQUIRE(relationRow);
    REQUIRE(relationRow->value("hoverId", std::string{}) == source->id()->toString() + ":relation#0:validity#0");
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, secondRelationPath));

    auto const* targetRow = findInspectionNodeByGeoJsonPath(*inspection, relationPath + ".target");
    REQUIRE(targetRow);
    REQUIRE(targetRow->value("value", std::string{}).find("PointOfInterest") != std::string::npos);
    REQUIRE(targetRow->value("type", 0U) == static_cast<uint32_t>(InspectionConverter::ValueType::FeatureId));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, secondRelationPath + ".target"));

    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, relationPath + ".sourceValidity.direction"));
    REQUIRE(findInspectionNodeByGeoJsonPath(*inspection, relationPath + ".targetValidity.direction"));
    auto const* targetValidity = findInspectionDirectChildByKey(*relationRow, "targetValidity");
    REQUIRE(targetValidity);
    REQUIRE(targetValidity->value("hoverId", std::string{}) == source->id()->toString() + ":relation#0:validity#0");
    auto relationBubbles = relationRow->at("valueBubbles");
    REQUIRE(relationBubbles.is_array());
    auto const& relationBubble = relationBubbles.at(0);
    REQUIRE(relationBubble.at("children").is_array());
    auto const targetValidityNodeId = targetValidity->value("nodeId", std::string{});
    auto const& relationBubbleChildren = relationBubble.at("children");
    REQUIRE(relationBubbleChildren.size() == 3);
    REQUIRE(relationBubbleChildren.at(0).value("label", std::string{}) == "+");
    REQUIRE(relationBubbleChildren.at(2).value("label", std::string{}) == "-");
    auto targetFeatureBubble = std::find_if(
        relationBubbleChildren.begin(),
        relationBubbleChildren.end(),
        [](auto const& bubble) { return bubble.value("kind", std::string{}) == "feature-id"; });
    REQUIRE(targetFeatureBubble != relationBubbleChildren.end());
    REQUIRE(targetFeatureBubble->value("hoverTargetNodeId", std::string{}) == targetValidityNodeId);
    REQUIRE_FALSE(findInspectionNodeByGeoJsonPath(*inspection, relationPath + ".target.sourceValidity.direction"));
}

TEST_CASE("FeatureInspection renders relation references like relation rows", "[erdblick.inspection]")
{
    auto tile = std::make_shared<mapget::TileFeatureLayer>(
        mapget::TileId::fromWgs84(42., 11., 13),
        "RelationReferenceInspectionNode",
        "RelationReferenceInspectionMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    tile->setIdPrefix({{"areaId", "Area"}});

    auto const center = mapget::Point(tile->tileId().centerWgs84());
    auto source = tile->newFeature("Diamond", {{"diamondId", 1}});
    source->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
    auto relation = source->addRelation(
        "hasPoi",
        "PointOfInterest",
        {{"areaId", "Area"}, {"pointId", 200}});
    relation->targetValidity()->newDirection(mapget::Validity::Direction::Negative);

    auto relationRefEnvelope = tile->newObject();
    REQUIRE(relationRefEnvelope->addField("primary", tile->newRelationReference(relation)).has_value());
    auto attr = source->attributeLayers()->newLayer("rules")->newAttribute("TURN_RESTRICTION");
    REQUIRE(attr->addField("attributeValue", relationRefEnvelope).has_value());

    auto inspection = InspectionConverter().convert(source);
    auto const* refNode = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.TURN_RESTRICTION.attributeValue.primary");
    REQUIRE(refNode);
    REQUIRE(refNode->value("hoverId", std::string{}) == source->id()->toString() + ":relation#0:validity#0");
    REQUIRE(refNode->value("type", 0U) == static_cast<uint32_t>(InspectionConverter::ValueType::Null));

    auto const* targetRow = findInspectionNodeByGeoJsonPath(
        *inspection,
        "attributes.layer.rules.TURN_RESTRICTION.attributeValue.primary.target");
    REQUIRE(targetRow);
    REQUIRE(targetRow->value("value", std::string{}).find("PointOfInterest") != std::string::npos);
    REQUIRE(targetRow->value("type", 0U) == static_cast<uint32_t>(InspectionConverter::ValueType::FeatureId));
    REQUIRE(findInspectionDirectChildByKey(*refNode, "targetValidity"));

    auto relationBubbles = refNode->at("valueBubbles");
    REQUIRE(relationBubbles.is_array());
    REQUIRE(relationBubbles.at(0).at("children").is_array());
    auto const& relationBubbleChildren = relationBubbles.at(0).at("children");
    auto targetFeatureBubble = std::find_if(
        relationBubbleChildren.begin(),
        relationBubbleChildren.end(),
        [](auto const& bubble) { return bubble.value("kind", std::string{}) == "feature-id"; });
    REQUIRE(targetFeatureBubble != relationBubbleChildren.end());
    REQUIRE(targetFeatureBubble->value("hoverTargetNodeId", std::string{}).empty() == false);
}

TEST_CASE("TileLayerParser clears string-pool offsets when datasource info is replaced", "[erdblick.parser]")
{
    TileLayerParser parser;
    parser.addFieldDict(serializedStringPool("ReloadedNode", "stale-field-name"));

    auto offsetsBeforeReload = parser.getFieldDictOffsets();
    REQUIRE(offsetsBeforeReload.contains("ReloadedNode"));

    parser.setDataSourceInfo(SharedUint8Array("[]"));

    auto offsetsAfterReload = parser.getFieldDictOffsets();
    REQUIRE_FALSE(offsetsAfterReload.contains("ReloadedNode"));
}

TEST_CASE("TileLayerParser exposes the tile conversion timestamp in milliseconds", "[erdblick.parser]")
{
    using namespace std::chrono;

    TileLayerParser parser;
    auto tile = TestDataProvider(parser).getTestLayer(42., 11., 13);
    constexpr int64_t expectedTimestampMs = 1'725'000'123'456;
    tile->setTimestamp(system_clock::time_point(milliseconds(expectedTimestampMs)));

    std::ostringstream stream;
    REQUIRE(tile->write(stream));

    auto metadata = parser.readTileLayerMetadata(SharedUint8Array(stream.str()));
    REQUIRE(metadata.conversionTimestampMs == static_cast<double>(expectedTimestampMs));
}

TEST_CASE("Feature search auto-scope accepts one attribute across different attribute layers", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"stringPoolId", "SearchScopeNode"},
        {"mapId", "SearchScopeMap"},
        {"layers", {
            {"Lane", speedLimitLayerInfoJson("Lane", "Lane", "LaneRulesLayer")},
            {"Road", speedLimitLayerInfoJson("Road", "Road", "RoadRulesLayer")}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));
    auto const options = nlohmann::json::object();

    REQUIRE(parser.isAttributeScopeSearchQuery("**.speedLimitKmh", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("**.speedLimitKmh > 80", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("SPEED_LIMIT_METRIC", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("\"SPEED_LIMIT_METRIC\"", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("SPEED_LIMIT_METRIC > 80", options));

    auto scopes = parser.getAttributeScopeForQuery("**.speedLimitKmh", options);
    REQUIRE(scopes.is_array());
    REQUIRE(scopes.size() == 2);

    auto comparisonScopes = parser.getAttributeScopeForQuery("**.speedLimitKmh > 80", options);
    REQUIRE(comparisonScopes.is_array());
    REQUIRE(comparisonScopes.size() == 2);

    auto standaloneScopes = parser.getAttributeScopeForQuery("SPEED_LIMIT_METRIC", options);
    REQUIRE(standaloneScopes.is_array());
    REQUIRE(standaloneScopes.size() == 2);

    auto quotedStandaloneScopes = parser.getAttributeScopeForQuery("\"SPEED_LIMIT_METRIC\"", options);
    REQUIRE(quotedStandaloneScopes.is_array());
    REQUIRE(quotedStandaloneScopes.size() == 2);

    auto shorthandScopes = parser.getAttributeScopeForQuery("SPEED_LIMIT_METRIC > 80", options);
    REQUIRE(shorthandScopes.is_array());
    REQUIRE(shorthandScopes.size() == 2);

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

TEST_CASE("Feature search auto-scope accepts Classic direct speed-limit fields", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"stringPoolId", "ClassicScopeNode"},
        {"mapId", "ClassicScopeMap"},
        {"layers", {
            {"NDS.Classic-Routing", classicSpeedLimitLayerInfoJson()}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));
    auto const options = nlohmann::json{
        {"selectedMapLayers", nlohmann::json::array({
            {
                {"mapId", "ClassicScopeMap"},
                {"layerId", "NDS.Classic-Routing"}
            }
        })}
    };

    REQUIRE(parser.isAttributeScopeSearchQuery("speedLimit < 80", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("**.speedLimit", options));
    REQUIRE(parser.isAttributeScopeSearchQuery("**.speedLimit < 80", options));

    auto scopes = parser.getAttributeScopeForQuery("**.speedLimit < 80", options);
    REQUIRE(scopes.is_array());
    REQUIRE(scopes.size() == 1);
    REQUIRE(scopes.front().at("attrName") == "SPEED_LIMIT");
    REQUIRE(scopes.front().at("attrLayerName") == "Guidance");
    REQUIRE(scopes.front().at("featureType") == "Link");
    REQUIRE(scopes.front().at("mapId") == "ClassicScopeMap");
    REQUIRE(scopes.front().at("layerId") == "NDS.Classic-Routing");

    auto styleFields = parser.searchStyleFieldsForQuery("**.speedLimit < 80", "auto", options);
    REQUIRE(styleFields.is_array());
    auto speedLimitField = std::ranges::find_if(styleFields, [](auto const& field) {
        return field.at("path") == "speedLimit" && field.at("attrName") == "SPEED_LIMIT";
    });
    REQUIRE(speedLimitField != styleFields.end());
    REQUIRE(speedLimitField->at("valueKind") == "integer");
    REQUIRE(speedLimitField->contains("numericRange"));
    REQUIRE(speedLimitField->at("numericRange").at("min").get<double>() == 0.0);
    REQUIRE(speedLimitField->at("numericRange").at("max").get<double>() == 255.0);
}

TEST_CASE("Feature search auto-scope keeps all shared enum attribute scopes", "[erdblick.search]")
{
    auto datasource = nlohmann::json{
        {"stringPoolId", "WarningSignScopeNode"},
        {"mapId", "WarningSignScopeMap"},
        {"layers", {
            {"Road", warningSignLayerInfoJson()}
        }}
    };

    TileLayerParser parser;
    parser.setDataSourceInfo(SharedUint8Array(nlohmann::json::array({datasource}).dump()));
    auto const options = nlohmann::json::object();

    REQUIRE(parser.isAttributeScopeSearchQuery("SPEED_LIMIT_END", options));

    auto scopes = parser.getAttributeScopeForQuery("SPEED_LIMIT_END", options);
    REQUIRE(scopes.is_array());
    REQUIRE(scopes.size() == 2);

    std::set<std::string> attrNames;
    for (auto const& scope : scopes) {
        attrNames.insert(scope.at("attrName").get<std::string>());
        REQUIRE(scope.at("attrLayerName") == "RoadRulesLayer");
    }
    REQUIRE(attrNames.contains("WARNING_SIGN"));
    REQUIRE(attrNames.contains("MOVABLE_WARNING_SIGN"));

    auto styleFields = parser.searchStyleFieldsForQuery("SPEED_LIMIT_END", "auto", options);
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
        {"stringPoolId", "WarningSignCompletionNode"},
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
    auto hasTextType = [](NativeJsValue const& completions, std::string const& text, std::string const& type) {
        for (auto const& completion : completions) {
            if (completion.at("text") == text && completion.at("type") == type) {
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

    REQUIRE(hasTextType(warningCompletions, "WARNING_SIGN", "Field"));
    REQUIRE_FALSE(hasTextType(warningCompletions, "\"WARNING_SIGN\"", "Constant"));
    REQUIRE(hasHint(speedCompletions, "\"SPEED_LIMIT_END\"", "enum WarningSign"));
    REQUIRE_FALSE(hasCompletionType(warningCompletions, "Hint"));
    REQUIRE_FALSE(hasCompletionType(speedCompletions, "Hint"));
}

TEST_CASE("FeatureLayerStyle rejects removed LOD fields", "[erdblick.style]")
{
    auto style = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: RemovedLod
version: 2
rules:
  - type: Road
    geometry: line
    lod: 3
)yaml"));
    REQUIRE_FALSE(style.isValid());
    REQUIRE(reportHasProperty(
        nlohmann::json(style.validationReport()),
        "lod"));
}

TEST_CASE("FeatureLayerStyle parses and validates label opacity", "[erdblick.style]")
{
    auto valid = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: LabelOpacity
version: 2
rules:
  - geometry: point
    label-text: label
    label-opacity: 0.35
)yaml"));
    REQUIRE(valid.isValid());
    REQUIRE(valid.rules().size() == 1);
    REQUIRE(std::abs(valid.rules().front().labelOpacity() - 0.35f) < 1e-6f);

    auto invalid = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: InvalidLabelOpacity
version: 2
rules:
  - geometry: point
    label-text: label
    label-opacity: 2
)yaml"));
    REQUIRE_FALSE(invalid.isValid());
    REQUIRE(reportHasProperty(
        nlohmann::json(invalid.validationReport()),
        "label-opacity"));
}

TEST_CASE("Bundled styles pass native style validation", "[erdblick.style]")
{
    auto const stylesDirectory =
        std::filesystem::path(__FILE__)
            .parent_path()
            .parent_path() /
        "config/styles";
    REQUIRE(
        std::filesystem::is_directory(
            stylesDirectory));

    size_t checked = 0;
    for (auto const& entry :
         std::filesystem::directory_iterator(
             stylesDirectory))
    {
        if (!entry.is_regular_file() ||
            entry.path().extension() != ".yaml")
        {
            continue;
        }
        ++checked;
        DYNAMIC_SECTION(
            entry.path().filename().string())
        {
            std::ifstream input(
                entry.path(),
                std::ios::binary);
            REQUIRE(input.good());
            std::string source{
                std::istreambuf_iterator<char>(
                    input),
                std::istreambuf_iterator<char>()};
            auto style = FeatureLayerStyle(
                SharedUint8Array(source));
            REQUIRE(style.isValid());
        }
    }
    REQUIRE(checked > 0);
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

TEST_CASE("FeatureStyleRuleLateralOffsetUnitAliases", "[erdblick.style]")
{
    for (auto const& alias : {"pixel", "pixels", "px"}) {
        auto rule = FeatureStyleRule(YAML::Load(
            "type: Way\ngeometry: [line]\nlateral-offset-unit: " +
            std::string(alias)), 0);
        REQUIRE(rule.lateralOffsetUnit() ==
            FeatureStyleRule::LateralOffsetUnit::Pixel);
    }
    for (auto const& alias : {"meter", "meters", "m"}) {
        auto rule = FeatureStyleRule(YAML::Load(
            "type: Way\ngeometry: [line]\nlateral-offset-unit: " +
            std::string(alias)), 0);
        REQUIRE(rule.lateralOffsetUnit() ==
            FeatureStyleRule::LateralOffsetUnit::Meter);
    }
}

TEST_CASE("FeatureStyleRuleGlowParsing", "[erdblick.style]")
{
    auto rule = FeatureStyleRule(YAML::Load(R"yaml(
type: Way
geometry: line
glow: {color: "#102030", radius: 5, opacity: 0.25}
)yaml"), 0);
    REQUIRE(rule.glow().has_value());
    REQUIRE(rule.glow()->radius == 5.0f);
    REQUIRE(rule.glow()->opacity == 0.25f);
    REQUIRE(std::abs(rule.glow()->color.r - 16.0f / 255.0f) < 1.0e-6f);
    REQUIRE(std::abs(rule.glow()->color.g - 32.0f / 255.0f) < 1.0e-6f);
    REQUIRE(std::abs(rule.glow()->color.b - 48.0f / 255.0f) < 1.0e-6f);
}

TEST_CASE("FeatureLayerStyle resolves constrained interaction effects", "[erdblick.style]")
{
    auto style = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: InteractionEffects
version: 2
options:
  - id: selectionColor
    label: Selection color
    type: string
    default: yellow
interaction-effects:
  hover:
    tint: "#102030"
    tint-mix: 0.6
    opacity: 0.75
    edge-width: 2
    halo: {color: black, radius: 5, opacity: 0.4}
    stripe:
      color: cyan
      spacing: 10
      width: 1.5
      opacity: 0.08
      angle: 30
      offset: 2
      softness: 0.5
  selection:
    tint: {option: selectionColor}
rules:
  - type: Way
    geometry: line
)yaml"));
    REQUIRE(style.isValid());
    REQUIRE(style.supportsInteractionEffect(
        FeatureStyleRule::HoverHighlight));
    REQUIRE(style.supportsInteractionEffect(
        FeatureStyleRule::SelectionHighlight));
    REQUIRE_FALSE(style.supportsInteractionEffect(
        FeatureStyleRule::NoHighlight));

    auto hover = nlohmann::json(style.interactionEffect(
        FeatureStyleRule::HoverHighlight,
        nlohmann::json::object()));
    REQUIRE(hover["tint"] == nlohmann::json::array({16, 32, 48, 255}));
    REQUIRE(hover["tintMix"] == 0.6f);
    REQUIRE(hover["opacity"] == 0.75f);
    REQUIRE(hover["edgeWidth"] == 2.0f);
    REQUIRE(hover["haloColor"] ==
        nlohmann::json::array({0, 0, 0, 255}));
    REQUIRE(hover["haloRadius"] == 5.0f);
    REQUIRE(hover["haloOpacity"] == 0.4f);
    REQUIRE(hover["stripeSpacing"] == 10.0f);
    REQUIRE(hover["stripeWidth"] == 1.5f);
    REQUIRE(hover["stripeOpacity"] == 0.08f);
    REQUIRE(hover["stripeAngle"] == 30.0f);
    REQUIRE(hover["stripeOffset"] == 2.0f);
    REQUIRE(hover["stripeSoftness"] == 0.5f);
    REQUIRE(hover["stripeColor"] ==
        nlohmann::json::array({0, 255, 255, 255}));

    auto selection = nlohmann::json(style.interactionEffect(
        FeatureStyleRule::SelectionHighlight,
        nlohmann::json{{"selectionColor", "#abcdef"}}));
    REQUIRE(selection["tint"] ==
        nlohmann::json::array({171, 205, 239, 255}));
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
    FeatureStyleRule::MatchContext context{
        .featureType = feature->typeId(),
    };

    std::vector<FeatureStyleRule const*> matches;
    auto evalFun = booleanEvalFun({{"A", true}, {"B", false}});
    REQUIRE(rule.forEachMatchingRule(context, evalFun, [&](auto const& matchingRule) {
        matches.push_back(&matchingRule);
    }));
    REQUIRE(matches.size() == 1);
    REQUIRE(matches[0]->width() == 1.0f);

    matches.clear();
    evalFun = booleanEvalFun({{"A", true}, {"B", true}});
    REQUIRE(rule.forEachMatchingRule(context, evalFun, [&](auto const& matchingRule) {
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
    FeatureStyleRule::MatchContext context{
        .featureType = feature->typeId(),
    };
    std::vector<float> widths;
    auto evalFun = booleanEvalFun({{"A", true}, {"B", true}});
    REQUIRE(rule.forEachMatchingRule(context, evalFun, [&](auto const& matchingRule) {
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
version: 2
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
version: 2
rules:
  - type: Way
    all-of: {}
)yaml"));
    REQUIRE_FALSE(badAllOf.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badAllOf.validationReport()), "all-of"));

    auto mixedBranches = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "MixedBranches"
version: 2
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
version: 2
rules:
  - type: Way
    geometry: [line]
    offset-type: screen
)yaml"));
    REQUIRE_FALSE(badOffsetType.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badOffsetType.validationReport()), "offset-type"));

    auto badLateralOffset = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "BadLateralOffset"
version: 2
rules:
  - type: Way
    geometry: [line]
    lateral-offset: [1]
)yaml"));
    REQUIRE_FALSE(badLateralOffset.isValid());
    REQUIRE(reportHasProperty(nlohmann::json(badLateralOffset.validationReport()), "lateral-offset"));
}

TEST_CASE("FeatureLayerStyleSkipsUnsafeOptionIdentifiers", "[erdblick.style]")
{
    auto style = FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "OptionIdentifierValidation"
version: 2
options:
  - label: Valid
    id: showValid
    type: bool
    default: true
  - label: Unsafe
    id: "show~unsafe"
    type: bool
    default: true
  - label: Duplicate
    id: showValid
    type: bool
    default: false
rules:
  - type: Way
    geometry: [line]
)yaml"));

    REQUIRE(style.isValid());
    REQUIRE(style.options().size() == 1);
    REQUIRE(style.options().front().id_ == "showValid");
    auto report = nlohmann::json(style.validationReport());
    REQUIRE(reportHasProperty(report, "id"));
    REQUIRE(report["issues"].size() == 2);
}
