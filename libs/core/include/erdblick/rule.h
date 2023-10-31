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
    explicit FeatureStyleRule(YAML::Node const& yaml);

    [[nodiscard]] bool match(mapget::Feature& feature) const;
    [[nodiscard]] bool supports(mapget::Geometry::GeomType const& g) const;
    [[nodiscard]] glm::fvec4 const& color() const;
    [[nodiscard]] float width() const;

private:
    static inline uint32_t geomTypeBit(mapget::Geometry::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::Geometry::GeomType>>(g);
    }

    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    float width_ = 1.;
};

}
