#pragma once

#include "mapget/model/featurelayer.h"
#include "simfil/model/nodes.h"
#include "simfil/overlay.h"
#include "yaml-cpp/yaml.h"

#include "color.h"

#include <regex>

namespace erdblick
{

/**
 * Simfil expression evaluation lambda, bound to a particular context model node.
 */
struct BoundEvalFun
{
    simfil::model_ptr<simfil::OverlayNode> context_;
    std::function<simfil::Value(std::string const& expr)> eval_;
};

/**
 * Parsed representation of one YAML style rule.
 *
 * The rule keeps both literal values and expression-backed values so rendering
 * code can cheaply ask for the effective style in a concrete feature/attribute
 * context without reparsing YAML.
 */
class FeatureStyleRule
{
public:
    /** Parse a rule from YAML and remember its index within the style sheet. */
    explicit FeatureStyleRule(YAML::Node const& yaml, uint32_t index=0);
    /** Clone a rule, optionally clearing fields that should not propagate to nested styles. */
    FeatureStyleRule(FeatureStyleRule const& other, bool resetNonInheritableAttrs=false);

    /** Selects whether the rule runs against whole features, relations, or attributes. */
    enum Aspect {
        Feature,
        Relation,
        Attribute
    };

    /** Restricts the rule to the regular render pass or one of the highlight passes. */
    enum HighlightMode {
        NoHighlight,
        HoverHighlight,
        SelectionHighlight
    };

    /** Restricts the rule to a specific fidelity mode or lets the caller choose. */
    enum Fidelity {
        AnyFidelity,
        HighFidelity,
        LowFidelity
    };

    /** Describes whether polylines should receive directional arrow heads. */
    enum Arrow {
        NoArrow,
        ForwardArrow,
        BackwardArrow,
        DoubleArrow
    };

    /** Return this rule when it matches the feature and current evaluation context. */
    FeatureStyleRule const* match(mapget::Feature& feature, BoundEvalFun const& evalFun) const;
    /** Cheap type prefilter used before building a full evaluation context. */
    [[nodiscard]] bool maybeMatchesType(std::string_view typeId) const;
    /** Return the rule's target aspect. */
    [[nodiscard]] Aspect aspect() const;
    /** Return the highlight pass this rule belongs to. */
    [[nodiscard]] HighlightMode mode() const;
    /** Return the fidelity mode requested by the rule. */
    [[nodiscard]] Fidelity fidelity() const;
    /** Return the required geometry/data stage override, if the rule pins one. */
    [[nodiscard]] std::optional<uint32_t> stage() const;
    /** Return the low-fi LOD bucket restriction, if one was configured. */
    [[nodiscard]] std::optional<uint8_t> lod() const;
    /** Report whether geometry emitted by this rule may be selected in the UI. */
    [[nodiscard]] bool selectable() const;
    /** Check whether this rule can emit the given geometry type and stage. */
    [[nodiscard]] bool supports(
        mapget::GeomType const& g,
        std::optional<uint32_t> geometryStage={}) const;
    /** Return the raw geometry-type bit mask used by `supports()`. */
    [[nodiscard]] uint32_t geometryTypesMask() const;

