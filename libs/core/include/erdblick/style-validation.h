#pragma once

#include "interop/js-object.h"
#include "yaml-cpp/yaml.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace erdblick
{

/** Location inside the original YAML source. Lines and columns are 1-based for UI use. */
struct StyleSourceLocation
{
    std::optional<uint32_t> line;
    std::optional<uint32_t> column;
    std::optional<uint32_t> offset;
    std::optional<uint32_t> length;

    [[nodiscard]] JsValue toJsValue() const;
};

/** One actionable style validation or runtime evaluation issue. */
struct StyleValidationIssue
{
    std::string id;
    uint64_t at = 0;
    std::string severity = "error";
    std::string phase = "schema";
    std::string impact = "stylesheet-failed";
    std::string message;
    std::string detail;
    std::optional<uint32_t> ruleIndex;
    std::string rulePath;
    std::string property;
    std::string expression;
    std::optional<StyleSourceLocation> location;

    [[nodiscard]] JsValue toJsValue() const;
};

/** Validation summary for one style source. Source metadata is completed by TypeScript. */
struct StyleValidationReport
{
    bool valid = true;
    bool loadable = true;
    uint32_t loadedRuleCount = 0;
    uint32_t skippedRuleCount = 0;
    bool failedWholeStyleSheet = false;
    std::vector<StyleValidationIssue> issues;

    StyleValidationIssue& addIssue(
        std::string severity,
        std::string phase,
        std::string impact,
        std::string message,
        std::optional<StyleSourceLocation> location = std::nullopt);

    void markStylesheetFailed();
    [[nodiscard]] NativeJsValue toJsValue() const;

private:
    uint32_t nextIssueId_ = 1;
};

[[nodiscard]] StyleSourceLocation locationFromMark(YAML::Mark const& mark);
[[nodiscard]] StyleSourceLocation locationForNode(YAML::Node const& node);
[[nodiscard]] std::optional<StyleSourceLocation> locationForExpression(
    YAML::Node const& node,
    std::string const& source,
    uint32_t expressionOffset,
    uint32_t expressionLength);

[[nodiscard]] bool validateTopLevelStyleYaml(
    YAML::Node const& styleYaml,
    StyleValidationReport& report);

[[nodiscard]] bool validateStyleOptionYaml(
    YAML::Node const& optionYaml,
    uint32_t optionIndex,
    std::string const& source,
    StyleValidationReport& report);

[[nodiscard]] bool validateStyleRuleYaml(
    YAML::Node const& ruleYaml,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report);

}
