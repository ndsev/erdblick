#include "style-validation.h"

#include "color.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/simfilutil.h"
#include "simfil/simfil.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <ranges>
#include <regex>
#include <set>
#include <sstream>

namespace erdblick
{

namespace {

enum class RuleValidationContext {
    TopLevel,
    Branch,
    RelationFeatureStyle,
    RelationFeatureBranch
};

bool validateStyleRuleYamlImpl(
    YAML::Node const& ruleYaml,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    RuleValidationContext context);

uint64_t nowMillis()
{
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

bool markIsValid(YAML::Mark const& mark)
{
    return mark.pos >= 0 && mark.line >= 0 && mark.column >= 0;
}

template <typename T>
bool readScalar(
    YAML::Node const& parent,
    std::string const& property,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex,
    T* out = nullptr)
{
    auto node = parent[property];
    if (!node.IsDefined()) {
        return true;
    }
    if (!node.IsScalar()) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            property + " must be a scalar.",
            locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        return false;
    }
    try {
        auto value = node.as<T>();
        if (out) {
            *out = value;
        }
        return true;
    } catch (YAML::Exception const& e) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            "Could not parse " + property + ": " + e.msg,
            locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        return false;
    }
}

bool validateEnumValue(
    YAML::Node const& parent,
    std::string const& property,
    std::set<std::string> const& allowed,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex)
{
    std::string value;
    if (!readScalar(parent, property, rulePath, report, ruleIndex, &value)) {
        return false;
    }
    if (value.empty() && !parent[property].IsDefined()) {
        return true;
    }
    if (!parent[property].IsDefined() || allowed.contains(value)) {
        return true;
    }
    std::ostringstream msg;
    msg << "Unsupported " << property << " value '" << value << "'.";
    auto& issue = report.addIssue("error", "schema", "rule-skipped", msg.str(), locationForNode(parent[property]));
    issue.ruleIndex = ruleIndex;
    issue.rulePath = rulePath;
    issue.property = property;
    return false;
}

bool isStyleOptionIdentifier(std::string const& value)
{
    if (value.empty()) {
        return false;
    }
    auto isAlphaOrUnderscore = [](unsigned char ch) {
        return std::isalpha(ch) || ch == '_';
    };
    auto isAlnumOrUnderscore = [](unsigned char ch) {
        return std::isalnum(ch) || ch == '_';
    };
    if (!isAlphaOrUnderscore(static_cast<unsigned char>(value.front()))) {
        return false;
    }
    return std::ranges::all_of(value.substr(1), [&](char ch) {
        return isAlnumOrUnderscore(static_cast<unsigned char>(ch));
    });
}

bool validateRegexValue(
    YAML::Node const& parent,
    std::string const& property,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex,
    std::string impact = "rule-skipped")
{
    std::string value;
    if (!readScalar(parent, property, rulePath, report, ruleIndex, &value)) {
        return false;
    }
    if (!parent[property].IsDefined()) {
        return true;
    }
    try {
        std::regex unused(value);
        (void) unused;
        return true;
    } catch (std::regex_error const& e) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            std::move(impact),
            "Invalid regular expression in " + property + ": " + e.what(),
            locationForNode(parent[property]));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        return false;
    }
}

bool validateColorValue(
    YAML::Node const& parent,
    std::string const& property,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex)
{
    std::string value;
    if (!readScalar(parent, property, rulePath, report, ruleIndex, &value)) {
        return false;
    }
    if (!parent[property].IsDefined()) {
        return true;
    }
    if (Color(value).isValid()) {
        return true;
    }
    auto& issue = report.addIssue(
        "error",
        "schema",
        "rule-skipped",
        "Invalid color value for " + property + ": " + value,
        locationForNode(parent[property]));
    issue.ruleIndex = ruleIndex;
    issue.rulePath = rulePath;
    issue.property = property;
    return false;
}

bool validateNumericRange(
    YAML::Node const& parent,
    std::string const& property,
    double min,
    double max,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex)
{
    double value = 0.0;
    if (!readScalar(parent, property, rulePath, report, ruleIndex, &value)) {
        return false;
    }
    if (!parent[property].IsDefined()) {
        return true;
    }
    if (value >= min && value <= max) {
        return true;
    }
    std::ostringstream msg;
    msg << property << " must be between " << min << " and " << max << ".";
    auto& issue = report.addIssue("error", "schema", "rule-skipped", msg.str(), locationForNode(parent[property]));
    issue.ruleIndex = ruleIndex;
    issue.rulePath = rulePath;
    issue.property = property;
    return false;
}

