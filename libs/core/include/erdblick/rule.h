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
    FeatureStyleRule(FeatureStyleRule const& other) = default;

    FeatureStyleRule const* match(mapget::Feature& feature) const;
    [[nodiscard]] bool supports(mapget::Geometry::GeomType const& g) const;
    [[nodiscard]] glm::fvec4 const& color() const;
    [[nodiscard]] std::string colorString() const;
    [[nodiscard]] float width() const;
    [[nodiscard]] bool flat() const;
    [[nodiscard]] bool isDashed() const;
    [[nodiscard]] int dashLength() const;
    [[nodiscard]] glm::fvec4 const& gapColor() const;
    [[nodiscard]] std::string gapColorString() const;
    [[nodiscard]] int dashPattern() const;
    [[nodiscard]] bool hasArrow() const;
    [[nodiscard]] bool hasDoubleArrow() const;
    [[nodiscard]] glm::fvec4 const& outlineColor() const;
    [[nodiscard]] float outlineWidth() const;
    [[nodiscard]] std::optional<std::array<float, 4>> const& nearFarScale() const;

private:
    void parse(YAML::Node const& yaml);

    static inline uint32_t geomTypeBit(mapget::Geometry::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::Geometry::GeomType>>(g);
    }

    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    std::string colorString_ = "#000000";
    float width_ = 1.;
    bool flat_ = false;
    bool dashed_ = false;
    int dashLength_ = 16;
    std::string gapColorString_ = "#ffffff";
    glm::fvec4 gapColor_{1.0, 1.0, 1.0, 1.};
    int dashPattern_ = 255;
    bool hasArrow_ = false;
    bool hasDoubleArrow_ = false;
    glm::fvec4 outlineColor_{.0, .0, .0, .0};
    float outlineWidth_ = .0;
    std::optional<std::array<float, 4>> nearFarScale_;

    std::vector<FeatureStyleRule> firstOfRules_;
};

}
