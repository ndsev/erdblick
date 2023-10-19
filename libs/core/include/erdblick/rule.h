#pragma once

#include "mapget/model/feature.h"
#include "simfil/model/nodes.h"
#include "yaml-cpp/yaml.h"

#include "color.h"

#include <regex>

namespace erdblick
{

class FeatureStyleRule
{
public:
    FeatureStyleRule(YAML::Node const& yaml);
    bool match(mapget::Feature& feature) const;

    const std::vector<simfil::Geometry::GeomType>& geometryTypes() const;
    glm::fvec4 const& color() const;
    float width() const;

private:
    std::vector<simfil::Geometry::GeomType> geometryTypes_;
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    float width_ = 1.;
};

}