bool validateVectorSize(
    YAML::Node const& parent,
    std::string const& property,
    size_t expectedSize,
    std::string const& rulePath,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex)
{
    auto node = parent[property];
    if (!node.IsDefined()) {
        return true;
    }
    if (!node.IsSequence() || node.size() != expectedSize) {
        std::ostringstream msg;
        msg << property << " must be a sequence with " << expectedSize << " entries.";
        auto& issue = report.addIssue("error", "schema", "rule-skipped", msg.str(), locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        return false;
    }
    for (size_t i = 0; i < expectedSize; ++i) {
        try {
            (void) node[i].as<double>();
        } catch (YAML::Exception const& e) {
            auto& issue = report.addIssue(
                "error",
                "schema",
                "rule-skipped",
                "Could not parse " + property + " entry: " + e.msg,
                locationForNode(node[i]));
            issue.ruleIndex = ruleIndex;
            issue.rulePath = rulePath;
            issue.property = property;
            return false;
        }
    }
    return true;
}

std::optional<size_t> findScalarOffset(YAML::Node const& node, std::string const& source)
{
    if (!node.IsScalar()) {
        return std::nullopt;
    }
    auto mark = node.Mark();
    if (!markIsValid(mark) || static_cast<size_t>(mark.pos) >= source.size()) {
        return std::nullopt;
    }
    auto scalar = node.Scalar();
    if (scalar.empty()) {
        return static_cast<size_t>(mark.pos);
    }
    auto found = source.find(scalar, static_cast<size_t>(mark.pos));
    if (found == std::string::npos) {
        return std::nullopt;
    }
    return found;
}

StyleSourceLocation locationFromOffset(std::string const& source, size_t offset, uint32_t length)
{
    StyleSourceLocation loc;
    loc.offset = static_cast<uint32_t>(offset);
    loc.length = length;
    uint32_t line = 1;
    uint32_t column = 1;
    auto const clampedOffset = std::min(offset, source.size());
    for (size_t i = 0; i < clampedOffset; ++i) {
        if (source[i] == '\n') {
            ++line;
            column = 1;
        } else {
            ++column;
        }
    }
    loc.line = line;
    loc.column = column;
    return loc;
}

bool validateExpression(
    YAML::Node const& parent,
    std::string const& property,
    bool anyMode,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    std::optional<uint32_t> ruleIndex)
{
    std::string expression;
    if (!readScalar(parent, property, rulePath, report, ruleIndex, &expression)) {
        return false;
    }
    auto node = parent[property];
    if (!node.IsDefined() || expression.empty()) {
        return true;
    }

    auto env = mapget::makeEnvironment(simfil::Environment::WithNewStringCache);
    auto ast = simfil::compile(*env, expression, simfil::CompileOptions{
        .any = anyMode,
        .rewriteMode = simfil::RewriteMode::None});
    if (ast) {
        return true;
    }

    auto loc = locationForExpression(node, source, ast.error().location.offset, ast.error().location.size);
    auto& issue = report.addIssue(
        "error",
        "simfil",
        "rule-skipped",
        "Could not compile " + property + ": " + ast.error().message,
        loc ? loc : std::optional<StyleSourceLocation>(locationForNode(node)));
    issue.ruleIndex = ruleIndex;
    issue.rulePath = rulePath;
    issue.property = property;
    issue.expression = expression;
    return false;
}

bool validateGeometry(YAML::Node const& ruleYaml, std::string const& rulePath, StyleValidationReport& report, uint32_t ruleIndex)
{
    auto node = ruleYaml["geometry"];
    if (!node.IsDefined()) {
        return true;
    }
    static const std::set<std::string> allowed = {"point", "mesh", "line", "polygon", "aabb", "gltf"};
    auto validateOne = [&](YAML::Node const& valueNode) {
        if (!valueNode.IsScalar()) {
            auto& issue = report.addIssue("error", "schema", "rule-skipped", "geometry entries must be scalar.", locationForNode(valueNode));
            issue.ruleIndex = ruleIndex;
            issue.rulePath = rulePath;
            issue.property = "geometry";
            return false;
        }
        auto value = valueNode.as<std::string>();
        if (allowed.contains(value)) {
            return true;
        }
        auto& issue = report.addIssue("error", "schema", "rule-skipped", "Unsupported geometry value '" + value + "'.", locationForNode(valueNode));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = "geometry";
        return false;
    };
    if (node.IsSequence()) {
        if (node.size() == 0) {
            auto& issue = report.addIssue("error", "schema", "rule-skipped", "geometry must not be an empty sequence.", locationForNode(node));
            issue.ruleIndex = ruleIndex;
            issue.rulePath = rulePath;
            issue.property = "geometry";
            return false;
        }
        for (auto const& valueNode : node) {
            if (!validateOne(valueNode)) {
                return false;
            }
        }
        return true;
    }
    return validateOne(node);
}

bool validateColorScale(
    YAML::Node const& ruleYaml,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    uint32_t ruleIndex)
{
    auto scale = ruleYaml["color-scale"];
    if (!scale.IsDefined()) {
        return true;
    }
    auto fail = [&](std::string message, YAML::Node const& node) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            std::move(message),
            locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = "color-scale";
        return false;
    };
    if (!scale.IsMap()) {
        return fail("color-scale must be a map.", scale);
    }
    if (!validateEnumValue(
            scale,
            "mode",
            {"linear", "categorical"},
            rulePath,
            report,
            ruleIndex) ||
        !scale["mode"].IsDefined())
    {
        return false;
    }
    if (!validateExpression(
            scale,
            "expression",
            false,
            rulePath,
            source,
            report,
            ruleIndex) ||
        !scale["expression"].IsDefined() ||
        scale["expression"].Scalar().empty())
    {
        return false;
    }
    auto stops = scale["stops"];
    if (!stops.IsSequence() || stops.size() == 0) {
        return fail("color-scale.stops must be a non-empty list of [value, color] pairs.", stops);
    }

    auto const mode = scale["mode"].Scalar();
    std::optional<double> previousLinear;
    std::set<std::string> categoricalKeys;
    for (auto const& stop : stops) {
        if (!stop.IsSequence() || stop.size() != 2 ||
            !stop[0].IsScalar() || !stop[1].IsScalar())
        {
            return fail("Every color-scale stop must be a two-scalar [value, color] pair.", stop);
        }
        if (!Color(stop[1].Scalar()).isValid()) {
            return fail("color-scale stop contains an invalid literal color.", stop[1]);
        }
        auto const key = stop[0].Scalar();
        if (key == "null" || key == "~") {
            return fail("Null is not a valid color-scale stop key; use fallback.", stop[0]);
        }
        if (mode == "linear") {
            double value = 0.0;
            try {
                value = stop[0].as<double>();
            }
            catch (YAML::Exception const&) {
                return fail("Linear color-scale stop values must be finite numbers.", stop[0]);
            }
            if (!std::isfinite(value) || (previousLinear && value <= *previousLinear)) {
                return fail(
                    "Linear color-scale stops must be finite and strictly increasing.",
                    stop[0]);
            }
            previousLinear = value;
        }
        else {
            std::string normalized;
            auto const tag = stop[0].Tag();
            auto const explicitlyString =
                tag == "!" ||
                tag.ends_with(":str");
            if (explicitlyString) {
                normalized = "s:" + key;
            }
            else if (key == "true" || key == "false") {
                normalized = "b:" + key;
            }
            else {
                char* end = nullptr;
                auto number = std::strtod(key.c_str(), &end);
                if (end == key.c_str() + key.size() && std::isfinite(number)) {
                    std::ostringstream stream;
                    stream.precision(17);
                    stream << number;
                    normalized = "n:" + stream.str();
                }
                else {
                    normalized = "s:" + key;
                }
            }
            if (!categoricalKeys.insert(std::move(normalized)).second) {
                return fail("Categorical color-scale contains a duplicate typed stop key.", stop[0]);
            }
        }
    }
    if (scale["fallback"].IsDefined() &&
        (!scale["fallback"].IsScalar() ||
         !Color(scale["fallback"].Scalar()).isValid()))
    {
        return fail("color-scale.fallback must be a valid literal color.", scale["fallback"]);
    }
    return true;
}

