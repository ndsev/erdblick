#include "style-filter-plan.h"

#include <algorithm>
#include <cctype>
#include <optional>
#include <set>
#include <sstream>
#include <type_traits>
#include <utility>

#include <nlohmann/json.hpp>

namespace erdblick
{
namespace
{

constexpr std::string_view kMergeCount = "$mergeCount";
constexpr std::string_view kServerMergeCount = "count($features.*)";

bool identifierCharacter(char value)
{
    auto const byte = static_cast<unsigned char>(value);
    return std::isalnum(byte) || value == '_' || value == '$';
}

bool containsIdentifier(
    std::string_view expression,
    std::string_view identifier)
{
    size_t offset = 0;
    while ((offset = expression.find(identifier, offset)) !=
           std::string_view::npos)
    {
        auto const before =
            offset == 0 || !identifierCharacter(expression[offset - 1]);
        auto const end = offset + identifier.size();
        auto const after =
            end == expression.size() ||
            !identifierCharacter(expression[end]);
        if (before && after) {
            return true;
        }
        offset = end;
    }
    return false;
}

struct Predicate
{
    /** Empty means the predicate is unconditionally true. */
    std::optional<std::string> expression;
    bool alwaysFalse = false;
};

Predicate conjunction(Predicate left, Predicate right)
{
    if (left.alwaysFalse || right.alwaysFalse) {
        return Predicate{std::nullopt, true};
    }
    if (!left.expression) {
        return right;
    }
    if (!right.expression) {
        return left;
    }
    return Predicate{
        "(" + *left.expression + ") and (" + *right.expression + ")"};
}

Predicate disjunction(std::vector<Predicate> predicates)
{
    predicates.erase(
        std::remove_if(
            predicates.begin(),
            predicates.end(),
            [](Predicate const& predicate) {
                return predicate.alwaysFalse;
            }),
        predicates.end());
    if (predicates.empty()) {
        return Predicate{std::nullopt, true};
    }
    for (auto const& predicate : predicates) {
        if (!predicate.expression) {
            return {};
        }
    }
    if (predicates.size() == 1) {
        return std::move(predicates.front());
    }
    std::ostringstream result;
    for (size_t index = 0; index < predicates.size(); ++index) {
        if (index) {
            result << " or ";
        }
        result << '(' << *predicates[index].expression << ')';
    }
    return Predicate{result.str()};
}

template <class OwnPredicate>
Predicate eligible(
    FeatureStyleRule const& rule,
    OwnPredicate const& ownPredicate)
{
    Predicate result = ownPredicate(rule);
    if (rule.branchMode() == FeatureStyleRule::BranchMode::None) {
        return result;
    }
    std::vector<Predicate> children;
    children.reserve(rule.subRules().size());
    for (auto const& child : rule.subRules()) {
        children.push_back(eligible(child, ownPredicate));
    }
    return conjunction(
        std::move(result),
        disjunction(std::move(children)));
}

Predicate featurePredicate(FeatureStyleRule const& rule)
{
    return rule.filter().empty()
        ? Predicate{}
        : Predicate{rule.filter()};
}

Predicate eligibleForFeatureType(
    FeatureStyleRule const& rule,
    std::string_view featureType)
{
    if (!rule.maybeMatchesType(featureType)) {
        return Predicate{std::nullopt, true};
    }
    auto result = featurePredicate(rule);
    if (rule.branchMode() ==
        FeatureStyleRule::BranchMode::None)
    {
        return result;
    }
    std::vector<Predicate> children;
    children.reserve(rule.subRules().size());
    for (auto const& child : rule.subRules()) {
        children.push_back(
            eligibleForFeatureType(
                child,
                featureType));
    }
    return conjunction(
        std::move(result),
        disjunction(std::move(children)));
}

Predicate exactGroupPredicate(
    FeatureStyleRule const& rule,
    std::vector<std::string> const& featureTypes)
{
    std::vector<Predicate> predicates;
    predicates.reserve(featureTypes.size());
    for (auto const& featureType : featureTypes) {
        predicates.push_back(
            eligibleForFeatureType(rule, featureType));
    }
    if (predicates.empty()) {
        return Predicate{std::nullopt, true};
    }

    auto const& first = predicates.front();
    auto const equal = std::ranges::all_of(
        predicates,
        [&](Predicate const& predicate) {
            return predicate.alwaysFalse ==
                    first.alwaysFalse &&
                predicate.expression ==
                    first.expression;
        });
    if (equal) {
        return first;
    }

    std::vector<Predicate> guarded;
    guarded.reserve(featureTypes.size());
    for (size_t index = 0;
         index < featureTypes.size();
         ++index)
    {
        auto predicate = predicates[index];
        if (predicate.alwaysFalse) {
            continue;
        }
        auto typeGate = Predicate{
            "typeId == " +
            nlohmann::json(
                featureTypes[index])
                .dump()};
        guarded.push_back(
            conjunction(
                std::move(typeGate),
                std::move(predicate)));
    }
    return disjunction(std::move(guarded));
}

Predicate attributeEntryPredicate(FeatureStyleRule const& rule)
{
    auto regexLiteral = [](std::string_view pattern) {
        std::string result = "re\"";
        result.reserve(pattern.size() + 4U);
        for (auto const character : pattern) {
            if (character == '"') {
                result.push_back('\\');
            }
            result.push_back(character);
        }
        result.push_back('"');
        return result;
    };
    auto result = rule.attributeFilter()
        ? Predicate{*rule.attributeFilter()}
        : Predicate{};
    if (auto const& pattern = rule.attributeTypePattern()) {
        result = conjunction(
            std::move(result),
            Predicate{"$name == " + regexLiteral(*pattern)});
    }
    if (auto const& pattern = rule.attributeLayerTypePattern()) {
        result = conjunction(
            std::move(result),
            Predicate{"$layer == " + regexLiteral(*pattern)});
    }
    if (auto const& hasValidity = rule.attributeValidityGeometry()) {
        result = conjunction(
            std::move(result),
            Predicate{
                std::string("$hasValidity == ") +
                (*hasValidity ? "true" : "false")});
    }
    return result;
}

bool membershipUsesMergeCount(
    FeatureStyleRule const& rule)
{
    if (containsIdentifier(
            rule.filter(),
            kMergeCount) ||
        (rule.attributeFilter() &&
         containsIdentifier(
             *rule.attributeFilter(),
             kMergeCount)))
    {
        return true;
    }
    return std::ranges::any_of(
        rule.subRules(),
        membershipUsesMergeCount);
}

class StableFields
{
public:
    void append(std::string expression)
    {
        if (expression.empty() ||
            !seen_.insert(expression).second)
        {
            return;
        }
        values_.push_back(std::move(expression));
    }

