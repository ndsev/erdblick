#pragma once

#include "mapget/model/feature.h"
#include "simfil/model/nodes.h"

namespace erdblick
{

class FeatureStyleRule
{
public:
    FeatureStyleRule(
        std::vector<simfil::Geometry::GeomType>& geometryTypes,
        std::string& type,
        std::string& filter,
        float opacity);
    bool match(const mapget::Feature& feature) const;

    const std::vector<simfil::Geometry::GeomType>& geometryTypes() const;
    const std::string& typeIdPattern() const;
    const std::string& filter() const;
    float opacity() const;
    // TODO Create GeometryBitMask and Color classes.
    // const Color color();

private:
    std::vector<simfil::Geometry::GeomType> geometryTypes_;
    std::string type_;
    std::string filter_;
    // Color color_;
    float opacity_;
};

}