bool validateWidthScale(
    YAML::Node const& ruleYaml,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    uint32_t ruleIndex)
{
    auto scale = ruleYaml["width-scale"];
    if (!scale.IsDefined()) {
        return true;
    }
    auto fail = [&](std::string message, YAML::Node const& node) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            std::move(message),
            locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = "width-scale";
        return false;
    };
    if (!scale.IsMap()) {
        return fail("width-scale must be a map.", scale);
    }
    if (!validateEnumValue(
            scale,
            "mode",
            {"linear", "categorical"},
            rulePath,
            report,
            ruleIndex) ||
        !scale["mode"].IsDefined())
    {
        return false;
    }
    if (!validateExpression(
            scale,
            "expression",
            false,
            rulePath,
            source,
            report,
            ruleIndex) ||
        !scale["expression"].IsDefined() ||
        scale["expression"].Scalar().empty())
    {
        return false;
    }

    auto stops = scale["stops"];
    if (!stops.IsSequence() || stops.size() == 0) {
        return fail(
            "width-scale.stops must be a non-empty list of [value, width] pairs.",
            stops);
    }

    auto const mode = scale["mode"].Scalar();
    std::optional<double> previousLinear;
    std::set<std::string> categoricalKeys;
    for (auto const& stop : stops) {
        if (!stop.IsSequence() || stop.size() != 2 ||
            !stop[0].IsScalar() || !stop[1].IsScalar())
        {
            return fail(
                "Every width-scale stop must be a two-scalar [value, width] pair.",
                stop);
        }

        double width = 0.0;
        try {
            width = stop[1].as<double>();
        }
        catch (YAML::Exception const&) {
            return fail(
                "width-scale stop width must be a finite non-negative number.",
                stop[1]);
        }
        if (!std::isfinite(width) || width < 0.0) {
            return fail(
                "width-scale stop width must be a finite non-negative number.",
                stop[1]);
        }

        auto const key = stop[0].Scalar();
        if (key == "null" || key == "~") {
            return fail(
                "Null is not a valid width-scale stop key; use fallback.",
                stop[0]);
        }
        if (mode == "linear") {
            double value = 0.0;
            try {
                value = stop[0].as<double>();
            }
            catch (YAML::Exception const&) {
                return fail(
                    "Linear width-scale stop values must be finite numbers.",
                    stop[0]);
            }
            if (!std::isfinite(value) ||
                (previousLinear && value <= *previousLinear))
            {
                return fail(
                    "Linear width-scale stops must be finite and strictly increasing.",
                    stop[0]);
            }
            previousLinear = value;
        }
        else {
            std::string normalized;
            auto const tag = stop[0].Tag();
            auto const explicitlyString =
                tag == "!" ||
                tag.ends_with(":str");
            if (explicitlyString) {
                normalized = "s:" + key;
            }
            else if (key == "true" || key == "false") {
                normalized = "b:" + key;
            }
            else {
                char* end = nullptr;
                auto number =
                    std::strtod(key.c_str(), &end);
                if (end == key.c_str() + key.size() &&
                    std::isfinite(number))
                {
                    std::ostringstream stream;
                    stream.precision(17);
                    stream << number;
                    normalized =
                        "n:" + stream.str();
                }
                else {
                    normalized = "s:" + key;
                }
            }
            if (!categoricalKeys
                    .insert(std::move(normalized))
                    .second)
            {
                return fail(
                    "Categorical width-scale contains a duplicate typed stop key.",
                    stop[0]);
            }
        }
    }

    if (scale["fallback"].IsDefined()) {
        if (!scale["fallback"].IsScalar()) {
            return fail(
                "width-scale.fallback must be a finite non-negative number.",
                scale["fallback"]);
        }
        double fallback = 0.0;
        try {
            fallback =
                scale["fallback"].as<double>();
        }
        catch (YAML::Exception const&) {
            return fail(
                "width-scale.fallback must be a finite non-negative number.",
                scale["fallback"]);
        }
        if (!std::isfinite(fallback) ||
            fallback < 0.0)
        {
            return fail(
                "width-scale.fallback must be a finite non-negative number.",
                scale["fallback"]);
        }
    }
    return true;
}