    [[nodiscard]] std::vector<std::string> take()
    {
        return std::move(values_);
    }

private:
    std::set<std::string> seen_;
    std::vector<std::string> values_;
};

struct ExpressionCollection
{
    StableFields feature;
    StableFields entry;
    bool usesMergeCount = false;
};

void appendExpression(
    ExpressionCollection& result,
    StableFields& fields,
    std::string const& expression,
    bool group)
{
    if (expression.empty()) {
        return;
    }
    auto const hasMergeCount =
        containsIdentifier(expression, kMergeCount);
    result.usesMergeCount =
        result.usesMergeCount || hasMergeCount;
    fields.append(
        group
            ? expandStyleExpressionForFilter(expression)
            : expression);
}

void collectFeatureTree(
    FeatureStyleRule const& rule,
    ExpressionCollection& result,
    bool group,
    bool serverGatedRoot = false)
{
    for (auto const& [property, expression] :
         rule.expressionUses())
    {
        if (property == "attribute-filter" ||
            (serverGatedRoot && property == "filter"))
        {
            continue;
        }
        appendExpression(
            result,
            group ? result.entry : result.feature,
            expression,
            group);
    }
    for (auto const& child : rule.subRules()) {
        collectFeatureTree(child, result, group);
    }
}

void collectAttributeTree(
    FeatureStyleRule const& rule,
    ExpressionCollection& result)
{
    for (auto const& [property, expression] :
         rule.expressionUses())
    {
        appendExpression(
            result,
            property == "filter"
                ? result.feature
                : result.entry,
            expression,
            false);
    }
    for (auto const& child : rule.subRules()) {
        collectAttributeTree(child, result);
    }
}

void collectRelationEntryTree(
    FeatureStyleRule const& rule,
    ExpressionCollection& result)
{
    for (auto const& [_, expression] : rule.expressionUses()) {
        appendExpression(
            result,
            result.entry,
            expression,
            false);
    }
    for (auto const& child : rule.subRules()) {
        collectRelationEntryTree(child, result);
    }
}

std::vector<std::string> concreteFeatureTypes(
    FeatureStyleRule const& rule,
    mapget::LayerInfo const& layerInfo)
{
    std::vector<std::string> result;
    for (auto const& featureType : layerInfo.featureTypes_) {
        if (rule.maybeMatchesType(featureType.name_)) {
            result.push_back(featureType.name_);
        }
    }
    return result;
}

struct GroupDefinition
{
    bool any = false;
    bool all = true;
    bool sameSize = true;
    std::optional<glm::dvec3> size;
};

bool sameVector(glm::dvec3 const& left, glm::dvec3 const& right)
{
    return left.x == right.x &&
        left.y == right.y &&
        left.z == right.z;
}

GroupDefinition groupDefinition(FeatureStyleRule const& rule)
{
    GroupDefinition result;
    rule.forEachConcreteRule(
        [&](FeatureStyleRule const& concrete) {
            auto const& size =
                concrete.pointMergeGridCellSize();
            result.any = result.any || size.has_value();
            result.all = result.all && size.has_value();
            if (!size) {
                return;
            }
            if (!result.size) {
                result.size = *size;
            }
            else if (!sameVector(*result.size, *size)) {
                result.sameSize = false;
            }
        });
    return result;
}

struct GeometryNameDefinition
{
    bool initialized = false;
    bool compatible = true;
    std::optional<std::string> name;
};

void mergeGeometryNames(
    GeometryNameDefinition& result,
    FeatureStyleRule const& rule)
{
    rule.forEachConcreteRule(
        [&](FeatureStyleRule const& concrete) {
            auto const& name = concrete.geometryName();
            if (!result.initialized) {
                result.initialized = true;
                result.name = name;
                return;
            }
            if (result.name != name) {
                result.compatible = false;
                result.name.reset();
            }
        });
}

uint32_t geometryBit(mapget::GeomType type)
{
    return uint32_t{1} <<
        static_cast<std::underlying_type_t<mapget::GeomType>>(type);
}

void addIssue(
    StyleFilterPlan& plan,
    FeatureStyleRule const& rule,
    std::string message)
{
    plan.valid = false;
    plan.issues.push_back(
        StyleFilterPlanIssue{
            rule.index(),
            std::move(message)});
}

bool canShareFeatureChannel(
    mapget::FeatureLayerFilterChannel const& left,
    mapget::FeatureLayerFilterChannel const& right)
{
    return left.scope_ == mapget::FeatureLayerFilterScope::Feature &&
        right.scope_ == mapget::FeatureLayerFilterScope::Feature &&
        !left.group_ && !right.group_ &&
        !left.relation_ && !right.relation_ &&
        left.rewrite_ == right.rewrite_ &&
        left.featureTypes_ == right.featureTypes_ &&
        left.featureFilter_ == right.featureFilter_ &&
        left.entryFilter_ == right.entryFilter_ &&
        left.geometryTypes_ == right.geometryTypes_ &&
        left.geometryName_ == right.geometryName_;
}

void appendUniqueFields(
    std::vector<std::string>& target,
    std::vector<std::string> const& source)
{
    for (auto const& field : source) {
        if (std::ranges::find(target, field) == target.end()) {
            target.push_back(field);
        }
    }
}

void appendChannel(
    StyleFilterPlan& plan,
    mapget::FeatureLayerFilterChannel channel,
    uint32_t ruleIndex)
{
    auto const shared = std::ranges::find_if(
        plan.channels,
        [&](mapget::FeatureLayerFilterChannel const& candidate) {
            return canShareFeatureChannel(candidate, channel);
        });
    if (shared == plan.channels.end()) {
        plan.channels.push_back(std::move(channel));
        return;
    }
    if (shared->channelId_.starts_with("style-rule:")) {
        shared->channelId_.replace(0, std::string_view("style-rule:").size(),
                                   "style-rules:");
    }
    shared->channelId_ += "," + std::to_string(ruleIndex);
    appendUniqueFields(shared->featureFields_, channel.featureFields_);
    appendUniqueFields(shared->entryFields_, channel.entryFields_);
}

std::string scopeName(mapget::FeatureLayerFilterScope scope)
{
    switch (scope) {
    case mapget::FeatureLayerFilterScope::Feature:
        return "feature";
    case mapget::FeatureLayerFilterScope::Attribute:
        return "attribute";
    case mapget::FeatureLayerFilterScope::Relation:
        return "relation";
    case mapget::FeatureLayerFilterScope::Auto:
        return "auto";
    }
    return "feature";
}

JsValue stringList(std::vector<std::string> const& values)
{
    auto result = JsValue::List();
    for (auto const& value : values) {
        result.push(JsValue(value));
    }
    return result;
}

JsValue channelToJsValue(
    mapget::FeatureLayerFilterChannel const& channel)
{
    auto result = JsValue::Dict({
        {"channelId", JsValue(channel.channelId_)},
        {"scope", JsValue(scopeName(channel.scope_))},
        {"rewrite", JsValue(channel.rewrite_)},
        {"featureTypes", stringList(channel.featureTypes_)},
        {"featureFields", stringList(channel.featureFields_)},
        {"entryFields", stringList(channel.entryFields_)},
        {"geometryTypes", JsValue(channel.geometryTypes_)},
        {"geometryName",
         JsValue(channel.geometryName_.value_or("*"))},
    });
    if (channel.featureFilter_) {
        result.set(
            "featureFilter",
            JsValue(*channel.featureFilter_));
    }
    if (channel.entryFilter_) {
        result.set(
            "entryFilter",
            JsValue(*channel.entryFilter_));
    }
    if (channel.group_) {
        result.set(
            "group",
            JsValue::Dict({
                {"kind", JsValue("point-grid")},
                {"origin", JsValue::List({
                    JsValue(channel.group_->origin_.x),
                    JsValue(channel.group_->origin_.y),
                    JsValue(channel.group_->origin_.z),
                })},
                {"cellSize", JsValue::List({
                    JsValue(channel.group_->cellSize_.x),
                    JsValue(channel.group_->cellSize_.y),
                    JsValue(channel.group_->cellSize_.z),
                })},
            }));
    }
    if (channel.relation_) {
        auto relation = JsValue::Dict({
            {"recursive",
             JsValue(channel.relation_->recursive_)},
            {"mergeTwoway",
             JsValue(channel.relation_->mergeTwoway_)},
        });
        if (channel.relation_->relationNamePattern_) {
            relation.set(
                "namePattern",
                JsValue(
                    *channel.relation_
                         ->relationNamePattern_));
        }
        result.set("relation", relation);
    }
    return result;
}

}

std::string expandStyleExpressionForFilter(
    std::string_view expression)
{
    std::string result;
    result.reserve(expression.size());
    size_t cursor = 0;
    while (cursor < expression.size()) {
        auto const offset =
            expression.find(kMergeCount, cursor);
        if (offset == std::string_view::npos) {
            result.append(expression.substr(cursor));
            break;
        }
        auto const before =
            offset == 0 ||
            !identifierCharacter(expression[offset - 1]);
        auto const end = offset + kMergeCount.size();
        auto const after =
            end == expression.size() ||
            !identifierCharacter(expression[end]);
        if (!before || !after) {
            result.append(
                expression.substr(cursor, end - cursor));
            cursor = end;
            continue;
        }
        result.append(
            expression.substr(cursor, offset - cursor));
        result.append(kServerMergeCount);
        cursor = end;
    }
    return result;
}

StyleFilterPlan planStyleFilter(
    FeatureLayerStyle const& style,
    mapget::LayerInfo const& layerInfo,
    FeatureStyleRule::HighlightMode highlightMode,
    uint8_t lod)
{
    StyleFilterPlan plan;
    if (!style.isValid()) {
        plan.valid = false;
        plan.issues.push_back(
            {0, "Cannot plan an invalid stylesheet."});
        return plan;
    }

    for (auto const& rule : style.rules()) {
        if (!rule.supportsMode(highlightMode) ||
            !rule.supportsLod(lod))
        {
            continue;
        }

        auto featureTypes =
            concreteFeatureTypes(rule, layerInfo);
        if (featureTypes.empty()) {
            continue;
        }

        mapget::FeatureLayerFilterChannel channel;
        channel.channelId_ =
            "style-rule:" + std::to_string(rule.index());
        channel.featureTypes_ = std::move(featureTypes);
        channel.rewrite_ = false;

        auto group = groupDefinition(rule);
        if (group.any &&
            (!group.all || !group.sameSize || !group.size))
        {
            addIssue(
                plan,
                rule,
                "One top-level rule cannot mix grouped and ungrouped leaves or point-grid cell sizes.");
            continue;
        }

        ExpressionCollection expressions;
        if (group.any) {
            if (rule.scope() !=
                FeatureStyleRule::Feature)
            {
                addIssue(
                    plan,
                    rule,
                    "Point-grid grouping initially supports feature-scope rules only.");
                continue;
            }
            if (membershipUsesMergeCount(rule)) {
                addIssue(
                    plan,
                    rule,
                    "$mergeCount cannot participate in pre-group membership filters.");
                continue;
            }

            auto names = GeometryNameDefinition{};
            mergeGeometryNames(names, rule);
            if (!names.compatible) {
                addIssue(
                    plan,
                    rule,
                    "Point-grid leaves require one identical geometry-name selector, including wildcard.");
                continue;
            }
            auto const pointBit =
                geometryBit(mapget::GeomType::Points);
            bool pointOnly = true;
            rule.forEachConcreteRule(
                [&](FeatureStyleRule const& concrete) {
                    pointOnly =
                        pointOnly &&
                        concrete.geometryTypesMask() ==
                            pointBit;
                });
            if (!pointOnly) {
                addIssue(
                    plan,
                    rule,
                    "Point-grid leaves must select only point geometry.");
                continue;
            }

            collectFeatureTree(rule, expressions, true);
            channel.scope_ =
                mapget::FeatureLayerFilterScope::Feature;
            channel.geometryTypes_ = pointBit;
            channel.geometryName_ = names.name;
            channel.featureFilter_ =
                exactGroupPredicate(
                    rule,
                    channel.featureTypes_)
                    .expression;
            channel.group_ =
                mapget::FeatureLayerPointGridGroup{
                    glm::dvec3{0.0, 0.0, 0.0},
                    *group.size};
            channel.entryFields_ =
                expressions.entry.take();
        }
        else if (rule.scope() ==
                 FeatureStyleRule::Attribute)
        {
            collectAttributeTree(rule, expressions);
            channel.scope_ =
                mapget::FeatureLayerFilterScope::Attribute;
            channel.geometryTypes_ =
                rule.effectiveGeometryTypesMask();
            channel.geometryName_ =
                rule.effectiveGeometryName();
            channel.featureFilter_ =
                eligible(rule, featurePredicate).expression;
            channel.entryFilter_ =
                eligible(
                    rule,
                    attributeEntryPredicate)
                    .expression;
            channel.featureFields_ =
                expressions.feature.take();
            channel.entryFields_ =
                expressions.entry.take();
        }
        else if (rule.scope() ==
                 FeatureStyleRule::Relation)
        {
            collectRelationEntryTree(
                rule,
                expressions);
            if (auto marker =
                    rule.relationLineEndMarkerStyle())
            {
                collectRelationEntryTree(
                    *marker,
                    expressions);
            }
            if (auto source =
                    rule.relationSourceStyle())
            {
                collectFeatureTree(
                    *source,
                    expressions,
                    false);
            }
            if (auto target =
                    rule.relationTargetStyle())
            {
                collectFeatureTree(
                    *target,
                    expressions,
                    false);
            }

            channel.scope_ =
                mapget::FeatureLayerFilterScope::Relation;
            // The outer line is synthesized from endpoint centers. Restricting
            // copied endpoint geometry to the outer rule's "line" presentation
            // mask would make point-to-point relations disappear.
            channel.geometryTypes_ =
                mapget::FeatureLayerFilterChannel::
                    AllGeometryTypes;
            auto names = GeometryNameDefinition{};
            mergeGeometryNames(names, rule);
            if (auto source =
                    rule.relationSourceStyle())
            {
                mergeGeometryNames(names, *source);
            }
            if (auto target =
                    rule.relationTargetStyle())
            {
                mergeGeometryNames(names, *target);
            }
            channel.geometryName_ =
                names.compatible ? names.name : std::nullopt;
            channel.entryFilter_ =
                rule.filter().empty()
                    ? std::nullopt
                    : std::optional<std::string>{
                          rule.filter()};
            channel.featureFields_ =
                expressions.feature.take();
            channel.entryFields_ =
                expressions.entry.take();
            channel.relation_ =
                mapget::FeatureLayerStoredRelationOptions{
                    rule.relationTypePattern(),
                    rule.relationRecursive(),
                    rule.relationMergeTwoWay(),
                };
        }
        else {
            collectFeatureTree(
                rule,
                expressions,
                false,
                true);
            channel.scope_ =
                mapget::FeatureLayerFilterScope::Feature;
            channel.geometryTypes_ =
                rule.effectiveGeometryTypesMask();
            channel.geometryName_ =
                rule.effectiveGeometryName();
            channel.featureFilter_ =
                eligible(rule, featurePredicate).expression;
            channel.featureFields_ =
                expressions.feature.take();
        }

        if (expressions.usesMergeCount &&
            !channel.group_)
        {
            addIssue(
                plan,
                rule,
                "$mergeCount is supported only by feature-scope point-grid rules.");
            continue;
        }

        appendChannel(plan, std::move(channel), rule.index());
    }

    return plan;
}

NativeJsValue StyleFilterPlan::toJsValue() const
{
    auto channelList = JsValue::List();
    for (auto const& channel : channels) {
        channelList.push(channelToJsValue(channel));
    }
    auto issueList = JsValue::List();
    for (auto const& issue : issues) {
        issueList.push(
            JsValue::Dict({
                {"ruleIndex",
                 JsValue(issue.ruleIndex)},
                {"message", JsValue(issue.message)},
            }));
    }
    return *JsValue::Dict({
        {"valid", JsValue(valid)},
        {"channels", channelList},
        {"issues", issueList},
    });
}

}
