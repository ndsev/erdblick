#pragma once

#include "interop/js-object.h"
#include "yaml-cpp/yaml.h"

#include <cstdint>
#include <optional>
#include <set>
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

    /**
     * Append an issue with a report-local ID and timestamp. Error severity marks
     * the report invalid, but only markStylesheetFailed() makes it unloadable.
     * The returned reference may be invalidated when another issue is appended.
     */
    StyleValidationIssue& addIssue(
        std::string severity,
        std::string phase,
        std::string impact,
        std::string message,
        std::optional<StyleSourceLocation> location = std::nullopt);

    /** Mark a fatal document-level failure; callers can still retain collected issues. */
    void markStylesheetFailed();

    [[nodiscard]] NativeJsValue toJsValue() const;

private:
    uint32_t nextIssueId_ = 1;
};

/** Convert a valid YAML mark to UI coordinates; an invalid mark yields no fields. */
[[nodiscard]] StyleSourceLocation locationFromMark(YAML::Mark const& mark);

/** Locate the beginning of a YAML node in the original source. */
[[nodiscard]] StyleSourceLocation locationForNode(YAML::Node const& node);

/**
 * Map an expression-relative byte range using the first literal scalar match
 * at or after its YAML mark. Return nullopt when no match exists; escaped or
 * folded YAML scalars need not appear verbatim in the source.
 */
[[nodiscard]] std::optional<StyleSourceLocation> locationForExpression(
    YAML::Node const& node,
    std::string const& source,
    uint32_t expressionOffset,
    uint32_t expressionLength);

/**
 * Validate the document envelope before parsing rules. Failure adds an error
 * and marks the whole stylesheet unloadable; individual rules are checked later.
 */
[[nodiscard]] bool validateTopLevelStyleYaml(
    YAML::Node const& styleYaml,
    StyleValidationReport& report);

/**
 * Check one option declaration. Invalid options produce warnings and return
 * false so the caller can skip them while retaining the rest of the stylesheet.
 */
[[nodiscard]] bool validateStyleOptionYaml(
    YAML::Node const& optionYaml,
    uint32_t optionIndex,
    std::string const& source,
    StyleValidationReport& report);

/** Validate one embedded preset against the accepted local style options. */
[[nodiscard]] bool validateStylePresetYaml(
    YAML::Node const& presetYaml,
    uint32_t presetIndex,
    std::set<std::string> const& knownOptionIds,
    std::set<std::string> const& editableBooleanOptionIds,
    StyleValidationReport& report);

/**
 * Validate one top-level rule and its nested styles, appending located issues.
 * False tells the caller to skip this source rule; other top-level rules may load.
 * sourceRuleIndex and rulePath identify the original YAML, not the compacted list.
 */
[[nodiscard]] bool validateStyleRuleYaml(
    YAML::Node const& ruleYaml,
    uint32_t sourceRuleIndex,
    std::string const& rulePath,
    std::string const& source,
    StyleValidationReport& report);

}