bool validateGlow(
    YAML::Node const& ruleYaml,
    std::string const& rulePath,
    StyleValidationReport& report,
    uint32_t ruleIndex)
{
    auto glow = ruleYaml["glow"];
    if (!glow.IsDefined()) {
        return true;
    }
    auto fail = [&](std::string message, YAML::Node const& node) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            std::move(message),
            locationForNode(node));
        issue.ruleIndex = ruleIndex;
        issue.rulePath = rulePath;
        issue.property = "glow";
        return false;
    };
    if (!glow.IsMap()) {
        return fail("glow must be a map.", glow);
    }
    if (!glow["radius"].IsDefined()) {
        return fail("glow.radius is required.", glow);
    }
    bool ok = true;
    ok = validateColorValue(
        glow, "color", rulePath, report, ruleIndex) && ok;
    ok = validateNumericRange(
        glow, "radius", 0.0, 12.0, rulePath, report, ruleIndex) && ok;
    ok = validateNumericRange(
        glow, "opacity", 0.0, 1.0, rulePath, report, ruleIndex) && ok;
    return ok;
}

bool validateNestedRule(
    YAML::Node const& parent,
    std::string const& property,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    RuleValidationContext context)
{
    auto node = parent[property];
    if (!node.IsDefined()) {
        return true;
    }
    return validateStyleRuleYamlImpl(
        node,
        sourceRuleIndex,
        rulePath + "." + property,
        source,
        report,
        context);
}

