#include "include/FeatureStyleRule.h"

FeatureStyleRule::FeatureStyleRule(
    std::vector<simfil::Geometry::GeomType>& geometryTypes,
    std::string& type,
    std::string& filter,
    float opacity)
    : geometryTypes_(geometryTypes), type_(type), filter_(filter), opacity_(opacity)
{
}

bool FeatureStyleRule::match(const mapget::Feature&)
{
    // TODO check for match ing geometry, type pattern, filter.
    return true;
}

const std::vector<simfil::Geometry::GeomType>& FeatureStyleRule::geometryTypes()
{
    return geometryTypes_;
}

const std::string& FeatureStyleRule::typeIdPattern()
{
    return type_;
}

const std::string& FeatureStyleRule::filter()
{
    return filter_;
}

float FeatureStyleRule::opacity()
{
    return opacity_;
}
