#ifndef ERDBLICK_FEATURESTYLERULE_H
#define ERDBLICK_FEATURESTYLERULE_H

#include "mapget/model/feature.h"
#include "simfil/model/nodes.h"

class FeatureStyleRule
{
public:
    FeatureStyleRule(
        std::vector<simfil::Geometry::GeomType>& geometryTypes,
        std::string& type,
        std::string& filter,
        float opacity);
    bool match(mapget::Feature const&);

    const std::vector<simfil::Geometry::GeomType>& geometryTypes();
    const std::string& typeIdPattern();
    const std::string& filter();
    float opacity();
    // TODO Create GeometryBitMask and Color classes.
    // const Color color();

private:
    std::vector<simfil::Geometry::GeomType>& geometryTypes_;
    std::string type_;
    std::string filter_;
    // Color color_;
    float opacity_;
};

#endif  // ERDBLICK_FEATURESTYLERULE_H