bool validateBranchRules(
    YAML::Node const& parent,
    std::string const& property,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    RuleValidationContext childContext)
{
    auto branch = parent[property];
    if (!branch.IsDefined()) {
        return true;
    }
    if (!branch.IsSequence() || branch.size() == 0) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            property + " must be a non-empty sequence.",
            locationForNode(branch));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        return false;
    }

    bool ok = true;
    uint32_t nestedIndex = 0;
    for (auto const& nested : branch) {
        auto nestedPath = rulePath + "." + property + "[" + std::to_string(nestedIndex++) + "]";
        if (!validateStyleRuleYamlImpl(
                nested,
                sourceRuleIndex,
                nestedPath,
                source,
                report,
                childContext))
        {
            ok = false;
        }
    }
    return ok;
}

}

JsValue StyleSourceLocation::toJsValue() const
{
    auto obj = JsValue::Dict();
    if (line) {
        obj.set("line", JsValue(*line));
    }
    if (column) {
        obj.set("column", JsValue(*column));
    }
    if (offset) {
        obj.set("offset", JsValue(*offset));
    }
    if (length) {
        obj.set("length", JsValue(*length));
    }
    return obj;
}

JsValue StyleValidationIssue::toJsValue() const
{
    auto obj = JsValue::Dict({
        {"id", JsValue(id)},
        {"at", JsValue(static_cast<double>(at))},
        {"severity", JsValue(severity)},
        {"phase", JsValue(phase)},
        {"impact", JsValue(impact)},
        {"source", JsValue::Dict({{"sourceKind", JsValue("base")}})},
        {"message", JsValue(message)}
    });
    if (!detail.empty()) {
        obj.set("detail", JsValue(detail));
    }
    if (ruleIndex) {
        obj.set("ruleIndex", JsValue(*ruleIndex));
    }
    if (!rulePath.empty()) {
        obj.set("rulePath", JsValue(rulePath));
    }
    if (!property.empty()) {
        obj.set("property", JsValue(property));
    }
    if (!expression.empty()) {
        obj.set("expression", JsValue(expression));
    }
    if (location) {
        obj.set("location", location->toJsValue());
    }
    return obj;
}

StyleValidationIssue& StyleValidationReport::addIssue(
    std::string severity,
    std::string phase,
    std::string impact,
    std::string message,
    std::optional<StyleSourceLocation> location)
{
    if (severity == "error") {
        valid = false;
    }
    auto& issue = issues.emplace_back();
    issue.id = "style-validation-" + std::to_string(nextIssueId_++);
    issue.at = nowMillis();
    issue.severity = std::move(severity);
    issue.phase = std::move(phase);
    issue.impact = std::move(impact);
    issue.message = std::move(message);
    issue.location = std::move(location);
    return issue;
}

void StyleValidationReport::markStylesheetFailed()
{
    valid = false;
    loadable = false;
    failedWholeStyleSheet = true;
}

NativeJsValue StyleValidationReport::toJsValue() const
{
    auto issueList = JsValue::List();
    for (auto const& issue : issues) {
        issueList.push(issue.toJsValue());
    }
    return *JsValue::Dict({
        {"source", JsValue::Dict({{"sourceKind", JsValue("base")}})},
        {"valid", JsValue(valid)},
        {"loadable", JsValue(loadable)},
        {"loadedRuleCount", JsValue(loadedRuleCount)},
        {"skippedRuleCount", JsValue(skippedRuleCount)},
        {"failedWholeStyleSheet", JsValue(failedWholeStyleSheet)},
        {"issues", issueList}
    });
}

