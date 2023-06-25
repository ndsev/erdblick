#include "rule.h"

FeatureStyleRule::FeatureStyleRule(
    std::vector<simfil::Geometry::GeomType>& geometryTypes,
    std::string& type,
    std::string& filter,
    float opacity)
    : geometryTypes_(geometryTypes), type_(type), filter_(filter), opacity_(opacity)
{
}

bool FeatureStyleRule::match(const mapget::Feature&) const
{
    // TODO check for matching geometry, type pattern, filter.
    return true;
}

const std::vector<simfil::Geometry::GeomType>& FeatureStyleRule::geometryTypes() const
{
    return geometryTypes_;
}

const std::string& FeatureStyleRule::typeIdPattern() const
{
    return type_;
}

const std::string& FeatureStyleRule::filter() const
{
    return filter_;
}

float FeatureStyleRule::opacity() const
{
    return opacity_;
}
