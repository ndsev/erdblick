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

    enum Aspect {
        Feature,
        Relation,
        Attribute
    };

    FeatureStyleRule const* match(mapget::Feature& feature) const;
    [[nodiscard]] Aspect aspect() const;
    [[nodiscard]] bool supports(mapget::Geometry::GeomType const& g) const;
    [[nodiscard]] glm::fvec4 const& color() const;
    [[nodiscard]] float width() const;
    [[nodiscard]] bool flat() const;
    [[nodiscard]] std::string materialColor() const;
    [[nodiscard]] bool isDashed() const;
    [[nodiscard]] int dashLength() const;
    [[nodiscard]] std::string gapColor() const;
    [[nodiscard]] int dashPattern() const;
    [[nodiscard]] bool hasArrow() const;
    [[nodiscard]] bool hasDoubleArrow() const;
    [[nodiscard]] glm::fvec4 const& outlineColor() const;
    [[nodiscard]] float outlineWidth() const;
    [[nodiscard]] std::optional<std::array<float, 4>> const& nearFarScale() const;
    [[nodiscard]] float relationLineHeightOffset() const;
    [[nodiscard]] bool relationLineEndMarkers() const;

private:
    void parse(YAML::Node const& yaml);

    static inline uint32_t geomTypeBit(mapget::Geometry::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::Geometry::GeomType>>(g);
    }

    Aspect aspect_ = Feature;
    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    std::string materialColor_ = "#ffffff";
    float width_ = 1.;
    bool flat_ = false;
    bool dashed_ = false;
    int dashLength_ = 16;
    std::string gapColor_ = "#ffffff";
    int dashPattern_ = 255;
    bool hasArrow_ = false;
    bool hasDoubleArrow_ = false;
    glm::fvec4 outlineColor_{.0, .0, .0, .0};
    float outlineWidth_ = .0;
    std::optional<std::array<float, 4>> nearFarScale_;

    std::vector<FeatureStyleRule> firstOfRules_;

    float relationLineHeightOffset_ = 1.0; // Offset of the relation line over the center in m.
    bool relationLineEndMarkers_ = false; // Show start/end marker lines?

    // TODO:
    //  - Relation recursion
    //  - Relation bi-directionality detection
    //  - Relation source rule
    //  - Relation destination rule
};

}