StyleSourceLocation locationFromMark(YAML::Mark const& mark)
{
    StyleSourceLocation loc;
    if (markIsValid(mark)) {
        loc.line = static_cast<uint32_t>(mark.line + 1);
        loc.column = static_cast<uint32_t>(mark.column + 1);
        loc.offset = static_cast<uint32_t>(mark.pos);
    }
    return loc;
}

StyleSourceLocation locationForNode(YAML::Node const& node)
{
    return locationFromMark(node.Mark());
}

std::optional<StyleSourceLocation> locationForExpression(
    YAML::Node const& node,
    std::string const& source,
    uint32_t expressionOffset,
    uint32_t expressionLength)
{
    auto scalarOffset = findScalarOffset(node, source);
    if (!scalarOffset) {
        return std::nullopt;
    }
    return locationFromOffset(source, *scalarOffset + expressionOffset, expressionLength);
}

bool validateTopLevelStyleYaml(YAML::Node const& styleYaml, StyleValidationReport& report)
{
    if (!styleYaml.IsMap()) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet root must be a YAML map.",
            locationForNode(styleYaml));
        report.markStylesheetFailed();
        return false;
    }

    auto version = styleYaml["version"];
    if (!version || !version.IsScalar()) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet must declare breaking schema version 2.",
            version ? std::optional<StyleSourceLocation>(locationForNode(version)) : std::nullopt);
        report.markStylesheetFailed();
        return false;
    }
    try {
        if (version.as<uint32_t>() != 2U) {
            report.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Unsupported style sheet version; this build requires version 2.",
                locationForNode(version));
            report.markStylesheetFailed();
            return false;
        }
    }
    catch (YAML::Exception const&) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet version must be the integer 2.",
            locationForNode(version));
        report.markStylesheetFailed();
        return false;
    }
    if (styleYaml["stage"].IsDefined()) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Top-level stage was removed in style schema version 2; select semantic geometry names in rules.",
            locationForNode(styleYaml["stage"]));
        report.markStylesheetFailed();
        return false;
    }

    auto name = styleYaml["name"];
    if (!name || !name.IsScalar() || name.Scalar().empty()) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet must define a non-empty scalar name.",
            name ? std::optional<StyleSourceLocation>(locationForNode(name)) : std::nullopt);
        report.markStylesheetFailed();
        return false;
    }

    auto category = styleYaml["category"];
    if (category.IsDefined()) {
        if (!category.IsScalar() ||
            (category.Scalar() != "base" && category.Scalar() != "search"))
        {
            auto& issue = report.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Style sheet category must be either 'base' or 'search'.",
                locationForNode(category));
            issue.property = "category";
            report.markStylesheetFailed();
            return false;
        }
    }

    auto rules = styleYaml["rules"];
    if (!rules || !rules.IsSequence()) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet must define rules as a YAML sequence.",
            rules ? std::optional<StyleSourceLocation>(locationForNode(rules)) : std::nullopt);
        report.markStylesheetFailed();
        return false;
    }
    if (rules.size() == 0) {
        report.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet must contain at least one rule.",
            locationForNode(rules));
        report.markStylesheetFailed();
        return false;
    }

    return true;
}

bool validateStyleOptionYaml(
    YAML::Node const& optionYaml,
    uint32_t optionIndex,
    std::string const& source,
    StyleValidationReport& report)
{
    (void) source;
    auto optionPath = "options[" + std::to_string(optionIndex) + "]";
    if (!optionYaml.IsMap()) {
        auto& issue = report.addIssue("warning", "schema", "option-skipped", "Style option must be a YAML map.", locationForNode(optionYaml));
        issue.rulePath = optionPath;
        return false;
    }
    if (!optionYaml["id"] || !optionYaml["id"].IsScalar() || optionYaml["id"].Scalar().empty()) {
        auto& issue = report.addIssue("warning", "schema", "option-skipped", "Style option must define a non-empty scalar id.", locationForNode(optionYaml));
        issue.rulePath = optionPath;
        issue.property = "id";
        return false;
    }
    auto const optionId = optionYaml["id"].Scalar();
    if (!isStyleOptionIdentifier(optionId)) {
        auto& issue = report.addIssue(
            "warning",
            "schema",
            "option-skipped",
            "Style option id '" + optionId + "' must match [A-Za-z_][A-Za-z0-9_]*.",
            locationForNode(optionYaml["id"]));
        issue.rulePath = optionPath;
        issue.property = "id";
        return false;
    }
    if (!validateEnumValue(optionYaml, "type", {"bool", "color", "string"}, optionPath, report, std::nullopt)) {
        report.issues.back().severity = "warning";
        report.issues.back().impact = "option-skipped";
        report.valid = std::ranges::none_of(report.issues, [](auto const& issue) { return issue.severity == "error"; });
        return false;
    }
    return true;
}

