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

    [[nodiscard]] bool hasLabel() const;
    [[nodiscard]] std::string labelFont() const;
    [[nodiscard]] glm::fvec4 const& labelColor() const;
    [[nodiscard]] glm::fvec4 const& labelOutlineColor() const;
    [[nodiscard]] glm::fvec4 const& labelBackgroundColor() const;
    [[nodiscard]] std::pair<int, int> const& labelBackgroundPadding() const;
    [[nodiscard]] std::string labelHorizontalOrigin() const;
    [[nodiscard]] std::string labelVerticalOrigin() const;
    [[nodiscard]] std::string labelHeightReference() const;
    [[nodiscard]] std::string labelTextExpression() const;
    [[nodiscard]] std::string labelText(BoundEvalFun const& evalFun) const;
    [[nodiscard]] std::string labelStyle() const;
    [[nodiscard]] float labelScale() const;
    [[nodiscard]] std::optional<std::pair<float, float>> const& labelPixelOffset() const;
    [[nodiscard]] std::optional<std::tuple<float, float, float>> const& labelEyeOffset() const;
    [[nodiscard]] std::optional<std::array<float, 4>> const& translucencyByDistance() const;

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

    // Labels' rules
    bool hasLabel_ = false;
    std::string labelFont_ = "24px Helvetica";
    glm::fvec4 labelColor_{1., 1., 1., 1.};
    glm::fvec4 labelOutlineColor_{.0, .0, .0, .0};
    glm::fvec4 labelBackgroundColor_{.0, .0, .0, .0};
    std::pair<int, int> labelBackgroundPadding_{0, 0};
    std::string labelHorizontalOrigin_ = "CENTER";
    std::string labelVerticalOrigin_ = "CENTER";
    std::string labelHeightReference_ = "NONE";
    std::string labelTextExpression_ = "";
    std::string labelText_ = "";
    std::string labelStyle_ = "FILL_AND_OUTLINE";
    float labelScale_ = 1.;
    std::optional<std::pair<float, float>> labelPixelOffset_;
    std::optional<std::tuple<float, float, float>> labelEyeOffset_;
    std::optional<std::array<float, 4>> translucencyByDistance_;

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
