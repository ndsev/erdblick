#pragma once

#include "mapget/model/geometry.h"
#include "simfil/model/nodes.h"
#include "simfil/overlay.h"
#include "yaml-cpp/yaml.h"

#include "color.h"

#include <functional>
#include <regex>
#include <variant>

namespace erdblick
{

/**
 * Simfil expression evaluation lambda, bound to a particular context model node.
 */
struct BoundEvalFun
{
    using EvalRef = simfil::Value(*)(void*, std::string const&);
    using ReportIssueRef = void(*)(
        void*,
        std::string const&,
        std::string const&,
        std::string const&,
        uint32_t);

    std::function<simfil::Value(std::string const& expr)> eval_;
    std::function<void(
        std::string const& property,
        std::string const& expression,
        std::string const& message,
        uint32_t ruleIndex)> reportIssue_;
    void* context_ = nullptr;
    EvalRef evalRef_ = nullptr;
    ReportIssueRef reportIssueRef_ = nullptr;

    /** Evaluate through the allocation-free reference or owning fallback callback. */
    [[nodiscard]] simfil::Value evaluate(std::string const& expression) const;
    /** Report a style issue through the configured reference or owning callback. */
    void reportIssue(
        std::string const& property,
        std::string const& expression,
        std::string const& message,
        uint32_t ruleIndex) const;
    /** Return whether either callback representation can report style issues. */
    [[nodiscard]] bool hasIssueReporter() const;
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
    enum Scope {
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

    /** Selects how a relation helper line chooses its endpoint positions. */
    enum class RelationLineGeometry {
        Centers,
        NearestEndpoints,
    };

    /** Unit system used by the lateral component of line offsets. */
    enum class LateralOffsetUnit {
        Meter,
        Pixel,
    };

    /** Describes how nested rule fragments are evaluated. */
    enum class BranchMode {
        None,
        FirstOf,
        AllOf
    };

    /** Static result metadata used for client-owned rule traversal. */
    struct MatchContext {
        std::string_view featureType;
        std::optional<std::string_view> relationName;
        std::optional<std::string_view> attributeName;
        std::optional<std::string_view> attributeLayer;
        std::optional<bool> hasValidity;
    };

    /** Visit every matching concrete leaf using only metadata and projected scalars. */
    bool forEachMatchingRule(
        MatchContext const& context,
        BoundEvalFun const& entryEvalFun,
        std::function<void(FeatureStyleRule const&)> const& callback,
        BoundEvalFun const* featureEvalFun = nullptr) const;
    /** Visit all concrete renderable leaf rules without evaluating feature gates. */
    void forEachConcreteRule(std::function<void(FeatureStyleRule const&)> const& callback) const;
    /** Assign stable render identities to concrete leaf rules in source order. */
    void assignRenderRuleIndices(uint32_t& nextRenderRuleIndex);
    /** Cheap type prefilter used before building a full evaluation context. */
    [[nodiscard]] bool maybeMatchesType(std::string_view typeId) const;
    /** Return this node's branch evaluation mode. */
    [[nodiscard]] BranchMode branchMode() const;
    /** Return nested branch rules. */
    [[nodiscard]] std::vector<FeatureStyleRule> const& subRules() const;
    /** Return the rule's target scope. */
    [[nodiscard]] Scope scope() const;
    /** Return the highlight pass this rule belongs to. */
    [[nodiscard]] HighlightMode mode() const;
    /** Return the fidelity mode requested by the rule. */
    [[nodiscard]] Fidelity fidelity() const;
    /** Report whether geometry emitted by this rule may be selected in the UI. */
    [[nodiscard]] bool selectable() const;
    /** Check whether this rule can emit the given named geometry. */
    [[nodiscard]] bool supports(mapget::GeomType g, std::optional<std::string_view> geometryName = {}) const;
    /** Return the raw geometry-type bit mask used by `supports()`. */
    [[nodiscard]] uint32_t geometryTypesMask() const;
    /** Return this node's own mask or the union of descendant concrete masks. */
    [[nodiscard]] uint32_t effectiveGeometryTypesMask() const;
    /** Return the concrete semantic geometry name, or wildcard when absent. */
    [[nodiscard]] std::optional<std::string> const& geometryName() const;
    /** Return one common descendant geometry name, or wildcard on disagreement. */
    [[nodiscard]] std::optional<std::string> effectiveGeometryName() const;