    /** Resolve the effective RGBA color, including optional color expressions. */
    [[nodiscard]] glm::fvec4 color(BoundEvalFun const& evalFun) const;
    /** Report whether the rule explicitly overrides the base RGB tint. */
    [[nodiscard]] bool hasExplicitColor() const;
    /** Report whether the rule explicitly overrides opacity. */
    [[nodiscard]] bool hasExplicitOpacity() const;
    /** Return the configured line width or point radius basis value. */
    [[nodiscard]] float width() const;
    /** Report whether emitted geometry should participate in depth testing. */
    [[nodiscard]] bool depthTest() const;
    /** Return the billboard override, or `std::nullopt` to use renderer defaults. */
    [[nodiscard]] std::optional<bool> const& billboard() const;
    /** Report whether geometry should be flattened onto the 2D/ground plane. */
    [[nodiscard]] bool flat() const;
    /** Report whether polyline rendering should use a dash pattern. */
    [[nodiscard]] bool isDashed() const;
    /** Return the dash segment length in pixels. */
    [[nodiscard]] int dashLength() const;
    /** Return the color used for the "off" segments of dashed lines. */
    [[nodiscard]] glm::fvec4 const& gapColor() const;
    /** Return the 8-bit dash pattern mask. */
    [[nodiscard]] int dashPattern() const;
    /** Resolve arrow direction, including optional expression-backed overrides. */
    [[nodiscard]] Arrow arrow(BoundEvalFun const& evalFun) const;
    /** Return the outline RGBA color for point/icon/label rendering. */
    [[nodiscard]] glm::fvec4 const& outlineColor() const;
    /** Return the outline thickness in renderer-specific units. */
    [[nodiscard]] float outlineWidth() const;
    /** Return the base local XYZ offset applied before slot-based stacking. */
    [[nodiscard]] glm::dvec3 const& offset() const;
    /** Return the per-slot local XYZ increment used for stacked rendering. */
    [[nodiscard]] glm::dvec3 const& offsetIncrement() const;
    /** Return the optional point-merge grid cell size for feature aggregation. */
    [[nodiscard]] std::optional<glm::dvec3> const& pointMergeGridCellSize() const;

    /** Report whether the rule can resolve an icon URL. */
    [[nodiscard]] bool hasIconUrl() const;
    /** Resolve the icon URL, including expression-backed variants. */
    [[nodiscard]] std::string iconUrl(BoundEvalFun const& evalFun) const;

    /** Return the regex used to filter relation types, if any. */
    [[nodiscard]] std::optional<std::regex> const& relationType() const;
    /** Return the vertical offset used when drawing relation helper lines. */
    [[nodiscard]] float relationLineHeightOffset() const;
    /** Return the optional style used for relation end markers. */
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationLineEndMarkerStyle() const;
    /** Return the optional style recursively applied to relation source features. */
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationSourceStyle() const;
    /** Return the optional style recursively applied to relation target features. */
    [[nodiscard]] std::shared_ptr<FeatureStyleRule> relationTargetStyle() const;
    /** Report whether recursive relation traversal is enabled for this rule. */
    [[nodiscard]] bool relationRecursive() const;
    /** Report whether opposite directed relations should be merged into one visualization. */
    [[nodiscard]] bool relationMergeTwoWay() const;

    /** Return the regex used to filter attribute types, if any. */
    [[nodiscard]] std::optional<std::regex> const& attributeType() const;
    /** Return the optional simfil filter applied inside matched attributes. */
    [[nodiscard]] std::optional<std::string> const& attributeFilter() const;
    /** Return the regex used to filter attribute layer names, if any. */
    [[nodiscard]] std::optional<std::regex> const& attributeLayerType() const;
    /** Return whether the rule explicitly requests validity geometry instead of host geometry. */
    [[nodiscard]] std::optional<bool> const& attributeValidityGeometry() const;
    /** Report whether this rule can emit a label. */
    [[nodiscard]] bool hasLabel() const;
    /** Return the CSS-like font string for labels. */
    [[nodiscard]] std::string const& labelFont() const;
    /** Return the label fill color. */
    [[nodiscard]] glm::fvec4 const& labelColor() const;
    /** Return the label outline color. */
    [[nodiscard]] glm::fvec4 const& labelOutlineColor() const;
    /** Return the label outline width. */
    [[nodiscard]] float labelOutlineWidth() const;
    /** Report whether a label background rectangle should be drawn. */
    [[nodiscard]] bool showBackground() const;
    /** Return the background fill color for labels. */
    [[nodiscard]] glm::fvec4 const& labelBackgroundColor() const;
    /** Return pixel padding applied around label background rectangles. */
    [[nodiscard]] std::pair<int, int> const& labelBackgroundPadding() const;
    /** Return the deck horizontal-origin string for labels. */
    [[nodiscard]] std::string const& labelHorizontalOrigin() const;
    /** Return the deck vertical-origin string for labels. */
    [[nodiscard]] std::string const& labelVerticalOrigin() const;
    /** Return the deck height-reference string for labels. */
    [[nodiscard]] std::string const& labelHeightReference() const;
    /** Return the raw label text expression, if one was configured. */
    [[nodiscard]] std::string const& labelTextExpression() const;
    /** Resolve the effective label text for the current evaluation context. */
    [[nodiscard]] std::string labelText(BoundEvalFun const& evalFun) const;
    /** Return the renderer-specific label style keyword. */
    [[nodiscard]] std::string const& labelStyle() const;
    /** Return the label scale multiplier. */
    [[nodiscard]] float labelScale() const;
    /** Return an optional screen-space pixel offset for labels. */
    [[nodiscard]] std::optional<std::pair<float, float>> const& labelPixelOffset() const;
    /** Return an optional eye-space XYZ offset for labels. */
    [[nodiscard]] std::optional<std::tuple<float, float, float>> const& labelEyeOffset() const;

