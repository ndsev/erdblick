#pragma once

#include "mapget/model/feature.h"
#include "simfil/model/nodes.h"
#include "yaml-cpp/yaml.h"

#include "color.h"

#include <regex>

namespace erdblick
{

/**
 * Simfil expression evaluation lambda, bound to a particular model node.
 */
using BoundEvalFun = std::function<simfil::Value(std::string const& expr)>;

class FeatureStyleRule
{
public:
    explicit FeatureStyleRule(YAML::Node const& yaml);
    FeatureStyleRule(FeatureStyleRule const& other, bool resetNonInheritableAttrs=false);

    enum Aspect {
        Feature,
        Relation,
        Attribute
    };

    enum Mode {
        Normal,
        Highlight
    };

    enum Arrow {
        NoArrow,
        ForwardArrow,
        BackwardArrow,
        DoubleArrow
    };

    FeatureStyleRule const* match(mapget::Feature& feature) const;
    [[nodiscard]] Aspect aspect() const;
    [[nodiscard]] Mode mode() const;
    [[nodiscard]] bool selectable() const;
    [[nodiscard]] bool supports(mapget::Geometry::GeomType const& g) const;

    [[nodiscard]] glm::fvec4 color(BoundEvalFun const& evalFun) const;
    [[nodiscard]] float width() const;
    [[nodiscard]] bool flat() const;
    [[nodiscard]] bool isDashed() const;
    [[nodiscard]] int dashLength() const;
    [[nodiscard]] glm::fvec4 const& gapColor() const;
    [[nodiscard]] int dashPattern() const;
    [[nodiscard]] Arrow arrow(BoundEvalFun const& evalFun) const;
    [[nodiscard]] glm::fvec4 const& outlineColor() const;
    [[nodiscard]] float outlineWidth() const;
    [[nodiscard]] std::optional<std::array<float, 4>> const& nearFarScale() const;

    [[nodiscard]] std::optional<std::regex> const& relationType() const;
    [[nodiscard]] float relationLineHeightOffset() const;
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationLineEndMarkerStyle() const;
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationSourceStyle() const;
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationTargetStyle() const;
    [[nodiscard]] bool relationRecursive() const;
    [[nodiscard]] bool relationMergeTwoWay() const;

private:
    void parse(YAML::Node const& yaml);

    static inline uint32_t geomTypeBit(mapget::Geometry::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::Geometry::GeomType>>(g);
    }

    Aspect aspect_ = Feature;
    Mode mode_ = Normal;
    bool selectable_ = true;
    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    std::string colorExpression_;
    float width_ = 1.;
    bool flat_ = false;
    bool dashed_ = false;
    int dashLength_ = 16;
    glm::fvec4 gapColor_{.0, .0, .0, 0.};
    int dashPattern_ = 255;
    Arrow arrow_;
    std::string arrowExpression_;
    glm::fvec4 outlineColor_{.0, .0, .0, .0};
    float outlineWidth_ = .0;
    std::optional<std::array<float, 4>> nearFarScale_;

    std::vector<FeatureStyleRule> firstOfRules_;

    std::optional<std::regex> relationType_;
    float relationLineHeightOffset_ = 1.0; // Offset of the relation line over the center in m.
    std::shared_ptr<FeatureStyleRule> relationLineEndMarkerStyle_;
    std::shared_ptr<FeatureStyleRule> relationSourceStyle_;
    std::shared_ptr<FeatureStyleRule> relationTargetStyle_;
    bool relationRecursive_ = false;
    bool relationMergeTwoWay_ = false;
};

}
