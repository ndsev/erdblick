#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <set>

namespace erdblick {

/** Small authoring catalog shared by native validation, GUI controls and YAML completion.
 * It describes editable shapes, not an alternative style parser. Cross-field and
 * expression validation remain in style-validation.cpp.
 */
nlohmann::ordered_json const& styleAuthoringSchema();

/** Exports plain data through Embind without allocating a JS-owned native wrapper. */
std::string styleAuthoringSchemaJson();

/** Copies canonical enum choices; missing record/field/values keys throw a JSON lookup exception. */
std::set<std::string> styleAuthoringEnumValues(std::string const& record, std::string const& field);

}
