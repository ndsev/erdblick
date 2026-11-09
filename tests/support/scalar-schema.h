#pragma once

#include <span>
#include "mapget/model/mapschema.h"
#include "simfil/value.h"

namespace erdblick::test
{

/**
 * Compact semantic fixture shared by inspection, aggregation and rendered-color
 * tests. Speed types intentionally disagree about zero; raw width has a 0.1 m
 * encoding and flags include zero, aliases, composite and unknown high bits.
 */
struct ScalarSchema
{
    std::shared_ptr<mapget::MapSchema> owner = std::make_shared<mapget::MapSchema>();
    simfil::TypeId speed{}, classicSpeed{}, width{}, flags{}, rawRoot{};
    mapget::DataSourceInfo source;

    ScalarSchema()
    {
        using Type = simfil::SchemaType;
        auto layer = owner->newLayer("Road", mapget::LayerType::Features);
        auto properties = owner->newObjectType();
        auto speedType = owner->newScalarType(Type::Kind::Int);
        auto classicSpeedType = owner->newScalarType(Type::Kind::Int);
        auto widthType = owner->newScalarType(Type::Kind::Int);
        auto flagsType = owner->newBitmaskType(64);
        speed = speedType.id();
        classicSpeed = classicSpeedType.id();
        width = widthType.id();
        flags = flagsType.id();
        speedType.setTypeName("Live.Speed");
        classicSpeedType.setTypeName("Classic.Speed");
        widthType.setTypeName("Metric.Width");
        flagsType.setTypeName("Access.Flags");
        for (auto type : {speedType, classicSpeedType}) {
            Type::NumericRange ordinary{int64_t{type.id() == speed ? 1 : 0}, int64_t{253}};
            type.setNumericDomain(
                {.encoding = "uint8",
                 .unit = type.id() == speed ? "km/h" : "",
                 .minimum = int64_t{0},
                 .maximum = int64_t{255},
                 .ordinaryRanges = std::span<Type::NumericRange const>{&ordinary, size_t{1}},
                 .complete = true});
            type.addNamedValue(
                {.name = "VARIABLE",
                 .value = int64_t{254},
                 .role = Type::NamedValue::Role::Special,
                 .meaning = Type::NamedValue::Meaning::Variable});
            type.addNamedValue(
                {.name = "UNLIMITED",
                 .value = int64_t{255},
                 .role = Type::NamedValue::Role::Special,
                 .meaning = Type::NamedValue::Meaning::Unbounded});
        }
        speedType.addNamedValue(
            {.name = "UNDEFINED",
             .value = int64_t{0},
             .role = Type::NamedValue::Role::Special,
             .meaning = Type::NamedValue::Meaning::Unknown});
        Type::NumericRange widthRange{int64_t{0}, int64_t{253}};
        widthType.setNumericDomain(
            {.encoding = "uint8",
             .unit = "m",
             .ordinaryRanges = std::span<Type::NumericRange const>{&widthRange, size_t{1}},
             .scale = 0.1,
             .complete = true});
        for (auto const& [name, bits] : std::vector<std::pair<std::string, uint64_t>>{
                 {"NONE", 0},
                 {"CAR", 1},
                 {"CAR_ALIAS", 1},
                 {"BIKE", 2},
                 {"BOTH", 3}})
            flagsType.addFlag(name, bits);
        properties.addField("speed", speedType);
        properties.addField("classicSpeed", classicSpeedType);
        properties.addField("width", widthType);
        properties.addField("flags", flagsType);
        auto feature = layer->newFeature(
            mapget::FeatureTypeInfo::fromJson(
                {{"name", "Road"},
                 {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}}),
            properties);
        layer->setRootSchema(feature.id());
        auto raw = owner->newLayer("Raw", mapget::LayerType::SourceData);
        auto rawType = owner->newObjectType();
        rawRoot = rawType.id();
        rawType.addField("speed", speedType);
        rawType.addField("width", widthType);
        rawType.addField("flags", flagsType);
        raw->setRootSchema(rawRoot);
        owner->finalize();
        source.mapId_ = "ScalarSchema";
        source.stringPoolId_ = "ScalarSchema";
        auto info = std::make_shared<mapget::LayerInfo>();
        info->layerId_ = "Road";
        source.layers_.emplace("Road", info);
        auto rawInfo = std::make_shared<mapget::LayerInfo>();
        rawInfo->layerId_ = "Raw";
        rawInfo->type_ = mapget::LayerType::SourceData;
        source.layers_.emplace("Raw", rawInfo);
        source.setMapSchema(owner);
    }

    /** Construct a directly selected primitive; arithmetic tests deliberately omit this qualifier.
     */
    simfil::Value number(int64_t raw, simfil::TypeId type) const
    {
        return simfil::Value(raw).withSchemaType(owner->schemaType(type));
    }
};

}  // namespace erdblick::test