    /** Return the stable index of this rule inside its style sheet. */
    [[nodiscard]] uint32_t const& index() const;

private:
    /** Parse all supported YAML keys into cached rule fields. */
    void parse(YAML::Node const& yaml);

    /** Map a geometry enum value to the bit used in `geometryTypes_`. */
    static inline uint32_t geomTypeBit(mapget::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::GeomType>>(g);
    }

    Aspect aspect_ = Feature;
    HighlightMode mode_ = NoHighlight;
    Fidelity fidelity_ = AnyFidelity;
    std::optional<uint32_t> stage_;
    std::optional<uint8_t> lod_;
    bool selectable_ = true;
    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    std::string colorExpression_;
    bool hasExplicitColor_ = false;
    bool hasExplicitOpacity_ = false;
    float width_ = 1.;
    bool depthTest_ = true;
    std::optional<bool> billboard_;
    bool flat_ = false;
    bool dashed_ = false;
    int dashLength_ = 16;
    glm::fvec4 gapColor_{.0, .0, .0, 0.};
    int dashPattern_ = 255;
    Arrow arrow_ = NoArrow;
    std::string arrowExpression_;
    glm::fvec4 outlineColor_{.0, .0, .0, .0};
    float outlineWidth_ = .0;
    glm::dvec3 offset_{.0, .0, .0};
    glm::dvec3 offsetIncrement_{.0, .0, .0};
    std::optional<glm::dvec3> pointMergeGridCellSize_;

    // Labels' rules
    std::string labelFont_ = "24px Helvetica";
    glm::fvec4 labelColor_{1., 1., 1., 1.};
    glm::fvec4 labelOutlineColor_{.0, .0, .0, .1};
    float labelOutlineWidth_ = .1;
    bool showBackground_ = false;
    glm::fvec4 labelBackgroundColor_{.0, .0, .0, .0};
    std::pair<int, int> labelBackgroundPadding_{0, 0};
    std::string labelHorizontalOrigin_ = "CENTER";
    std::string labelVerticalOrigin_ = "CENTER";
    std::string labelHeightReference_ = "NONE";
    std::string labelTextExpression_;
    std::string labelText_;
    std::string labelStyle_ = "FILL";
    float labelScale_ = 1.;
    std::optional<std::pair<float, float>> labelPixelOffset_;
    std::optional<std::tuple<float, float, float>> labelEyeOffset_;

    std::string iconUrl_;
    std::string iconUrlExpression_;

    std::optional<std::regex> relationType_;
    float relationLineHeightOffset_ = 1.0; // Offset of the relation line over the center in m.
    std::shared_ptr<FeatureStyleRule> relationLineEndMarkerStyle_;
    std::shared_ptr<FeatureStyleRule> relationSourceStyle_;
    std::shared_ptr<FeatureStyleRule> relationTargetStyle_;
    bool relationRecursive_ = false;
    bool relationMergeTwoWay_ = false;

    std::optional<std::regex> attributeType_;
    std::optional<std::string> attributeFilter_;
    std::optional<std::regex> attributeLayerType_;
    std::optional<bool> attributeValidityGeometry_;
    std::vector<FeatureStyleRule> firstOfRules_;

    // Index of the rule within the style sheet
    uint32_t index_ = 0;
};

}