    /** Return this node's host-feature filter expression. */
    [[nodiscard]] std::string const& filter() const;
    /** Return presentation expressions evaluated in this node's active context. */
    [[nodiscard]] std::vector<std::pair<std::string, std::string>> expressionUses() const;

    /** Resolve the effective RGBA color, including expression and color-scale modes. */
    [[nodiscard]] std::optional<glm::fvec4> color(BoundEvalFun const& evalFun) const;
    /** Report whether the rule explicitly overrides the base RGB tint. */
    [[nodiscard]] bool hasExplicitColor() const;
    /** Report whether the rule explicitly overrides opacity. */
    [[nodiscard]] bool hasExplicitOpacity() const;
    /** Return the configured line width or point radius basis value. */
    [[nodiscard]] float width() const;
    /** Resolve a width-scale override against projected entry values. */
    [[nodiscard]] float width(BoundEvalFun const& evalFun) const;
    /** Report whether emitted geometry should participate in depth testing. */
    [[nodiscard]] bool depthTest() const;
    /** Resolve the optional ordinal draw order used to separate coplanar geometry. */
    [[nodiscard]] std::optional<double> zIndex(BoundEvalFun const& evalFun) const;
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
    /** Return a compile-time arrow mode, or no value when it depends on entry data. */
    [[nodiscard]] std::optional<Arrow> constantArrow() const;
    /** Return the outline RGBA color for point/icon/label rendering. */
    [[nodiscard]] glm::fvec4 const& outlineColor() const;
    /** Return the outline thickness in renderer-specific units. */
    [[nodiscard]] float outlineWidth() const;
    /** Return the base local XYZ offset applied before slot-based stacking. */
    [[nodiscard]] glm::dvec3 const& offset() const;
    /** Return the per-slot local XYZ increment used for stacked rendering. */
    [[nodiscard]] glm::dvec3 const& offsetIncrement() const;
    /** Return whether lateral line offsets are world-space metres or screen pixels. */
    [[nodiscard]] LateralOffsetUnit lateralOffsetUnit() const;
    /** Return the optional point-merge grid cell size for feature aggregation. */
    [[nodiscard]] std::optional<glm::dvec3> const& pointMergeGridCellSize() const;

    /** Report whether the rule can resolve an icon URL. */
    [[nodiscard]] bool hasIconUrl() const;
    /** Resolve the icon URL, including expression-backed variants. */
    [[nodiscard]] std::string iconUrl(BoundEvalFun const& evalFun) const;

    /** Return the regex used to filter relation types, if any. */
    [[nodiscard]] std::optional<std::regex> const& relationType() const;
    /** Return the original relation-name regex transported to mapget. */
    [[nodiscard]] std::optional<std::string> const& relationTypePattern() const;
    /** Return the vertical offset used when drawing relation helper lines. */
    [[nodiscard]] float relationLineHeightOffset() const;
    /** Return how relation helper-line endpoints are selected. */
    [[nodiscard]] RelationLineGeometry relationLineGeometry() const;
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
    /** Return the opacity multiplier applied to every label material color. */
    [[nodiscard]] float labelOpacity() const;
    /** Report whether overlapping labels should be hidden by Deck. */
    [[nodiscard]] bool labelCollision() const;
    /** Return the priority used when collision-filtered labels overlap. */
    [[nodiscard]] int32_t labelCollisionPriority() const;
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
    /** Return the stable renderer identity for this concrete rule. */
    [[nodiscard]] uint32_t renderIndex() const;

private:
    /** Parse all supported YAML keys into cached rule fields. */
    void parse(YAML::Node const& yaml);