namespace {

bool validateStyleRuleYamlImpl(
    YAML::Node const& ruleYaml,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report,
    RuleValidationContext context)
{
    if (!ruleYaml.IsMap()) {
        auto& issue = report.addIssue("error", "schema", "rule-skipped", "Style rule must be a YAML map.", locationForNode(ruleYaml));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        return false;
    }

    bool ok = true;
    auto markInvalid = [&ok](bool value) { ok = value && ok; };
    auto rejectRemoved = [&](std::string const& property, std::string message) {
        auto node = ruleYaml[property];
        if (!node.IsDefined()) {
            return;
        }
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            std::move(message),
            locationForNode(node));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        issue.property = property;
        ok = false;
    };

    markInvalid(validateGeometry(ruleYaml, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "scope", {"feature", "relation", "attribute"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "mode", {"none", "hover", "selection"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "fidelity", {"any", "high", "low"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "arrow", {"none", "forward", "backward", "double"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "attribute-validity-geom", {"any", "required", "none"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(ruleYaml, "offset-type", {"miter"}, rulePath, report, sourceRuleIndex));
    markInvalid(validateEnumValue(
        ruleYaml,
        "lateral-offset-unit",
        {"meter", "meters", "m", "pixel", "pixels", "px"},
        rulePath,
        report,
        sourceRuleIndex));

    rejectRemoved(
        "aspect",
        "aspect was renamed to scope in style schema version 2.");
    rejectRemoved(
        "stage",
        "stage was removed in style schema version 2; select semantic geometry names with geometry-name.");
    rejectRemoved(
        "lod",
        "lod was removed in style schema version 2; use an explicit feature attribute filter such as FRC/PRC instead.");

    if (context != RuleValidationContext::TopLevel &&
        ruleYaml["scope"].IsDefined())
    {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            "scope is owned by the top-level style rule and must not be changed in a nested style tree.",
            locationForNode(ruleYaml["scope"]));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        issue.property = "scope";
        ok = false;
    }

    if (ruleYaml["geometry-name"].IsDefined()) {
        std::string geometryName;
        if (!readScalar(
                ruleYaml,
                "geometry-name",
                rulePath,
                report,
                sourceRuleIndex,
                &geometryName))
        {
            ok = false;
        }
        else if (geometryName.empty()) {
            auto& issue = report.addIssue(
                "error",
                "schema",
                "rule-skipped",
                "geometry-name must be a non-empty semantic name or '*'.",
                locationForNode(ruleYaml["geometry-name"]));
            issue.ruleIndex = sourceRuleIndex;
            issue.rulePath = rulePath;
            issue.property = "geometry-name";
            ok = false;
        }
    }

    markInvalid(validateNumericRange(ruleYaml, "opacity", 0.0, 1.0, rulePath, report, sourceRuleIndex));
    markInvalid(validateNumericRange(ruleYaml, "label-opacity", 0.0, 1.0, rulePath, report, sourceRuleIndex));
    markInvalid(validateNumericRange(
        ruleYaml,
        "z-index",
        -static_cast<double>(std::numeric_limits<float>::max()),
        static_cast<double>(std::numeric_limits<float>::max()),
        rulePath,
        report,
        sourceRuleIndex));
    markInvalid(readScalar<double>(ruleYaml, "lateral-offset", rulePath, report, sourceRuleIndex));
    markInvalid(validateRegexValue(ruleYaml, "type", rulePath, report, sourceRuleIndex));
    markInvalid(validateRegexValue(ruleYaml, "relation-type", rulePath, report, sourceRuleIndex));
    markInvalid(validateRegexValue(ruleYaml, "attribute-type", rulePath, report, sourceRuleIndex));
    markInvalid(validateRegexValue(ruleYaml, "attribute-layer-type", rulePath, report, sourceRuleIndex));

    for (auto const& property : {
        "color",
        "outline-color",
        "gap-color",
        "label-color",
        "label-outline-color",
        "label-background-color"
    }) {
        markInvalid(validateColorValue(ruleYaml, property, rulePath, report, sourceRuleIndex));
    }

    markInvalid(validateVectorSize(ruleYaml, "offset", 3, rulePath, report, sourceRuleIndex));
    markInvalid(validateVectorSize(ruleYaml, "offset-increment", 3, rulePath, report, sourceRuleIndex));
    markInvalid(validateVectorSize(ruleYaml, "point-merge-grid-cell", 3, rulePath, report, sourceRuleIndex));
    markInvalid(validateVectorSize(ruleYaml, "label-eye-offset", 3, rulePath, report, sourceRuleIndex));
    markInvalid(validateVectorSize(ruleYaml, "label-pixel-offset", 2, rulePath, report, sourceRuleIndex));
    markInvalid(validateVectorSize(ruleYaml, "label-background-padding", 2, rulePath, report, sourceRuleIndex));

    markInvalid(validateExpression(ruleYaml, "filter", true, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "attribute-filter", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "color-expression", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "arrow-expression", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "z-index-expression", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "icon-url-expression", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateExpression(ruleYaml, "label-text-expression", false, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateColorScale(ruleYaml, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateWidthScale(ruleYaml, rulePath, source, report, sourceRuleIndex));
    markInvalid(validateGlow(ruleYaml, rulePath, report, sourceRuleIndex));

    uint32_t colorModeCount = 0;
    colorModeCount += ruleYaml["color"].IsDefined() ? 1U : 0U;
    colorModeCount += ruleYaml["color-expression"].IsDefined() ? 1U : 0U;
    colorModeCount += ruleYaml["color-scale"].IsDefined() ? 1U : 0U;
    if (colorModeCount > 1) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            "color, color-expression, and color-scale are mutually exclusive.",
            locationForNode(ruleYaml));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        issue.property = "color-scale";
        ok = false;
    }

    if (ruleYaml["first-of"].IsDefined() && ruleYaml["all-of"].IsDefined()) {
        auto& issue = report.addIssue(
            "error",
            "schema",
            "rule-skipped",
            "first-of and all-of cannot be defined on the same rule.",
            locationForNode(ruleYaml["all-of"]));
        issue.ruleIndex = sourceRuleIndex;
        issue.rulePath = rulePath;
        issue.property = "all-of";
        ok = false;
    }
    else {
        auto const relationScope =
            context == RuleValidationContext::TopLevel &&
            ruleYaml["scope"].IsDefined() &&
            ruleYaml["scope"].IsScalar() &&
            ruleYaml["scope"].Scalar() == "relation";
        if (relationScope &&
            (ruleYaml["first-of"].IsDefined() ||
             ruleYaml["all-of"].IsDefined()))
        {
            auto const property = ruleYaml["first-of"].IsDefined()
                ? "first-of"
                : "all-of";
            auto& issue = report.addIssue(
                "error",
                "schema",
                "rule-skipped",
                "A top-level relation-scope rule cannot contain first-of or all-of; use branches inside relation-source-style or relation-target-style.",
                locationForNode(ruleYaml[property]));
            issue.ruleIndex = sourceRuleIndex;
            issue.rulePath = rulePath;
            issue.property = property;
            ok = false;
        }
        else {
            auto const childContext =
                context == RuleValidationContext::RelationFeatureStyle ||
                context == RuleValidationContext::RelationFeatureBranch
                    ? RuleValidationContext::RelationFeatureBranch
                    : RuleValidationContext::Branch;
            markInvalid(validateBranchRules(
                ruleYaml,
                "first-of",
                sourceRuleIndex,
                rulePath,
                source,
                report,
                childContext));
            markInvalid(validateBranchRules(
                ruleYaml,
                "all-of",
                sourceRuleIndex,
                rulePath,
                source,
                report,
                childContext));
        }
    }

    markInvalid(validateNestedRule(
        ruleYaml,
        "relation-line-end-markers",
        sourceRuleIndex,
        rulePath,
        source,
        report,
        RuleValidationContext::RelationFeatureStyle));
    markInvalid(validateNestedRule(
        ruleYaml,
        "relation-source-style",
        sourceRuleIndex,
        rulePath,
        source,
        report,
        RuleValidationContext::RelationFeatureStyle));
    markInvalid(validateNestedRule(
        ruleYaml,
        "relation-target-style",
        sourceRuleIndex,
        rulePath,
        source,
        report,
        RuleValidationContext::RelationFeatureStyle));

    return ok;
}

}

bool validateStyleRuleYaml(
    YAML::Node const& ruleYaml,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report)
{
    return validateStyleRuleYamlImpl(
        ruleYaml,
        sourceRuleIndex,
        rulePath,
        source,
        report,
        RuleValidationContext::TopLevel);
}

}
