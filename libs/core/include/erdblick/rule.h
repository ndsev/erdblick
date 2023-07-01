#pragma once

#include "mapget/model/feature.h"
#include "simfil/model/nodes.h"
#include "yaml-cpp/yaml.h"

#include "color.h"

namespace erdblick
{

class FeatureStyleRule
{
public:
    FeatureStyleRule(YAML::Node const& yaml);
    bool match(const mapget::Feature& feature) const;

    const std::vector<simfil::Geometry::GeomType>& geometryTypes() const;
    const std::string& typeIdPattern() const;
    const std::string& filter() const;
    float opacity() const;
    Color const& color() const;

private:
    // TODO use GeometryTypeBitmask instead!
    std::vector<simfil::Geometry::GeomType> geometryTypes_;
    std::string type_;
    std::string filter_;
    Color color_;
    float opacity_ = .0;
};

}
