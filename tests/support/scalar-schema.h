#pragma once

#include "mapget/model/mapschema.h"
#include "simfil/value.h"

namespace erdblick::test
{

/**
 * Compact semantic fixture shared by inspection, aggregation and rendered-color
 * tests. Speed domains intentionally disagree about zero; raw width has a 0.1 m
 * encoding and flags include zero, aliases, composite and unknown high bits.
 */
struct ScalarSchema
{
    std::shared_ptr<mapget::MapSchema> owner = std::make_shared<mapget::MapSchema>();
    simfil::SchemaId speed{}, classicSpeed{}, width{}, flags{}, rawRoot{};
    mapget::DataSourceInfo source;

    ScalarSchema()
    {
        using Schema = simfil::Schema;
        auto layer = owner->newLayer("Road", mapget::LayerType::Features);
        auto root = layer->addSchema(
            mapget::LayerSchema::FeatureKind,
            mapget::LayerSchema::featureKey("Road"));
        auto properties = layer->addSchema(
            Schema::Kind::Object,
            mapget::LayerSchema::featurePropertiesKey("Road"));
        speed = layer->addSchema(Schema::Kind::Int);
        classicSpeed = layer->addSchema(Schema::Kind::Int);
        width = layer->addSchema(Schema::Kind::Int);
        flags = layer->addSchema(Schema::Kind::Bitmask);
        layer->setTypeName(speed, "Live.Speed");
        layer->setTypeName(classicSpeed, "Classic.Speed");
        layer->setTypeName(width, "Metric.Width");
        layer->setTypeName(flags, "Access.Flags");
        for (auto id : {speed, classicSpeed}) {
            Schema::NumericRange ordinary{int64_t{id == speed ? 1 : 0}, int64_t{253}};
            layer->setNumericDomain(
                id,
                {.encoding = "uint8",
                 .unit = id == speed ? "km/h" : "",
                 .minimum = int64_t{0},
                 .maximum = int64_t{255},
                 .ordinaryRanges = {&ordinary, 1},
                 .complete = true});
            layer->addNamedValue(
                id,
                {.name = "VARIABLE",
                 .value = int64_t{254},
                 .role = Schema::NamedValue::Role::Special,
                 .meaning = Schema::NamedValue::Meaning::Variable});
            layer->addNamedValue(
                id,
                {.name = "UNLIMITED",
                 .value = int64_t{255},
                 .role = Schema::NamedValue::Role::Special,
                 .meaning = Schema::NamedValue::Meaning::Unbounded});
        }
        layer->addNamedValue(
            speed,
            {.name = "UNDEFINED",
             .value = int64_t{0},
             .role = Schema::NamedValue::Role::Special,
             .meaning = Schema::NamedValue::Meaning::Unknown});
        Schema::NumericRange widthRange{int64_t{0}, int64_t{253}};
        layer->setNumericDomain(
            width,
            {.encoding = "uint8",
             .unit = "m",
             .ordinaryRanges = {&widthRange, 1},
             .scale = 0.1,
             .complete = true});
        layer->setBitWidth(flags, 64);
        for (auto const& [name, bits] : std::vector<std::pair<std::string, uint64_t>>{
                 {"NONE", 0},
                 {"CAR", 1},
                 {"CAR_ALIAS", 1},
                 {"BIKE", 2},
                 {"BOTH", 3}})
            layer->addNamedValue(
                flags,
                {.name = name, .value = bits, .role = Schema::NamedValue::Role::Flag});
        layer->addFieldSchema(root, "properties", properties);
        layer->addFieldSchema(properties, "speed", speed);
        layer->addFieldSchema(properties, "classicSpeed", classicSpeed);
        layer->addFieldSchema(properties, "width", width);
        layer->addFieldSchema(properties, "flags", flags);
        layer->addFeatureType(
            mapget::FeatureTypeInfo::fromJson(
                {{"name", "Road"},
                 {"uniqueIdCompositions", {{{{"partId", "id"}, {"datatype", "U32"}}}}}}),
            root);
        layer->setRootSchema(root);
        auto raw = owner->newLayer("Raw", mapget::LayerType::SourceData);
        rawRoot = raw->addSchema(Schema::Kind::Object);
        raw->addFieldSchema(rawRoot, "speed", speed);
        raw->addFieldSchema(rawRoot, "width", width);
        raw->addFieldSchema(rawRoot, "flags", flags);
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
    simfil::Value number(int64_t raw, simfil::SchemaId domain) const
    {
        return simfil::Value(raw).withSchema({owner->binding(), domain});
    }
};

}  // namespace erdblick::test