    /** Map a geometry enum value to the bit used in `geometryTypes_`. */
    static inline uint32_t geomTypeBit(mapget::GeomType const& g) {
        return 1 << static_cast<std::underlying_type_t<mapget::GeomType>>(g);
    }

public:
    /** Dense integer lookup used by small enum-like categorical scales. */
    template<typename T>
    struct DenseIntegerScale {
        int64_t minimum = 0;
        std::vector<std::optional<T>> values;
    };

    /** Typed literal stop used by the Erdblick-only color-scale presentation. */
    struct ColorScaleStop {
        using Key = std::variant<bool, int64_t, double, std::string>;
        Key key;
        glm::fvec4 color;
        std::optional<double> numericKey;
    };
    struct ColorScale {
        enum class Mode { Linear, Categorical };
        Mode mode = Mode::Linear;
        std::string expression;
        std::vector<ColorScaleStop> stops;
        std::optional<glm::fvec4> fallback;
        std::optional<DenseIntegerScale<glm::fvec4>> denseIntegerStops;
    };
    struct WidthScaleStop {
        ColorScaleStop::Key key;
        float width = 0.0f;
        std::optional<double> numericKey;
    };
    struct WidthScale {
        ColorScale::Mode mode = ColorScale::Mode::Linear;
        std::string expression;
        std::vector<WidthScaleStop> stops;
        std::optional<float> fallback;
        std::optional<DenseIntegerScale<float>> denseIntegerStops;
    };
    /** Literal screen-space glow material for vector geometry. */
    struct Glow {
        glm::fvec4 color{0.0f, 0.0f, 0.0f, 1.0f};
        float radius = 0.0f;
        float opacity = 1.0f;
    };

    /** Return the optional screen-space glow attached to emitted geometry. */
    [[nodiscard]] std::optional<Glow> const& glow() const;

private:
    Scope scope_ = Feature;
    HighlightMode mode_ = NoHighlight;
    Fidelity fidelity_ = AnyFidelity;
    bool selectable_ = true;
    uint32_t geometryTypes_ = 0;  // bitfield from GeomType enum
    std::optional<std::string> geometryName_;
    std::optional<std::string> exactType_;
    std::optional<std::regex> type_;
    std::string filter_;
    glm::fvec4 color_{.0, .0, .0, 1.};
    std::string colorExpression_;
    std::optional<ColorScale> colorScale_;
    bool hasExplicitColor_ = false;
    bool hasExplicitOpacity_ = false;
    float width_ = 1.;
    std::optional<WidthScale> widthScale_;
    std::optional<Glow> glow_;
    bool depthTest_ = true;
    std::optional<double> zIndex_;
    std::string zIndexExpression_;
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
    LateralOffsetUnit lateralOffsetUnit_ = LateralOffsetUnit::Meter;
    std::optional<glm::dvec3> pointMergeGridCellSize_;

    // Labels' rules
    std::string labelFont_ = "24px Helvetica";
    glm::fvec4 labelColor_{1., 1., 1., 1.};
    float labelOpacity_ = 1.0f;
    bool labelCollision_ = false;
    int32_t labelCollisionPriority_ = 0;
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
    std::optional<std::string> relationTypePattern_;
    float relationLineHeightOffset_ = 1.0; // Offset of the relation line over the center in m.
    RelationLineGeometry relationLineGeometry_ = RelationLineGeometry::Centers;
    std::shared_ptr<FeatureStyleRule> relationLineEndMarkerStyle_;
    std::shared_ptr<FeatureStyleRule> relationSourceStyle_;
    std::shared_ptr<FeatureStyleRule> relationTargetStyle_;
    bool relationRecursive_ = false;
    bool relationMergeTwoWay_ = false;

    std::optional<std::regex> attributeType_;
    std::optional<std::string> attributeFilter_;
    std::optional<std::regex> attributeLayerType_;
    std::optional<bool> attributeValidityGeometry_;
    BranchMode branchMode_ = BranchMode::None;
    std::vector<FeatureStyleRule> subRules_;

    // Source index of the top-level rule within the style sheet.
    uint32_t index_ = 0;
    // Renderer identity of this concrete leaf rule.
    uint32_t renderIndex_ = 0;
};

}
