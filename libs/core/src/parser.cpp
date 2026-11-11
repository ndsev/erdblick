#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <functional>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <span>
#include <sstream>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <nlohmann/json.hpp>
#include "mapget/model/stringpool.h"
#include "mapget/model/layerschema.h"
#include "mapget/model/simfilutil.h"
#include "simfil/model/model.h"
#include "simfil/simfil.h"
#include "parser.h"
#include "style-filter-plan.h"

using namespace mapget;

namespace erdblick
{

struct TileLayerParser::SchemaCompletionBinding
{
    std::shared_ptr<mapget::StringPool> strings;
    std::unique_ptr<simfil::Environment> environment;
    // Complete tokens recur across successive prefixes and attribute roots.
    // The binding is tied to an immutable graph/layer and retired with it.
    std::map<
        std::pair<std::string, mapget::LayerSchema::SearchQueryRequestedScope>,
        std::vector<mapget::LayerSchema::SearchInterpretation>>
        enumMeanings;
};

namespace {

std::string completionTypeToString(simfil::CompletionCandidate::Type type)
{
    switch (type) {
    case simfil::CompletionCandidate::Type::CONSTANT:
        return "Constant";
    case simfil::CompletionCandidate::Type::FIELD:
        return "Field";
    case simfil::CompletionCandidate::Type::FUNCTION:
        return "Function";
    case simfil::CompletionCandidate::Type::HINT:
        return "Hint";
    }
    return "";
}

/** Return the unquoted schema symbol represented by a SIMFIL completion token. */
std::string completionConstantSymbol(std::string const& text)
{
    if (text.size() >= 2 && text.front() == '"' && text.back() == '"') {
        try {
            auto parsed = nlohmann::json::parse(text);
            if (parsed.is_string()) {
                return parsed.get<std::string>();
            }
        }
        catch (std::exception const&) {
        }
    }
    return text;
}

/** Return the compact type name used as completion metadata. */
std::string shortSchemaTypeName(std::string const& typeName)
{
    auto const separator = typeName.find_last_of('.');
    return separator == std::string::npos ? typeName : typeName.substr(separator + 1);
}

/** Formats schema-provided enum/type metadata for constant completion labels. */
std::string completionTypeHint(std::vector<std::string> typeNames)
{
    std::vector<std::string> shortNames;
    shortNames.reserve(typeNames.size());
    for (auto const& typeName : typeNames) {
        if (!typeName.empty()) {
            shortNames.push_back(shortSchemaTypeName(typeName));
        }
    }
    std::ranges::sort(shortNames);
    auto duplicates = std::ranges::unique(shortNames);
    shortNames.erase(duplicates.begin(), duplicates.end());
    if (shortNames.empty()) {
        return {};
    }

    std::ostringstream result;
    result << "enum " << shortNames.front();
    for (size_t i = 1; i < shortNames.size(); ++i) {
        result << ", " << shortNames[i];
    }
    return result.str();
}

/** Adds schema type metadata to constant completions when available. */
simfil::CompletionCandidate enrichCompletionCandidate(
    simfil::CompletionCandidate candidate,
    simfil::model_ptr<mapget::LayerSchema> const& registry,
    simfil::TypeId rootSchema)
{
    if (!registry || !candidate.hint.empty() || candidate.type != simfil::CompletionCandidate::Type::CONSTANT) {
        return candidate;
    }

    auto const symbolName = completionConstantSymbol(candidate.text);
    candidate.hint = completionTypeHint(registry->constantTypeNames(rootSchema, symbolName));
    return candidate;
}

/** Return whether two completions are the same user-visible candidate before hint decoration. */
bool sameCompletionIdentity(
    simfil::CompletionCandidate const& lhs,
    simfil::CompletionCandidate const& rhs)
{
    return lhs.text == rhs.text && lhs.location.offset == rhs.location.offset &&
        lhs.location.size == rhs.location.size && lhs.type == rhs.type;
}

/** Merge a hint into an existing completion without duplicating identical text. */
void mergeCompletionHint(std::string& target, std::string const& hint)
{
    if (hint.empty() || target == hint || target.find(hint) != std::string::npos) {
        return;
    }
    if (!target.empty()) {
        target += "; ";
    }
    target += hint;
}

NativeJsValue completionCandidatesToJs(
    std::string const& query,
    std::set<simfil::CompletionCandidate> const& candidates,
    std::set<std::string> const& exactInputExpressions,
    size_t limit)
{
    auto result = JsValue::List();
    std::vector<simfil::CompletionCandidate> normalized;
    for (auto const& item : candidates) {
        auto existing = std::ranges::find_if(normalized, [&](auto const& candidate) {
            return sameCompletionIdentity(candidate, item);
        });
        if (existing == normalized.end()) {
            normalized.push_back(item);
        }
        else {
            mergeCompletionHint(existing->hint, item.hint);
        }
    }

    std::set<std::string> fieldCandidateTexts;
    for (auto const& item : normalized) {
        if (item.type == simfil::CompletionCandidate::Type::FIELD) {
            fieldCandidateTexts.insert(item.text);
        }
    }
    if (!fieldCandidateTexts.empty()) {
        normalized.erase(
            std::remove_if(
                normalized.begin(),
                normalized.end(),
                [&](auto const& item)
                {
                    return item.type == simfil::CompletionCandidate::Type::CONSTANT &&
                        fieldCandidateTexts.contains(completionConstantSymbol(item.text));
                }),
            normalized.end());
    }

    size_t count = 0;
    for (auto const& item : normalized) {
        if (limit && count >= limit) {
            break;
        }
        auto insertText = item.text;
        if (item.type == simfil::CompletionCandidate::Type::FUNCTION) {
            insertText += "(";
        }

        auto completedQuery = query;
        completedQuery.replace(item.location.offset, item.location.size, insertText);

        result.push(JsValue::Dict({
            {"text", JsValue(item.text)},
            {"range",
             JsValue::List({
                 JsValue(static_cast<int>(item.location.offset)),
                 JsValue(static_cast<int>(item.location.size)),
             })},
            {"query", JsValue(completedQuery)},
            {"isExactMatch", JsValue(exactInputExpressions.contains(item.text))},
            {"type", JsValue(completionTypeToString(item.type))},
            {"hint", item.hint.empty() ? JsValue::Undefined() : JsValue(item.hint)},
        }));
        ++count;
    }
    return *result;
}

bool hasFeatureModelSchema(mapget::LayerInfo const& layerInfo)
{
    return static_cast<bool>(layerInfo.layerSchema());
}

struct SelectedLayerFilter
{
    bool active = false;
    std::set<std::pair<std::string, std::string>> layers;

    /** Returns whether a map/layer pair should participate in schema processing. */
    bool contains(std::string const& mapId, std::string const& layerId) const
    {
        return !active || layers.contains({mapId, layerId});
    }
};

/** Parses the optional schema-processing map/layer filter from JS parser options. */
SelectedLayerFilter selectedLayerFilterFromOptions(JsValue const& options)
{
    SelectedLayerFilter filter;
    if (!options.has("selectedMapLayers")) {
        return filter;
    }

    auto const selectedLayers = options["selectedMapLayers"];
    if (selectedLayers.type() != JsValue::Type::ObjectOrList) {
        return filter;
    }

    filter.active = true;
    for (uint32_t i = 0; i < selectedLayers.size(); ++i) {
        auto const entry = selectedLayers.at(i);
        if (!entry.has("mapId") || !entry.has("layerId")) {
            continue;
        }
        auto const mapId = entry["mapId"].as<std::string>();
        auto const layerId = entry["layerId"].as<std::string>();
        if (!mapId.empty() && !layerId.empty()) {
            filter.layers.insert({mapId, layerId});
        }
    }
    // Treat an empty selected-layer list as "not hydrated yet" for schema helpers.
    // Search execution itself still receives the concrete selected layer set elsewhere.
    if (filter.layers.empty()) {
        filter.active = false;
    }
    return filter;
}

struct AttributeScopeInfo
{
    std::string attrName;
    std::string attrLayerName;
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::LayerInfo const> layerInfo;
    simfil::model_ptr<mapget::LayerSchema> registry;
    simfil::TypeId attributeSchema = simfil::NoTypeId;
    simfil::TypeId featureSchema = simfil::NoTypeId;
};

struct FeatureSchemaInfo
{
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::LayerInfo const> layerInfo;
    simfil::model_ptr<mapget::LayerSchema> registry;
    simfil::TypeId featureSchema = simfil::NoTypeId;
};

struct SearchQueryMapLayerInfo
{
    std::string mapId;
    std::string layerId;
};

struct SearchQueryMapLayerInference
{
    std::vector<SearchQueryMapLayerInfo> mapLayers;
    std::set<std::string> matchedFieldNames;
    std::set<std::string> matchedEnumValues;
    std::set<std::string> seenMapLayerKeys;
};

struct QueryLayerTerms
{
    std::set<std::string> leafFields;
    std::set<std::string> enumValues;
    std::set<std::string> attributeNameLiterals;
    std::set<std::string> attributeLayerLiterals;
};

/** Adds one inferred search map/layer while preserving first-seen order. */
void addInferredSearchMapLayer(
    SearchQueryMapLayerInference& inference,
    std::string const& mapId,
    std::string const& layerId)
{
    auto const key = mapId + "\n" + layerId;
    if (mapId.empty() || layerId.empty() || !inference.seenMapLayerKeys.insert(key).second) {
        return;
    }
    inference.mapLayers.push_back({mapId, layerId});
}

/** Adds one schema-relevant field term extracted from simfil's AST. */
void addQueryLeafField(QueryLayerTerms& terms, std::string fieldName)
{
    if (fieldName.empty() || fieldName == "_" || fieldName.starts_with("$")) {
        return;
    }
    // Schema-free simfil parses unquoted enum constants as fields. Checking
    // leaf fields against enum indices preserves SPEED_LIMIT_END-style scope
    // inference without compiling once per schema.
    terms.leafFields.insert(fieldName);
    terms.enumValues.insert(std::move(fieldName));
}

/** Adds one string constant as an enum candidate for schema-layer inference. */
void addQueryStringLiteral(QueryLayerTerms& terms, std::string literal)
{
    if (!literal.empty()) {
        terms.enumValues.insert(std::move(literal));
    }
}

/** Compiles once with simfil and extracts schema-index lookup terms from the AST. */
tl::expected<QueryLayerTerms, simfil::Error> compileQueryLayerTerms(std::string const& query)
{
    auto strings = std::make_shared<mapget::StringPool>("SearchScopeTerms");
    auto env = mapget::makeEnvironment(strings);
    auto ast = simfil::compile(*env, query, simfil::CompileOptions{
        .any = false,
        .rewriteMode = simfil::RewriteMode::None});
    if (!ast) {
        return tl::unexpected(ast.error());
    }

    QueryLayerTerms terms;
    auto astTerms = simfil::referencedQueryTerms(**ast);
    for (auto const& fieldName : astTerms.leafFields) {
        addQueryLeafField(terms, fieldName);
    }
    for (auto const& literal : astTerms.stringLiterals) {
        addQueryStringLiteral(terms, literal);
    }
    for (auto const& comparison : astTerms.positiveFieldStringComparisons) {
        if (comparison.fieldName == "$name") {
            terms.attributeNameLiterals.insert(comparison.value);
        }
        else if (comparison.fieldName == "$layer") {
            terms.attributeLayerLiterals.insert(comparison.value);
        }
    }
    return terms;
}

/** Returns empty terms when the query does not parse yet. */
QueryLayerTerms queryLayerTermsOrEmpty(std::string const& query)
{
    auto terms = compileQueryLayerTerms(query);
    return terms ? std::move(*terms) : QueryLayerTerms{};
}

/** Collects every attribute context that can be styled or searched through schema metadata. */
std::vector<AttributeScopeInfo> collectAttributeScopes(
    std::map<std::string, mapget::DataSourceInfo> const& infos,
    SelectedLayerFilter const& selectedLayers = {})
{
    std::vector<AttributeScopeInfo> scopes;
    for (auto const& [_, dataSource] : infos) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (layerInfo && !selectedLayers.contains(dataSource.mapId_, layerInfo->layerId_)) {
                continue;
            }
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->layerSchema();
            if (!registry) {
                continue;
            }
            // Named attribute use sites are mapget semantics. Read that
            // inventory instead of reconstructing owners from generic fields.
            for (auto const& owner : registry->attributeScopes()) {
                scopes.push_back(
                    {owner.attributeName_,
                     owner.attributeLayerName_,
                     owner.featureType_,
                     dataSource.mapId_,
                     layerInfo->layerId_,
                     layerInfo,
                     registry,
                     owner.attributeSchema_,
                     registry->featureSchema(owner.featureType_)});
            }
        }
    }
    return scopes;
}

/** Collects the feature root schemas that can be queried by feature-scope search. */
std::vector<FeatureSchemaInfo> collectFeatureSchemaScopes(
    std::map<std::string, mapget::DataSourceInfo> const& infos,
    SelectedLayerFilter const& selectedLayers = {})
{
    std::vector<FeatureSchemaInfo> scopes;
    for (auto const& [_, dataSource] : infos) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (layerInfo && !selectedLayers.contains(dataSource.mapId_, layerInfo->layerId_)) {
                continue;
            }
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->layerSchema();
            if (!registry) {
                continue;
            }
            for (auto const& featureType : registry->featureTypes()) {
                auto const featureSchema = registry->featureSchema(featureType);
                if (featureSchema == simfil::NoTypeId) {
                    continue;
                }
                scopes.push_back(
                    {featureType,
                     dataSource.mapId_,
                     layerInfo->layerId_,
                     layerInfo,
                     registry,
                     featureSchema});
            }
        }
    }
    return scopes;
}

/** Returns whether any query literal plausibly names the supplied attribute or layer. */
bool literalsMatchName(std::set<std::string> const& literals, std::string const& name)
{
    if (literals.empty()) {
        return true;
    }
    return std::ranges::any_of(literals, [&](auto const& literal) {
        return literal == name || name.find(literal) != std::string::npos || literal.find(name) != std::string::npos;
    });
}

std::vector<AttributeScopeInfo> filterScopesByAttributeLiterals(
    std::vector<AttributeScopeInfo> scopes,
    QueryLayerTerms const& terms)
{
    auto const& attributeNameLiterals = terms.attributeNameLiterals;
    auto const& attributeLayerLiterals = terms.attributeLayerLiterals;
    if (attributeNameLiterals.empty() && attributeLayerLiterals.empty()) {
        return scopes;
    }

    std::vector<AttributeScopeInfo> filtered;
    for (auto const& scope : scopes) {
        if (!literalsMatchName(attributeNameLiterals, scope.attrName)) {
            continue;
        }
        if (!literalsMatchName(attributeLayerLiterals, scope.attrLayerName)) {
            continue;
        }
        filtered.push_back(scope);
    }
    return filtered;
}

bool schemaMatchesQueryLayerTerms(
    mapget::LayerSchema const& registry,
    simfil::TypeId typeId,
    QueryLayerTerms const& terms,
    SearchQueryMapLayerInference* inference = nullptr);

/** Resolves the exact attribute contexts implied by schema-referenced query paths. */
std::vector<AttributeScopeInfo> resolveAttributeScopesForQuery(
    std::map<std::string, mapget::DataSourceInfo> const& infos,
    std::string const& query,
    SelectedLayerFilter const& selectedLayers = {})
{
    auto const allAttributeScopes = collectAttributeScopes(infos, selectedLayers);
    if (allAttributeScopes.empty() || query.empty()) {
        return {};
    }

    auto const terms = queryLayerTermsOrEmpty(query);
    if (terms.leafFields.empty() && terms.enumValues.empty()) {
        return {};
    }

    bool hasFeatureOwnedTerm = false;
    for (auto const& featureScope : collectFeatureSchemaScopes(infos, selectedLayers)) {
        for (auto const& fieldName : terms.leafFields) {
            auto const type =
                featureScope.registry->mapSchema()->schemaType(featureScope.featureSchema);
            if (!type)
                continue;
            auto const name = type.pool()->dictionary().get(fieldName);
            auto const mayContainField = name ?
                type.canHaveField(name) :
                !type.reachabilityComplete();
            if (!mayContainField) {
                continue;
            }
            std::vector<std::string> fieldPath{fieldName};
            auto owner = featureScope.registry->ownerForPath(
                featureScope.featureType,
                featureScope.featureSchema,
                fieldPath);
            if (owner.kind_ == mapget::LayerSchema::PathOwnerKind::Feature) {
                hasFeatureOwnedTerm = true;
                break;
            }
        }
        if (hasFeatureOwnedTerm) {
            break;
        }
    }

    std::vector<AttributeScopeInfo> attributeScopes;
    for (auto const& attributeScope : allAttributeScopes) {
        auto const attributeTypeCode = attributeScope.registry->attributeTypeCode(attributeScope.attributeSchema);
        if (schemaMatchesQueryLayerTerms(*attributeScope.registry, attributeScope.attributeSchema, terms)
            || terms.leafFields.contains(attributeScope.attrName)
            || terms.enumValues.contains(attributeScope.attrName)
            || (!attributeTypeCode.empty() && terms.enumValues.contains(std::string(attributeTypeCode)))) {
            attributeScopes.push_back(attributeScope);
        }
    }

    if (hasFeatureOwnedTerm && !attributeScopes.empty()) {
        return {};
    }

    return filterScopesByAttributeLiterals(std::move(attributeScopes), terms);
}

/** Return whether a schema can contain a field or enum term collected from the query. */
bool schemaMatchesQueryLayerTerms(
    mapget::LayerSchema const& registry,
    simfil::TypeId typeId,
    QueryLayerTerms const& terms,
    SearchQueryMapLayerInference* inference)
{
    auto const graph = registry.mapSchema();
    auto const type = graph->schemaType(typeId);
    auto const incomplete = !type.reachabilityComplete();
    bool matched = false;
    for (auto const& fieldName : terms.leafFields) {
        auto const name = graph->dictionary().get(fieldName);
        // Zero is the declared empty name as well as the missing-name sentinel.
        // Neither a missing name nor an incomplete index proves absence.
        auto const knownName = name != simfil::StringPool::Empty || fieldName.empty();
        if (incomplete || (knownName && type.canHaveField(name))) {
            if (inference) {
                inference->matchedFieldNames.insert(fieldName);
            }
            matched = true;
        }
    }
    for (auto const& enumValue : terms.enumValues) {
        auto const name = graph->dictionary().get(enumValue);
        auto const knownName = name != simfil::StringPool::Empty || enumValue.empty();
        // Enum suggestions require a declaration. An open object's arbitrary
        // string values do not establish enum membership or attribution.
        if ((type && knownName && type.canHaveEnumSymbol(name)) ||
            !registry.constantTypeNames(typeId, enumValue).empty())
        {
            if (inference) {
                inference->matchedEnumValues.insert(enumValue);
            }
            matched = true;
        }
    }
    return matched;
}

/** Infers search map/layers from schema-referenced leaf fields and enum string constants. */
SearchQueryMapLayerInference resolveMapLayersForQuery(
    std::map<std::string, mapget::DataSourceInfo> const& infos,
    std::string const& query,
    SelectedLayerFilter const& selectedLayers = {})
{
    SearchQueryMapLayerInference inference;
    if (query.empty()) {
        return inference;
    }

    auto const terms = queryLayerTermsOrEmpty(query);
    if (terms.leafFields.empty() && terms.enumValues.empty()) {
        return inference;
    }

    for (auto const& featureScope : collectFeatureSchemaScopes(infos, selectedLayers)) {
        if (schemaMatchesQueryLayerTerms(*featureScope.registry, featureScope.featureSchema, terms, &inference)) {
            addInferredSearchMapLayer(inference, featureScope.mapId, featureScope.layerId);
        }
    }
    for (auto const& attrScope : collectAttributeScopes(infos, selectedLayers)) {
        if (schemaMatchesQueryLayerTerms(*attrScope.registry, attrScope.attributeSchema, terms, &inference)) {
            addInferredSearchMapLayer(inference, attrScope.mapId, attrScope.layerId);
        }
    }
    return inference;
}

/** Returns whether a schema field can be appended with dot notation in a style-field path. */
bool isPathIdentifier(std::string const& field)
{
    if (field.empty()) {
        return false;
    }
    auto const first = static_cast<unsigned char>(field.front());
    if (!std::isalpha(first) && field.front() != '_' && field.front() != '$') {
        return false;
    }
    return std::ranges::all_of(field.begin() + 1, field.end(), [](char c) {
        auto const ch = static_cast<unsigned char>(c);
        return std::isalnum(ch) || c == '_' || c == '$';
    });
}

/** Appends one schema field to a result-field path using dot or bracket notation as needed. */
std::string appendFieldPathSegment(std::string const& base, std::string const& field)
{
    auto const segment = isPathIdentifier(field)
        ? field
        : "[" + nlohmann::json(field).dump() + "]";
    if (base.empty()) {
        return segment;
    }
    return isPathIdentifier(field)
        ? base + "." + segment
        : base + segment;
}

struct SearchStyleSchemaMetadata
{
    std::string valueKind = "unknown";
    std::vector<std::string> enumValues;
    std::optional<double> numericMinimum;
    std::optional<double> numericMaximum;
    JsValue schemaType = JsValue::Undefined();
};

/** Builds enum metadata for feature `typeId` values advertised by the selected layer context. */
SearchStyleSchemaMetadata featureTypeMetadata(std::vector<std::string> typeIds)
{
    std::ranges::sort(typeIds);
    auto duplicates = std::ranges::unique(typeIds);
    typeIds.erase(duplicates.begin(), duplicates.end());
    return {"enum", std::move(typeIds), std::nullopt, std::nullopt};
}

/** Classifies one concrete type directly, retaining the primitive numeric type. */
SearchStyleSchemaMetadata schemaMetadata(simfil::SchemaType type)
{
    SearchStyleSchemaMetadata metadata;
    if (!type)
        return metadata;
    auto const affinities = simfil::SchemaType::affinities(type.kind()) &
        ~simfil::valueTypeAffinity(simfil::ValueType::Null);
    for (auto const& [type, name] :
         {std::pair{simfil::ValueType::Int, "integer"},
          {simfil::ValueType::Float, "number"},
          {simfil::ValueType::Bool, "boolean"},
          {simfil::ValueType::String, "string"},
          {simfil::ValueType::Bitmask, "bitmask"},
          {simfil::ValueType::Object, "object"},
          {simfil::ValueType::Array, "array"}})
    {
        if (affinities == simfil::valueTypeAffinity(type))
            metadata.valueKind = name;
    }
    if (affinities ==
        (simfil::valueTypeAffinity(simfil::ValueType::Int) |
         simfil::valueTypeAffinity(simfil::ValueType::Float)))
        metadata.valueKind = "number";
    std::set<std::string> categories;
    for (auto name : type.directEnumSymbols())
        categories.emplace(type.pool()->dictionary().resolve(name).value());
    // Live enums are a union of known string labels and unknown integer codes.
    // Their named constants belong to the union itself, while direct enum
    // symbols belong to its string alternative. Use the logical labels for
    // categories; raw wire ordinals and numeric specials are not color keys.
    type.forEachNamedValue(
        [&](auto const& value)
        {
            if (value.role != simfil::SchemaType::NamedValue::Role::Constant)
                return;
            std::visit(
                [&](auto const& raw)
                {
                    using T = std::decay_t<decltype(raw)>;
                    if constexpr (
                        std::is_same_v<T, std::string> || std::is_same_v<T, std::string_view>)
                        categories.emplace(raw);
                },
                value.value);
        });
    metadata.enumValues.assign(categories.begin(), categories.end());
    if ((metadata.valueKind == "string" || metadata.valueKind == "unknown") &&
        !metadata.enumValues.empty())
        metadata.valueKind = "enum";
    metadata.schemaType = JsValue::fromSchema(type);
    if (auto numeric = type.numericDomain()) {
        // Only ordinary measurement intervals seed a gradient. Specials remain
        // separate exact-value rules, even when they lie inside the raw encoding.
        auto number = [](simfil::SchemaType::NumericValue const& value) -> std::optional<double>
        {
            auto result = std::visit([](auto raw) { return double(raw); }, value);
            return std::isfinite(result) && std::abs(result) <= 9007199254740991.0 ?
                std::optional<double>{result} :
                std::nullopt;
        };
        if (numeric->ordinaryRanges.size() == 1) {
            metadata.numericMinimum = number(numeric->ordinaryRanges[0].min);
            metadata.numericMaximum = number(numeric->ordinaryRanges[0].max);
        }
        else if (numeric->ordinaryRanges.empty()) {
            bool hasSpecials = false;
            type.forEachNamedValue(
                [&](auto const& value)
                { hasSpecials |= value.role == simfil::SchemaType::NamedValue::Role::Special; });
            if (!hasSpecials) {
                if (numeric->minimum)
                    metadata.numericMinimum = number(*numeric->minimum);
                if (numeric->maximum)
                    metadata.numericMaximum = number(*numeric->maximum);
            }
        }
    }
    return metadata;
}

SearchStyleSchemaMetadata overlayFieldMetadata(std::string const& path)
{
    if (path == "$validityIndex" || path == "$validityCount") {
        return {"integer", {}};
    }
    if (path == "$feature") {
        return {"object", {}};
    }
    if (path == "$name" || path == "$layer") {
        return {"string", {}};
    }
    return {};
}

/** Converts native attribute-scope candidates into the embind JS value shape. */
NativeJsValue attributeScopesToJs(std::vector<AttributeScopeInfo> const& scopes)
{
    auto result = JsValue::List();
    for (auto const& scope : scopes) {
        result.push(JsValue::Dict({
            {"attrName", JsValue(scope.attrName)},
            {"attrLayerName", JsValue(scope.attrLayerName)},
            {"featureType", JsValue(scope.featureType)},
            {"mapId", JsValue(scope.mapId)},
            {"layerId", JsValue(scope.layerId)}
        }));
    }
    return *result;
}

/** Converts schema-backed search map/layer inference into the embind JS value shape. */
NativeJsValue mapLayerInferenceToJs(SearchQueryMapLayerInference const& inference)
{
    auto mapLayers = JsValue::List();
    for (auto const& layer : inference.mapLayers) {
        mapLayers.push(JsValue::Dict({
            {"mapId", JsValue(layer.mapId)},
            {"layerId", JsValue(layer.layerId)}
        }));
    }

    auto matchedFieldNames = JsValue::List();
    for (auto const& fieldName : inference.matchedFieldNames) {
        matchedFieldNames.push(JsValue(fieldName));
    }

    auto matchedEnumValues = JsValue::List();
    for (auto const& enumValue : inference.matchedEnumValues) {
        matchedEnumValues.push(JsValue(enumValue));
    }

    auto result = JsValue::Dict({
        {"mapLayers", mapLayers},
        {"matchedFieldNames", matchedFieldNames},
        {"matchedEnumValues", matchedEnumValues}
    });
    return *result;
}

/** Convert UI scope string into the mapget normalizer scope enum. */
mapget::LayerSchema::SearchQueryRequestedScope requestedSearchScopeFromString(std::string const& scope)
{
    if (scope == "attribute") {
        return mapget::LayerSchema::SearchQueryRequestedScope::Attribute;
    }
    if (scope == "auto") {
        return mapget::LayerSchema::SearchQueryRequestedScope::Auto;
    }
    return mapget::LayerSchema::SearchQueryRequestedScope::Feature;
}

/** Parenthesize generated normalized query branches before joining with OR. */
std::string normalizedQueryBranch(std::string value)
{
    return "(" + std::move(value) + ")";
}

/** Merge unique normalized attribute predicates into one query string. */
std::string mergeNormalizedAttributeQueries(std::vector<std::string> queries)
{
    std::vector<std::string> uniqueQueries;
    std::set<std::string> seen;
    for (auto& query : queries) {
        if (!query.empty() && seen.insert(query).second) {
            uniqueQueries.push_back(std::move(query));
        }
    }
    if (uniqueQueries.empty()) {
        return {};
    }
    auto result = std::move(uniqueQueries.front());
    for (size_t i = 1; i < uniqueQueries.size(); ++i) {
        result = normalizedQueryBranch(std::move(result)) + " or " + normalizedQueryBranch(std::move(uniqueQueries[i]));
    }
    return result;
}

/** Convert mapget layer-local attribute owners into erdblick's JS scope-candidate shape. */
void appendNormalizedAttributeScopes(
    JsValue& result,
    std::vector<mapget::LayerSchema::AttributePathOwner> const& scopes,
    std::string const& mapId,
    std::string const& layerId,
    std::set<std::string>& seen)
{
    for (auto const& scope : scopes) {
        auto key = mapId + "\n" + layerId + "\n" + scope.featureType_ + "\n"
            + scope.attributeLayerName_ + "\n" + scope.attributeName_;
        if (!seen.insert(std::move(key)).second) {
            continue;
        }
        result.push(JsValue::Dict({
            {"attrName", JsValue(scope.attributeName_)},
            {"attrLayerName", JsValue(scope.attributeLayerName_)},
            {"featureType", JsValue(scope.featureType_)},
            {"mapId", JsValue(mapId)},
            {"layerId", JsValue(layerId)}
        }));
    }
}

} // namespace

/**
 * One native picker request. The graph stays in MapSchema; this object owns only
 * the projected paths and the compact context/type tables crossing into JS.
 * In particular, a shared Classic type is exported once, even when several
 * feature types expose it under thousands of paths.
 */
class TileLayerParser::StyleFieldDiscovery
{
    // An absent name denotes an array-element edge, never a wildcard field
    // name. This keeps literal '*' and unusual names unambiguous at the API.
    using Path = std::vector<std::optional<std::string>>;

    /** One distinct type meaning for a path, shared by all of its owner contexts. */
    struct FieldMeaning
    {
        size_t metadataIndex;
        std::vector<size_t> contexts;
    };
    using Fields = std::unordered_map<std::string, std::vector<FieldMeaning>>;

public:
    /**
     * Resolve the accepted predicate at an attribute's actual query root.
     * Owner inference is conservative: an unknown property can keep an owner
     * eligible, but that does not make its numeric reference IDs or default
     * payload useful color fields. Only paths the predicate can use compete
     * for automatic styling. This never restricts search execution.
     *
     * No payload reference (for example `$name == "WARNING_SIGN"`) leaves the
     * native primary scalar available. An explicit empty list instead asks for
     * solid styling: the query has no known compatible payload field here.
     */
    static std::optional<JsValue> queriedPaths(
        simfil::Environment& environment,
        simfil::AST const& expression,
        simfil::SchemaType root)
    {
        if (!root)
            return JsValue::List();
        auto references = simfil::referencedSchemaPaths(environment, expression, root);
        if (!references)
            throw std::runtime_error(references.error().message);
        bool hasPayloadReference = false;
        std::set<std::string> paths;
        for (auto const& reference : references->paths) {
            auto const& first = reference.path.front();
            if (first.kind == simfil::SchemaPathSegment::Kind::Field &&
                root.fieldRole(first.field) == simfil::SchemaType::FieldRole::Context)
                continue;
            hasPayloadReference = true;
            if (!reference.predicateCanMatch)
                continue;
            std::string path;
            for (auto const& segment : reference.path) {
                path = appendStep(
                    path,
                    segment.kind == simfil::SchemaPathSegment::Kind::ArrayElement ?
                        std::nullopt :
                        std::optional(
                            std::string(root.pool()->dictionary().resolve(segment.field).value())));
            }
            paths.insert(std::move(path));
        }
        if (!hasPayloadReference && !references->hasBroadWildcardAccess &&
            !references->hasDynamicAccess && !references->hasUnresolvedAccess)
            return std::nullopt;
        auto result = JsValue::List();
        for (auto const& path : paths)
            result.push(JsValue(path));
        return result;
    }

    /** Capture one UI request; schema semantics are resolved only in collect. */
    explicit StyleFieldDiscovery(JsValue const& options)
        : recursive_(!options.has("recursive") || options["recursive"].as<bool>()),
          scalarsOnly_(options.has("values") && options["values"].as<std::string>() == "scalar")
    {
        if (options.has("selectedFeatureTypes")) {
            auto types = options["selectedFeatureTypes"];
            for (uint32_t i = 0; i < types.size(); ++i)
                featureTypes_.insert(types.at(i).as<std::string>());
        }
        if (options.has("path")) {
            auto path = options["path"];
            for (uint32_t i = 0; i < path.size(); ++i) {
                auto step = path.at(i);
                if (step.type() == JsValue::Type::String)
                    path_.emplace_back(step.as<std::string>());
                else if (step.has("elements") && step["elements"].as<bool>())
                    path_.emplace_back(std::nullopt);
                else
                    throw std::invalid_argument("Style discovery path requires field names or {elements:true}");
            }
        }
        if (options.has("context"))
            contextFilter_ = options["context"];
        if (options.has("preparedContexts")) {
            preparedContexts_ = options["preparedContexts"];
            for (uint32_t i = 0; i < preparedContexts_->size(); ++i) {
                for (auto const* name :
                     {"mapId", "layerId", "featureType", "attrName", "attrLayerName"}) {
                    if (!preparedContexts_->at(i).has(name))
                        throw std::invalid_argument(
                            "Prepared style discovery requires complete attribute owners");
                }
            }
        }
        else if (
            contextFilter_.has("mapId") && contextFilter_.has("layerId") &&
            contextFilter_.has("featureType") && contextFilter_.has("attrName") &&
            contextFilter_.has("attrLayerName"))
        {
            preparedContexts_ = JsValue::List();
            preparedContexts_->push(contextFilter_);
        }
    }

    /**
     * Visit already resolved owners together, sharing the projected type table.
     * A present empty list means no owners; absence asks the caller to perform
     * ordinary query normalization. This avoids rescanning a prepared predicate
     * at a different root or reinstalling the schema for each individual owner.
     */
    bool collectPrepared(
        simfil::model_ptr<mapget::LayerSchema> const& registry,
        std::string const& mapId,
        std::string const& layerId)
    {
        if (!preparedContexts_)
            return false;
        for (auto const& owner : registry->attributeScopes()) {
            for (uint32_t i = 0; i < preparedContexts_->size(); ++i) {
                auto context = preparedContexts_->at(i);
                if (context["mapId"].as<std::string>() == mapId &&
                    context["layerId"].as<std::string>() == layerId &&
                    context["featureType"].as<std::string>() == owner.featureType_ &&
                    context["attrName"].as<std::string>() == owner.attributeName_ &&
                    context["attrLayerName"].as<std::string>() == owner.attributeLayerName_)
                {
                    collect(
                        registry,
                        owner.attributeSchema_,
                        mapId,
                        layerId,
                        owner.featureType_,
                        owner.attributeName_,
                        owner.attributeLayerName_);
                    break;
                }
            }
        }
        return true;
    }

    /** Retain all context choices, then walk only those selected by the user. */
    void collect(
        simfil::model_ptr<mapget::LayerSchema> const& registry,
        simfil::TypeId root,
        std::string const& mapId,
        std::string const& layerId,
        std::string const& featureType,
        std::string const& attrName = {},
        std::string const& attrLayerName = {})
    {
        if (!registry || (!featureTypes_.empty() && !featureTypes_.contains(featureType)))
            return;
        // Retain this graph once for the whole walk. All recursive type/field
        // views below borrow it; individual lookups do not acquire ownership.
        auto const graph = registry->mapSchema();
        auto context = JsValue::Dict({
            {"mapId", JsValue(mapId)}, {"layerId", JsValue(layerId)},
            {"featureType", JsValue(featureType)}, {"attrName", JsValue(attrName)},
            {"attrLayerName", JsValue(attrLayerName)}});
        if (!attrName.empty()) {
            // Use the same payload scalar as SIMFIL's attribute shorthand.
            // Common fields such as validity.direction and source addresses
            // describe the attribute, but are not its value. An ambiguous
            // shorthand deliberately contributes no preferred field.
            auto paths = registry->scalarFieldPathsForAttribute(root, attrName);
            if (paths.size() == 1) {
                std::string valuePath;
                for (auto const& segment : paths.front()) {
                    valuePath = appendStep(valuePath,
                        segment.kind_ == simfil::SchemaPathSegment::Kind::ArrayElement
                            ? std::nullopt : std::optional(segment.field_));
                }
                context.set("primaryValuePath", JsValue(valuePath));
            }
        }
        auto const contextIndex = contexts_.size();
        contexts_.push_back(context);
        for (auto const* name : {"mapId", "layerId", "featureType", "attrName", "attrLayerName"}) {
            if (contextFilter_.has(name) &&
                contextFilter_[name].as<std::string>() != context[name].as<std::string>())
                return;
        }
        if (!attrName.empty()) {
            auto queryRoot = registry->attributeQuerySchema(featureType, root);
            if (queryRoot != simfil::NoTypeId)
                root = queryRoot;
        }

        // Resolve a requested branch by native field lookup. No expanded graph,
        // dotted-path parser or schema traversal is recreated in TypeScript.
        std::vector<simfil::TypeId> roots{root};
        std::string prefix;
        for (auto const& segment : path_) {
            std::vector<simfil::TypeId> next;
            for (auto rootSchema : roots) {
                forEachAlternative(
                    graph->schemaType(rootSchema),
                    [&](auto type)
                    {
                        if (!type)
                            return;
                        if (!segment) {
                            auto children = type.itemTypes();
                            next.insert(next.end(), children.begin(), children.end());
                            return;
                        }
                        auto const name =
                            schemaField(type, *segment, prefix.empty() && attrName.empty());
                        if (auto field = type.field(name)) {
                            auto children = field.types();
                            next.insert(next.end(), children.begin(), children.end());
                        }
                    });
            }
            std::ranges::sort(next);
            next.erase(std::unique(next.begin(), next.end()), next.end());
            roots = std::move(next);
            prefix = appendStep(prefix, segment);
        }
        for (auto schema : roots) {
            std::set<simfil::TypeId> active;
            walk(graph->schemaType(schema), prefix, path_, contextIndex, active, attrName.empty());
        }
        if (attrName.empty() && path_.empty()) {
            std::vector<std::string> types;
            for (auto const& type : registry->featureTypes()) {
                if ((!contextFilter_.has("featureType") || type == featureType) &&
                    (featureTypes_.empty() || featureTypes_.contains(type)))
                    types.push_back(type);
            }
            auto [it, inserted] = featureTypeMetadata_.try_emplace(types, types_.size());
            if (inserted)
                types_.push_back(featureTypeMetadata(std::move(types)));
            addField("typeId", it->second, contextIndex);
        }
        if (!attrName.empty() && path_.empty()) {
            for (auto const* name : {"$name", "$layer", "$validityIndex", "$validityCount"}) {
                auto [it, inserted] = syntheticTypes_.try_emplace(name, types_.size());
                if (inserted)
                    types_.push_back(overlayFieldMetadata(name));
                addField(name, it->second, contextIndex);
            }
        }
    }

    /** Sort grouped paths once and export metadata once per exact type. */
    NativeJsValue result()
    {
        auto contexts = JsValue::List();
        for (auto const& context : contexts_)
            contexts.push(context);
        auto types = JsValue::List();
        for (auto const& type : types_) {
            auto names = JsValue::List();
            for (auto const& name : type.enumValues)
                names.push(JsValue(name));
            auto value = JsValue::Dict(
                {{"valueKind", JsValue(type.valueKind)},
                 {"enumValues", names},
                 {"schemaType", type.schemaType}});
            if (type.numericMinimum && type.numericMaximum)
                value.set(
                    "numericRange",
                    JsValue::Dict(
                        {{"min", JsValue(*type.numericMinimum)},
                         {"max", JsValue(*type.numericMaximum)}}));
            types.push(value);
        }
        auto indices = [](auto const& values) {
            auto result = JsValue::List();
            for (auto index : values)
                result.push(JsValue(static_cast<uint32_t>(index)));
            return result;
        };
        std::vector<Fields::value_type const*> paths;
        paths.reserve(fields_.size());
        for (auto const& field : fields_)
            paths.push_back(&field);
        std::ranges::sort(paths, [](auto left, auto right) { return left->first < right->first; });
        auto fields = JsValue::List();
        for (auto const* path : paths) {
            for (auto const& meaning : path->second) {
                fields.push(JsValue::Dict(
                    {{"path", JsValue(path->first)},
                     {"metadata", JsValue(static_cast<uint32_t>(meaning.metadataIndex))},
                     {"contexts", indices(meaning.contexts)}}));
            }
        }
        auto branches = JsValue::List();
        for (auto const& [segments, contextIds] : branches_) {
            auto path = JsValue::List();
            std::string label;
            for (auto const& segment : segments) {
                path.push(segment ? JsValue(*segment) : JsValue::Dict({{"elements", JsValue(true)}}));
                label = appendStep(label, segment);
            }
            branches.push(JsValue::Dict({
                {"path", path}, {"label", JsValue(label)}, {"contexts", indices(contextIds)}}));
        }
        return *JsValue::Dict(
            {{"contexts", contexts},
             {"types", types},
             {"fields", fields},
             {"branches", branches},
             {"complete", JsValue(!recursiveCycle_)},
             {"incompleteReason",
              JsValue(
                  recursiveCycle_ ?
                      "Recursive schema branches remain available through direct "
                      "branch exploration." :
                      "")}});
    }

private:
    /** Render the established Simfil array traversal without treating it as a field name. */
    static std::string appendStep(std::string const& prefix, std::optional<std::string> const& step)
    {
        return step ? appendFieldPathSegment(prefix, *step) : (prefix.empty() ? "*" : prefix + ".*");
    }

    /** Alternatives share a value position; they do not add a path segment. */
    template <typename Visitor>
    void forEachAlternative(simfil::SchemaType root, Visitor const& visitor) const
    {
        if (!root)
            return;
        std::vector<simfil::TypeId> pending{root.id()};
        std::set<simfil::TypeId> seen;
        auto const* owner = root.pool();
        while (!pending.empty()) {
            auto schema = pending.back();
            pending.pop_back();
            if (!seen.insert(schema).second)
                continue;
            if (auto type = owner->schemaType(schema)) {
                visitor(type);
                auto alternatives = type.alternatives();
                pending.insert(pending.end(), alternatives.begin(), alternatives.end());
            }
        }
    }

    /** Discover whether a field has declared descendants, including array/union branches. */
    bool canBrowse(simfil::SchemaType type)
    {
        if (!type)
            return false;
        auto const affinities = simfil::SchemaType::affinities(type.kind());
        if (!(affinities & (simfil::valueTypeAffinity(simfil::ValueType::Object) |
                           simfil::valueTypeAffinity(simfil::ValueType::Array))))
            return false;
        auto key = std::make_pair(type.pool()->identity(), type.id());
        if (auto found = browsableTypes_.find(key); found != browsableTypes_.end())
            return found->second;
        bool result = false;
        forEachAlternative(
            type,
            [&](auto alternative)
            {
                alternative.forEachField(
                    [&](auto field)
                    { result |= field.role() != simfil::SchemaType::FieldRole::Context; });
                result |= !alternative.itemTypes().empty();
            });
        browsableTypes_.emplace(key, result);
        return result;
    }

    /** Map the displayed alias to its declared field without hiding a real attributes member. */
    std::string_view
    schemaField(simfil::SchemaType type, std::string_view name, bool featureRoot) const
    {
        if (!type)
            return name;
        auto const& dictionary = type.pool()->dictionary();
        auto const attributes = dictionary.get("attributes");
        auto const properties = dictionary.get("properties");
        auto fields = type.directFields();
        if ((featureRoot || type.kind() == mapget::LayerSchema::FeatureKind) &&
            name == "attributes" &&
            (!attributes || std::ranges::find(fields, attributes) == fields.end()) && properties &&
            std::ranges::find(fields, properties) != fields.end())
            return "properties";
        return name;
    }

    /** Export one exact scalar type, then reference its table index everywhere else. */
    size_t metadata(simfil::SchemaType type)
    {
        auto key = std::make_pair(type ? type.pool()->identity() : std::string_view{}, type.id());
        auto [it, inserted] = typeIndices_.try_emplace(key, types_.size());
        if (inserted)
            types_.push_back(schemaMetadata(type));
        return it->second;
    }

    /** Group by expression and type; the context list preserves all differing owners. */
    void addField(std::string const& path, size_t metadataIndex, size_t context)
    {
        auto const& kind = types_[metadataIndex].valueKind;
        if (scalarsOnly_ && (kind == "object" || kind == "array"))
            return;
        // Hash the path once per occurrence, then merge its usually singular
        // meaning. Sorting is deferred until all owners have been grouped.
        auto& meanings = fields_[path];
        auto meaning = std::ranges::find(meanings, metadataIndex, &FieldMeaning::metadataIndex);
        if (meaning == meanings.end()) {
            meanings.push_back({metadataIndex, {context}});
            return;
        }
        auto& contexts = meaning->contexts;
        if (contexts.empty() || contexts.back() != context)
            contexts.push_back(context);
    }

    /** Walk declared data edges, retaining alternatives instead of picking the first type. */
    void walk(
        simfil::SchemaType type,
        std::string const& prefix,
        Path const& segments,
        size_t context,
        std::set<simfil::TypeId>& active,
        bool featureScope)
    {
        if (!type)
            return;
        auto const schema = type.id();
        if (!active.insert(schema).second) {
            recursiveCycle_ = true;
            return;
        }
        auto visitChild = [&](std::optional<std::string> name, simfil::TypeId child)
        {
            auto const path = appendStep(prefix, name);
            auto childSegments = segments;
            childSegments.push_back(std::move(name));
            auto const childType = type.pool()->schemaType(child);
            auto const affinities = simfil::SchemaType::affinities(childType.kind()) &
                ~simfil::valueTypeAffinity(simfil::ValueType::Null);
            bool const container = affinities == simfil::valueTypeAffinity(simfil::ValueType::Object) ||
                affinities == simfil::valueTypeAffinity(simfil::ValueType::Array);
            // Scalar pickers still receive container branches, but do not pay
            // to export descriptors for rows that cannot be chosen as scalars.
            if (!scalarsOnly_ || !container)
                addField(path, metadata(childType), context);
            bool const hasChildren = canBrowse(childType);
            if (hasChildren && segments.size() == path_.size()) {
                auto& contexts = branches_[childSegments];
                if (contexts.empty() || contexts.back() != context)
                    contexts.push_back(context);
            }
            if (hasChildren && recursive_)
                walk(childType, path, childSegments, context, active, featureScope);
        };
        // Enumerate the native packed data edges directly. Asking fieldRole
        // separately for each name would scan every sibling again on wide
        // Classic objects. Context links remain available in explicit lookup.
        type.forEachField(
            [&](auto field)
            {
                if (field.role() == simfil::SchemaType::FieldRole::Context)
                    return;
                auto const name = field.name();
                auto children = field.types();
                auto displayName = std::string(name);
                if ((featureScope && prefix.empty()) ||
                    type.kind() == mapget::LayerSchema::FeatureKind) {
                    if (name == "typeId" && prefix.empty())
                        return;  // The selected layer's enum is supplied once above.
                    if (name == "properties") {
                        if (schemaField(type, "attributes", true) != "properties")
                            return;  // A declared attributes member owns that spelling.
                        displayName = "attributes";
                    }
                }
                if (children.empty())
                    visitChild(displayName, simfil::NoTypeId);
                for (auto child : children)
                    visitChild(displayName, child);
            });
        for (auto child : type.itemTypes())
            visitChild(std::nullopt, child);
        for (auto alternative : type.alternatives())
            walk(
                type.pool()->schemaType(alternative),
                prefix,
                segments,
                context,
                active,
                featureScope);
        active.erase(schema);
    }

    bool recursive_;
    bool scalarsOnly_;
    bool recursiveCycle_ = false;
    JsValue contextFilter_ = JsValue::Dict();
    std::optional<JsValue> preparedContexts_;
    std::set<std::string> featureTypes_;
    Path path_;
    std::vector<JsValue> contexts_;
    std::vector<SearchStyleSchemaMetadata> types_;
    std::map<std::pair<std::string_view, simfil::TypeId>, size_t> typeIndices_;
    std::map<std::pair<std::string_view, simfil::TypeId>, bool> browsableTypes_;
    std::map<std::string, size_t> syntheticTypes_;
    std::map<std::vector<std::string>, size_t> featureTypeMetadata_;
    Fields fields_;
    std::map<Path, std::vector<size_t>> branches_;
};

TileLayerParser::TileLayerParser()
{
    // Create field dict cache
    cachedStrings_ = std::make_shared<mapget::TileLayerStream::StringPoolCache>();

    // Create fresh mapget stream parser.
    reset();
}

void TileLayerParser::installMapSchema(SharedUint8Array const& bytes, std::string const& expectedId)
{
    if (expectedId.empty())
        throw std::runtime_error("Schema installation requires an exact advertised schemaId");
    // read validates the supplied envelope and checksum even when this graph is
    // already cached; only the subsequent graph decode is shared between parsers.
    auto owner = MapSchema::read(bytes.bytes(), expectedId);
    schemas_.insert_or_assign(expectedId, std::move(owner));
}

std::shared_ptr<MapSchema const> TileLayerParser::resolveMapSchema(std::string_view schemaId) const
{
    auto found = schemas_.find(schemaId);
    if (found != schemas_.end())
        return found->second;
    if (fallbackLayerInfo_ && fallbackLayerInfo_->schemaOwner() &&
        fallbackLayerInfo_->schemaOwner()->schemaId() == schemaId)
        return fallbackLayerInfo_->schemaOwner();
    throw std::runtime_error(fmt::format("Schema '{}' is not installed in this parser", schemaId));
}

NativeJsValue
TileLayerParser::featureTypes(std::string const& mapId, std::string const& layerId) const
{
    auto const source = info_.find(mapId);
    if (source == info_.end())
        throw std::runtime_error("Datasource is not ready: " + mapId);
    auto const layer = source->second.layers_.find(layerId);
    if (layer == source->second.layers_.end())
        throw std::runtime_error("Unknown layer: " + layerId);
    auto const schema = layer->second->layerSchema();
    auto result = JsValue::List();
    for (auto const& type : schema->featureTypes())
        result.push(JsValue(type));
    return *result;
}

void TileLayerParser::setDataSourceInfo(const erdblick::SharedUint8Array& dataSourceInfoJson)
{
    // Validate replacement metadata against exact installed owners first. A bad
    // source must not clear the working catalog or its streamed dictionary state.
    TileLayerParser replacement;
    replacement.schemas_ = schemas_;
    replacement.changeDataSources(
        nlohmann::json::array(),
        nlohmann::json::parse(dataSourceInfoJson.toString()));
    // Decoded layers pin their own graph. The parser only retains owners used
    // by the replacement catalog, so repeated source reloads do not leak graphs.
    replacement.schemas_.clear();
    for (auto const& [_, source] : replacement.info_)
        replacement.schemas_.emplace(source.schemaId_, source.mapSchema_);
    info_.swap(replacement.info_);
    incomingRelationTargets_.swap(replacement.incomingRelationTargets_);
    incomingRelationCoverageUnknown_.swap(replacement.incomingRelationCoverageUnknown_);
    featureJumpTargets_.swap(replacement.featureJumpTargets_);
    schemas_.swap(replacement.schemas_);
    schemaCompletionBindings_.clear();
    cachedStrings_ = std::make_shared<mapget::TileLayerStream::StringPoolCache>();
    stringPoolsByMap_.clear();
    reset();
}

void TileLayerParser::applyDataSourceChanges(SharedUint8Array const& changesJson)
{
    auto const changes = nlohmann::json::parse(changesJson.toString());
    changeDataSources(changes.at("removedMapIds"), changes.at("addedSources"));
}

void TileLayerParser::changeDataSources(
    nlohmann::json const& removedMapIds,
    nlohmann::json const& addedSources)
{
    auto const removed = removedMapIds.get<std::set<std::string>>();
    auto nextInfo = info_;
    for (auto const& mapId : removed)
        nextInfo.erase(mapId);
    for (auto const& node : addedSources) {
        auto dsInfo = DataSourceInfo::fromJson(
            node,
            [this](std::string_view id) { return resolveMapSchema(id); });
        if (dsInfo.isAddOn_)
            continue;
        auto const mapId = dsInfo.mapId_;
        if (!nextInfo.emplace(mapId, std::move(dsInfo)).second)
            throw std::runtime_error(
                fmt::format("Datasource map '{}' is already registered", mapId));
    }

    // Work on copied metadata and indexes until validation succeeds. In
    // particular, a rejected replacement must leave the old dictionary usable.
    std::map<std::string, FeatureJumpTarget> nextTargets;
    // Index available feature types by their feature id compositions.
    // These will be the available jump-to-feature targets.
    // For each composition, allow a version with and without optional params.
    for (auto const& [_, dsInfo] : nextInfo) {
        for (auto const& [_, l] : dsInfo.layers_) {
            for (auto const& name : l->layerSchema()->featureTypes()) {
                auto const identity = l->getTypeInfo(name);
                for (auto const composition : identity.compositions()) {
                    for (bool withOptionals : {false, true}) {
                        std::string compositionId(identity.name());

                        for (auto const part : composition.parts()) {
                            if (!part.optional() || withOptionals) {
                                compositionId += fmt::format(
                                    ".{}:{}",
                                    part.name(),
                                    static_cast<uint32_t>(part.datatype()));
                            }
                        }

                        auto [entry, inserted] = nextTargets.try_emplace(compositionId);
                        auto& typeInfo = entry->second;
                        if (inserted) {
                            typeInfo.id_ = compositionId;
                            typeInfo.composition_ = composition;
                            typeInfo.includeOptionalParts_ = withOptionals;
                            typeInfo.name_ = identity.name();
                            typeInfo.layerInfo_ = l;
                        }
                        if (std::ranges::find(typeInfo.maps_, dsInfo.mapId_) == typeInfo.maps_.end())
                            typeInfo.maps_.emplace_back(dsInfo.mapId_);
                    }
                }
            }
        }
    }

    info_.swap(nextInfo);
    featureJumpTargets_.swap(nextTargets);
    for (auto const& mapId : removed) {
        stringPoolsByMap_.erase(mapId);
        std::erase_if(
            incomingRelationTargets_,
            [&](auto const& item) { return item.first.first == mapId; });
        std::erase_if(
            incomingRelationCoverageUnknown_,
            [&](auto const& key) { return key.first == mapId; });
    }
    std::set<std::string> retainedPools;
    std::set<std::string> retainedSchemas;
    for (auto const& [mapId, source] : info_) {
        retainedPools.insert(source.stringPoolId_);
        retainedSchemas.insert(source.schemaId_);
        schemas_.insert_or_assign(source.schemaId_, source.mapSchema_);
        if (auto pools = stringPoolsByMap_.find(mapId); pools != stringPoolsByMap_.end())
            retainedPools.insert(pools->second.begin(), pools->second.end());
    }
    // Fields can arrive before a map's first tile. Only prune after retirement,
    // when the transport has been fenced and will resend unacknowledged pools.
    if (!removed.empty())
        cachedStrings_->retainStringPools(retainedPools);
    std::erase_if(
        schemas_,
        [&](auto const& entry) { return !retainedSchemas.contains(entry.first); });
    std::erase_if(
        schemaCompletionBindings_,
        [&](auto const& entry) { return !retainedSchemas.contains(entry.first.first); });
}

void TileLayerParser::trackStringPool(mapget::PartitionLayer const& layer)
{
    stringPoolsByMap_[layer.mapId()].insert(layer.stringPoolId());
}

void TileLayerParser::readFieldDictUpdate(SharedUint8Array const& bytes)
{
    // A missing dictionary poisons later semantic reads. Let the transport
    // fail and reconnect at this boundary instead of logging and continuing.
    try {
        reader_->read(bytes.toString());
    }
    catch (...) {
        // Reader framing may be mid-message after a decoding error. Its
        // replacement shares the intact dictionary cache for the next stream.
        reset();
        throw;
    }
}

NativeJsValue TileLayerParser::getFieldDictOffsets()
{
    auto offsets = reader_->stringPoolCache()->stringPoolOffsets();
    auto result = JsValue::Dict();
    for (auto const& [stringPoolId, highestFieldId] : offsets)
        result.set(stringPoolId, JsValue(highestFieldId));
    return *result;
}

void TileLayerParser::reset()
{
    // Note: The reader is only ever used to read field dict updates.
    // For this, it does not need a layer info provider or onParsedLayer callback.
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [](auto&& mapId, auto&& layerId){return nullptr;},
        [](auto&& layer){},
        cachedStrings_);
}

TileFeatureLayer TileLayerParser::readTileFeatureLayer(const SharedUint8Array& buffer)
{
    auto result = TileFeatureLayer(std::make_shared<mapget::TileFeatureLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        { return resolveMapLayerInfo(std::string(mapId), std::string(layerId)); },
        [this](auto&& stringPoolId) { return cachedStrings_->getStringPool(stringPoolId); },
        [this](std::string_view schemaId) { return resolveMapSchema(schemaId); }));
    trackStringPool(*result.model_);
    return result;
}

void TileLayerParser::setIncomingRelationHints(SharedUint8Array const& catalogJson)
{
    decltype(incomingRelationTargets_) targets;
    decltype(incomingRelationCoverageUnknown_) unknown;
    for (auto const& source : nlohmann::json::parse(catalogJson.toString())) {
        auto mapId = source.at("mapId").get<std::string>();
        for (auto const& [layerId, layer] : source.at("layers").items()) {
            auto key = std::pair{mapId, layerId};
            if (!layer.contains("incomingRelationTargetTypes"))
                continue;
            auto types = layer.at("incomingRelationTargetTypes").get<std::vector<std::string>>();
            targets[key].insert(types.begin(), types.end());
            if (layer.value("incomingRelationCoverageUnknown", true))
                unknown.insert(key);
        }
    }
    incomingRelationTargets_.swap(targets);
    incomingRelationCoverageUnknown_.swap(unknown);
}

bool TileLayerParser::hasIncomingRelations(TileFeatureLayer const& layer, std::string const& featureId) const
{
    auto target = layer.find(featureId);
    if (!target) return false;
    auto key = std::pair{layer.model_->mapId(), layer.model_->layerInfo()->layerId_};
    auto hint = incomingRelationTargets_.find(key);
    // The service computes this hint from readable, authorized providers. Missing
    // metadata is unknown, never proof that a feature has no incoming families.
    return hint == incomingRelationTargets_.end() ||
        incomingRelationCoverageUnknown_.contains(key) ||
        hint->second.contains(std::string(target->typeId()));
}

TileSourceDataLayer TileLayerParser::readTileSourceDataLayer(SharedUint8Array const& buffer)
{
    auto result = TileSourceDataLayer(std::make_shared<mapget::TileSourceDataLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        { return resolveMapLayerInfo(std::string(mapId), std::string(layerId)); },
        [this](auto&& stringPoolId) { return cachedStrings_->getStringPool(stringPoolId); },
        [this](std::string_view schemaId) { return resolveMapSchema(schemaId); }));
    trackStringPool(*result.model_);
    return result;
}

TileSubsetLayer TileLayerParser::readTileSubsetLayer(SharedUint8Array const& buffer)
{
    auto result = TileSubsetLayer(std::make_shared<mapget::TileSubsetLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        { return resolveMapLayerInfo(std::string(mapId), std::string(layerId)); },
        [this](auto&& stringPoolId) { return cachedStrings_->getStringPool(stringPoolId); },
        [this](std::string_view schemaId) { return resolveMapSchema(schemaId); }));
    trackStringPool(*result.model_);
    return result;
}

TileLayerParser::TileLayerMetadata TileLayerParser::readTileLayerMetadata(const SharedUint8Array& buffer)
{
    // Parse just the TileLayer part of the blob, which is the base class of
    // e.g. the TileFeatureLayer. The base class blob always precedes the
    // blob from the derived class.
    TileLayer tileLayer(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        });
    trackStringPool(tileLayer);
    int32_t numFeatures = -1;
    auto layerInfo = tileLayer.info();
    auto allScalarFields = JsValue::Dict();
    if (layerInfo.is_object()) {
        numFeatures = layerInfo.value<int32_t>("Size/Features#features", -1);
        for (auto const& [k, v] : layerInfo.items()) {
            if (v.is_number()) {
                allScalarFields.set(k, JsValue(v.get<double>()));
            }
        }
    }
    auto warnings = JsValue::List();
    for (auto const& warning : tileLayer.warnings()) warnings.push(JsValue(warning));
    const auto conversionTimestampMs = std::chrono::duration<double, std::milli>(
        tileLayer.timestamp().time_since_epoch()).count();
    const auto ttlMs = tileLayer.ttl()
        ? static_cast<double>(tileLayer.ttl()->count())
        : std::numeric_limits<double>::quiet_NaN();
    return {
        tileLayer.id().toString(),
        tileLayer.stringPoolId(),
        tileLayer.id().mapId_,
        tileLayer.id().layerId_,
        *JsValue::fromPartition(tileLayer.partitionId()),
        tileLayer.partitionId().kind() == mapget::PartitionKind::Tile
            ? tileLayer.tileId().value()
            : 0,
        tileLayer.legalInfo() ? *tileLayer.legalInfo() : "",
        tileLayer.error() ? *tileLayer.error() : "",
        *warnings,
        numFeatures,
        conversionTimestampMs,
        ttlMs,
        *allScalarFields
    };
}

TileLayerParser::TileSubsetLayerMetadata TileLayerParser::readTileSubsetLayerMetadata(
    SharedUint8Array const& buffer)
{
    auto metadata = mapget::TileSubsetLayer::readMetadata(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        });
    auto dependencies = JsValue::List();
    for (auto const& dependency : metadata.dependencies_) {
        dependencies.push(JsValue::Dict({
            {"sourceTileKey", JsValue(dependency.sourceTileKey_.toString())},
            {"mapId", JsValue(dependency.sourceTileKey_.mapId_)},
            {"layerId", JsValue(dependency.sourceTileKey_.layerId_)},
            {"partition", JsValue::fromPartition(dependency.sourceTileKey_.partitionId_)},
            {"sourceFeatureCount", JsValue(dependency.sourceFeatureCount_)},
        }));
    }
    auto issues = JsValue::List();
    for (auto const& issue : metadata.issues_) {
        nlohmann::json scope = issue.scope_;
        issues.push(JsValue::Dict({
            {"channelId", JsValue(issue.channelId_)},
            {"expression", JsValue(issue.expression_)},
            {"scope", JsValue(scope.get<std::string>())},
            {"message", JsValue(issue.message_)},
            {"occurrenceCount",
             JsValue(static_cast<double>(issue.occurrenceCount_))},
        }));
    }
    return {
        readTileLayerMetadata(buffer),
        std::move(metadata.identity_.filterId_),
        metadata.identity_.generation_,
        *dependencies,
        *issues,
        metadata.glbAttachmentName_.value_or(std::string{}),
    };
}

NativeJsValue TileLayerParser::planStyleFilter(
    FeatureLayerStyle const& style,
    std::string const& mapId,
    std::string const& layerId,
    int highlightMode,
    int lod)
{
    auto info = resolveMapLayerInfo(mapId, layerId);
    if (!info) {
        StyleFilterPlan plan;
        plan.valid = false;
        plan.issues.push_back({
            0,
            "No LayerInfo is available for '" +
                mapId + "/" + layerId + "'."});
        return plan.toJsValue();
    }
    if (highlightMode <
            static_cast<int>(
                FeatureStyleRule::NoHighlight) ||
        highlightMode >
            static_cast<int>(
                FeatureStyleRule::SelectionHighlight))
    {
        StyleFilterPlan plan;
        plan.valid = false;
        plan.issues.push_back(
            {0, "Invalid highlight mode."});
        return plan.toJsValue();
    }
    if (lod < FeatureStyleRule::kMinimumLod ||
        lod > FeatureStyleRule::kMaximumLod)
    {
        StyleFilterPlan plan;
        plan.valid = false;
        plan.issues.push_back(
            {0, "Invalid style LOD."});
        return plan.toJsValue();
    }
    return erdblick::planStyleFilter(
        style,
        *info,
        static_cast<FeatureStyleRule::HighlightMode>(
            highlightMode),
        static_cast<uint8_t>(lod))
        .toJsValue();
}

void TileLayerParser::setFallbackLayerInfo(std::shared_ptr<mapget::LayerInfo> info) {
    fallbackLayerInfo_ = std::move(info);
    schemaCompletionBindings_.clear();
}

std::shared_ptr<mapget::LayerInfo>
TileLayerParser::resolveMapLayerInfo(std::string const& mapId, std::string const& layerId) const
{
    // A late tile or an inspection restored before schema readiness may refer
    // to an absent map. Looking it up must not insert an empty datasource and
    // prevent the real catalog entry from being registered later.
    auto const map = info_.find(mapId);
    if (map != info_.end()) {
        auto const layer = map->second.layers_.find(layerId);
        if (layer != map->second.layers_.end())
            return layer->second;
    }
    return fallbackLayerInfo_;
}

std::vector<TileLayerParser::FilteredFeatureJumpTarget>
TileLayerParser::filterFeatureJumpTargets(const std::string& queryString) const
{
    std::vector<FilteredFeatureJumpTarget> results;
    // An empty omnibar does not need every feature type. Trim surrounding
    // whitespace before looking for a type prefix or a complete bare ID.
    auto const first = queryString.find_first_not_of(" \t\r\n\f\v");
    if (first == std::string::npos)
        return results;
    auto const last = queryString.find_last_not_of(" \t\r\n\f\v");
    auto const query = queryString.substr(first, last - first + 1);
    std::regex sep("[\\.,;|\\s]+");
    std::vector<std::string> tokens(
        std::sregex_token_iterator(query.begin(), query.end(), sep, -1),
        std::sregex_token_iterator());

    // Find applicable feature types based on the prefix.
    std::string prefix;
    std::vector<FeatureJumpTarget const*> targetsWithPrefixMatch;
    if (!tokens.empty()) {
        prefix = tokens[0];
        for (const auto& [_, target] : featureJumpTargets_) {
            if (!prefix.empty() && target.name_.substr(0, prefix.size()) == prefix)
                targetsWithPrefixMatch.push_back(&target);
        }
    }

    // Without a type prefix, try bare IDs. Only successful parses are useful
    // here; unrelated text must not produce a catalog of missing parameters.
    if (targetsWithPrefixMatch.empty()) {
        for (const auto& [_, target] : featureJumpTargets_) {
            targetsWithPrefixMatch.push_back(&target);
        }
        prefix.clear();
    }

    // Try to match the parameters.
    for (const auto& target : targetsWithPrefixMatch) {
        FilteredFeatureJumpTarget result{*target, {}, std::nullopt};

        size_t tokenIndex = !prefix.empty() ? 1 : 0; // Start parsing after the prefix.
        for (auto const part : target->composition_.parts()) {
            if (part.optional() && !target->includeOptionalParts_)
                continue;
            auto partError = "?";

            if (tokenIndex >= tokens.size()) {
                result.error_ = "Insufficient parameters.";
                result.parsedParams_.emplace_back(part.name(), partError);
                continue; // Skip optional parts if no more tokens.
            }

            std::variant<int64_t, std::string> parsedValue = tokens[tokenIndex++];
            std::string error;
            if (!part.validateValue(parsedValue, &error)) {
                result.error_ = error;
                parsedValue = partError;
            }

            result.parsedParams_.emplace_back(part.name(), parsedValue);
        }

        if (tokenIndex < tokens.size()) {
            result.error_ = "Too many parameters.";
        }

        // A matching type prefix keeps incomplete alternatives visible so the
        // omnibar can show which ID parts the user still needs to supply.
        if (!prefix.empty() || !result.error_)
            results.push_back(std::move(result));
    }

    return results;
}

void TileLayerParser::getDataSourceInfo(SharedUint8Array& out, std::string const& mapId)
{
    auto const& infoIt = info_.find(mapId);
    if (infoIt == info_.end()) {
        std::cout << "Could not find mapId!" << std::endl;
        return;
    }
    out.writeToArray("[" + infoIt->second.toJson().dump() + "]");
}

void TileLayerParser::getFieldDict(
    SharedUint8Array& out,
    std::string const& stringPoolId)
{
    auto fieldDict = cachedStrings_->getStringPool(stringPoolId);
    std::ostringstream outStream;
    fieldDict->write(outStream, 0);
    out.writeToArray(outStream.str());
}

void TileLayerParser::addFieldDict(const SharedUint8Array& buffer)
{
    size_t bytesRead;
    auto stringPoolId =
        mapget::StringPool::readDataSourceStringPoolId(buffer.bytes(), 0, &bytesRead);
    auto fieldDict = cachedStrings_->getStringPool(stringPoolId);
    if (auto result = fieldDict->read(buffer.bytes(), bytesRead); !result)
        throw std::runtime_error(result.error().message);
}

NativeJsValue TileLayerParser::completeSearchQuery(
    std::string const& query,
    int point,
    NativeJsValue const& options_)
{
    JsValue options(options_);
    point = std::max<int>(0, std::min<int>(point, query.size()));

    simfil::CompletionOptions opts;
    opts.limit = 15;
    opts.showWildcardHints = false;
    if (options.has("limit")) {
        opts.limit = std::max<int>(0, options["limit"].as<int>());
    }
    if (options.has("timeoutMs")) {
        opts.timeoutMs = std::max<int>(0, options["timeoutMs"].as<int>());
    }

    std::string scope;
    if (options.has("scope")) {
        scope = options["scope"].as<std::string>();
    }
    auto const includeFeatureScope = scope != "attribute";
    auto const includeAttributeScope = scope != "feature";
    // A feature's shorthand index already includes all owned attribute fields
    // and enum symbols. Scanning every attribute again for a bare keyword
    // spends the full completion budget returning duplicates. Paths and the
    // attribute-only scope still need their attribute roots and $feature context.
    auto const featureCoversAttributeShorthand = includeFeatureScope && isPathIdentifier(query);
    auto const selectedLayers = selectedLayerFilterFromOptions(options);
    std::set<simfil::CompletionCandidate> mergedCandidates;
    // A complete symbol may expand into a predicate in the suggestions. Tell
    // the editor that Enter can submit the original input for interpretation;
    // accepting the first expanded suggestion would silently choose a meaning.
    std::set<std::string> exactInputExpressions;
    auto const completionStart = std::chrono::steady_clock::now();
    auto const completionBudgetExhausted = [&]() {
        if (opts.timeoutMs <= 0) {
            return false;
        }
        auto const elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - completionStart);
        return elapsed.count() >= opts.timeoutMs;
    };
    auto addCandidates =
        [&](simfil::model_ptr<mapget::LayerSchema> const& registry, simfil::SchemaType rootSchema)
    {
        if (!rootSchema || completionBudgetExhausted()) {
            return;
        }
        auto& binding = schemaCompletionBindings_
            [{std::string(registry->mapSchema()->schemaId()), std::string(registry->name())}];
        if (!binding) {
            binding = std::make_shared<SchemaCompletionBinding>();
            binding->strings = std::make_shared<mapget::StringPool>("SearchCompletion");
            binding->environment = mapget::makeEnvironment(binding->strings);
            // The environment retains its canonical graph once and caches
            // dictionary translation. No per-type adapter graph is installed.
            binding->environment->setSchema(registry->rootType());
        }
        auto remaining = opts;
        if (opts.timeoutMs > 0) {
            auto const elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - completionStart).count();
            if (elapsed >= opts.timeoutMs) {
                return;
            }
            remaining.timeoutMs = opts.timeoutMs - elapsed;
        }
        auto candidates = simfil::complete(*binding->environment, query, point, rootSchema, remaining);
        if (candidates) {
            for (auto candidate : *candidates) {
                candidate =
                    enrichCompletionCandidate(std::move(candidate), registry, rootSchema.id());
                bool qualified = false;
                if (candidate.location.offset == 0 && candidate.location.size == query.size()) {
                    auto const symbol = completionConstantSymbol(candidate.text);
                    auto const exact = symbol == completionConstantSymbol(query);
                    if (candidate.type == simfil::CompletionCandidate::Type::FIELD) {
                        // Simfil already found this field. A full interpretation
                        // would enumerate every path through every feature again
                        // merely to label one autocomplete row.
                        for (auto const& owner : registry->attributeScopes()) {
                            if (owner.attributeName_ == symbol) {
                                candidate.hint = symbol + " attribute";
                                break;
                            }
                        }
                        if (exact)
                            exactInputExpressions.insert(candidate.text);
                    }
                    auto const symbolId = registry->mapSchema()->dictionary().get(symbol);
                    auto const symbols = rootSchema.nestedEnumSymbols();
                    auto const fieldShadowsSymbol = featureCoversAttributeShorthand &&
                        candidate.type == simfil::CompletionCandidate::Type::FIELD && symbolId &&
                        std::ranges::find(symbols, symbolId) != symbols.end();
                    if (candidate.type == simfil::CompletionCandidate::Type::CONSTANT ||
                        fieldShadowsSymbol) {
                        // A whole-query enum needs a predicate, whereas an enum
                        // inside an authored comparison remains a literal value.
                        // Simfil gives fields precedence over equal enum names.
                        // Here both are useful: keep the plain field alongside
                        // the enum's explicit predicate, without rescanning all
                        // attribute roots to recover that second interpretation.
                        // Bound the retained cache as users explore new symbols.
                        auto key = std::make_pair(symbol, requestedSearchScopeFromString(scope));
                        if (!binding->enumMeanings.contains(key) &&
                            binding->enumMeanings.size() >= 128)
                            binding->enumMeanings.clear();
                        auto [found, inserted] = binding->enumMeanings.try_emplace(key);
                        if (inserted)
                            found->second = registry->enumSearchInterpretations(symbol, key.second);
                        for (auto const& meaning : found->second) {
                            auto chosen = candidate;
                            chosen.type = simfil::CompletionCandidate::Type::CONSTANT;
                            chosen.hint = meaning.label_;
                            chosen.text = meaning.expression_;
                            if (exact)
                                exactInputExpressions.insert(chosen.text);
                            mergedCandidates.emplace(std::move(chosen));
                            qualified = candidate.type ==
                                simfil::CompletionCandidate::Type::CONSTANT;
                        }
                    }
                }
                if (!qualified)
                    mergedCandidates.emplace(std::move(candidate));
            }
        }
    };

    for (auto const& [_, dataSource] : info_) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (completionBudgetExhausted()) {
                return completionCandidatesToJs(query, mergedCandidates, exactInputExpressions, opts.limit);
            }
            if (layerInfo && !selectedLayers.contains(dataSource.mapId_, layerInfo->layerId_)) {
                continue;
            }
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            simfil::model_ptr<mapget::LayerSchema> registry = layerInfo->layerSchema();
            if (!registry) {
                continue;
            }

            auto const attributeOwners = registry->attributeScopes();
            for (auto const& featureType : registry->featureTypes()) {
                auto const featureSchema = registry->featureSchema(featureType);
                if (includeFeatureScope && featureSchema != simfil::NoTypeId) {
                    if (completionBudgetExhausted()) {
                        return completionCandidatesToJs(query, mergedCandidates, exactInputExpressions, opts.limit);
                    }
                    addCandidates(registry, registry->mapSchema()->schemaType(featureSchema));
                }

                if (!includeAttributeScope || featureCoversAttributeShorthand) {
                    continue;
                }

                for (auto const& owner : attributeOwners) {
                    if (owner.featureType_ != featureType) {
                        continue;
                    }
                    if (completionBudgetExhausted()) {
                        return completionCandidatesToJs(query, mergedCandidates, exactInputExpressions, opts.limit);
                    }
                    auto const root =
                        registry->attributeQuerySchema(featureType, owner.attributeSchema_);
                    addCandidates(registry, registry->mapSchema()->schemaType(root));
                }
            }
        }
    }

    return completionCandidatesToJs(query, mergedCandidates, exactInputExpressions, opts.limit);
}

bool TileLayerParser::isAttributeScopeSearchQuery(std::string const& query, NativeJsValue const& options_) const
{
    return !resolveAttributeScopesForQuery(info_, query, selectedLayerFilterFromOptions(JsValue(options_))).empty();
}

/** Returns schema contexts that can evaluate an attribute-scope search query. */
NativeJsValue TileLayerParser::getAttributeScopeForQuery(std::string const& query, NativeJsValue const& options_) const
{
    return attributeScopesToJs(resolveAttributeScopesForQuery(info_, query, selectedLayerFilterFromOptions(JsValue(options_))));
}

/** Returns map/layers whose schemas are addressed by the query's leaf fields or enum string constants. */
NativeJsValue TileLayerParser::getMapLayersForQuery(std::string const& query, NativeJsValue const& options_) const
{
    return mapLayerInferenceToJs(resolveMapLayersForQuery(
        info_,
        query,
        selectedLayerFilterFromOptions(JsValue(options_))));
}

/** Enumerate meanings before selecting scope, preserving each layer's evaluation root. */
NativeJsValue TileLayerParser::prepareSearchQuery(
    std::string const& query,
    std::string const& scope,
    NativeJsValue const& options_) const
{
    auto const selected = selectedLayerFilterFromOptions(JsValue(options_));
    auto strings = std::make_shared<mapget::StringPool>("PreparedSearchTerms");
    auto environment = mapget::makeEnvironment(strings);
    auto ast = simfil::compile(
        *environment,
        query,
        simfil::CompileOptions{.any = false, .rewriteMode = simfil::RewriteMode::None});
    if (!ast)
        throw std::runtime_error(ast.error().message);
    std::set<std::string> selectedTypes;
    JsValue options(options_);
    if (options.has("selectedFeatureTypes")) {
        auto types = options["selectedFeatureTypes"];
        for (uint32_t i = 0; i < types.size(); ++i)
            selectedTypes.insert(types.at(i).as<std::string>());
    }
    auto result = JsValue::List();
    for (auto const& [_, source] : info_) {
        for (auto const& [__, layer] : source.layers_) {
            if (!layer || layer->type_ != mapget::LayerType::Features ||
                !selected.contains(source.mapId_, layer->layerId_))
                continue;
            auto registry = layer->layerSchema();
            if (!registry)
                throw std::runtime_error(
                    "Search requires the schema for " + source.mapId_ + "/" + layer->layerId_);
            auto prepared =
                registry->searchInterpretations(query, requestedSearchScopeFromString(scope));
            if (!prepared)
                throw std::runtime_error(prepared.error().message);
            for (auto const& meaning : *prepared) {
                // Styling follows the accepted field predicate, rather than
                // ranking fields from the ambiguous shorthand that led to it.
                auto expression = simfil::compile(
                    *environment,
                    meaning.expression_,
                    simfil::CompileOptions{.any = false, .rewriteMode = simfil::RewriteMode::None});
                if (!expression)
                    throw std::runtime_error(expression.error().message);
                auto predicate = simfil::compile(
                    *environment,
                    meaning.query_,
                    simfil::CompileOptions{.any = false, .rewriteMode = simfil::RewriteMode::None});
                if (!predicate)
                    throw std::runtime_error(predicate.error().message);
                auto terms = simfil::referencedQueryTerms(**expression);
                auto fields = JsValue::List(), literals = JsValue::List();
                for (auto const& field : terms.leafFields)
                    fields.push(JsValue(field));
                for (auto const& literal : terms.stringLiterals)
                    literals.push(JsValue(literal));
                // The user's type selector constrains execution. Discovered
                // owners only guide styling: another produced type can expose
                // the same portable field, including through open metadata.
                auto featureTypes = registry->featureTypes();
                if (!selectedTypes.empty())
                    std::erase_if(
                        featureTypes,
                        [&](auto const& type) { return !selectedTypes.contains(type); });
                if (featureTypes.empty())
                    continue;
                auto scopes = JsValue::List();
                for (auto const& owner : meaning.attributeScopes_) {
                    if (!selectedTypes.empty() && !selectedTypes.contains(owner.featureType_))
                        continue;
                    auto value = JsValue::Dict();
                    value.set("mapId", JsValue(source.mapId_));
                    value.set("layerId", JsValue(layer->layerId_));
                    value.set("featureType", JsValue(owner.featureType_));
                    value.set("attrLayerName", JsValue(owner.attributeLayerName_));
                    value.set("attrName", JsValue(owner.attributeName_));
                    auto root =
                        registry->attributeQuerySchema(owner.featureType_, owner.attributeSchema_);
                    auto paths = StyleFieldDiscovery::queriedPaths(
                        *environment,
                        **predicate,
                        registry->mapSchema()->schemaType(root));
                    if (paths)
                        value.set("queriedPaths", *paths);
                    scopes.push(value);
                }
                auto value = JsValue::Dict();
                value.set("id", JsValue(meaning.id_));
                value.set("label", JsValue(meaning.label_));
                value.set("kind", JsValue(meaning.kind_));
                value.set("symbol", JsValue(meaning.symbol_));
                value.set("mapId", JsValue(source.mapId_));
                value.set("layerId", JsValue(layer->layerId_));
                value.set("schemaId", JsValue(std::string(registry->mapSchema()->schemaId())));
                // Requests already select their map/layer. The chosen query
                // stays readable and can be prepared for another schema later;
                // schemaId only validates this temporary execution plan.
                value.set("expression", JsValue(meaning.expression_));
                value.set("query", JsValue(meaning.query_));
                value.set(
                    "scope",
                    JsValue(
                        meaning.scope_ == mapget::LayerSchema::SearchQueryConcreteScope::Attribute ?
                            "attribute" :
                            "feature"));
                auto types = JsValue::List();
                for (auto const& type : featureTypes)
                    types.push(JsValue(type));
                value.set("featureTypes", types);
                value.set("attributeScopes", scopes);
                value.set("matchedFieldNames", fields);
                value.set("matchedEnumValues", literals);
                result.push(value);
            }
        }
    }
    return *result;
}

/** Returns concrete scope and backend-safe normalized query for selected map/layers. */
NativeJsValue TileLayerParser::normalizeSearchQuery(
    std::string const& query,
    std::string const& scope,
    NativeJsValue const& options_) const
{
    // Normalization is mapget-owned and layer-local: every selected feature
    // layer owns one LayerSchema, and that registry performs the actual
    // schema-aware SIMFIL AST analysis/rewrite. Erdblick only merges the
    // layer-local results into the single backend query currently carried by
    // the search websocket request.
    auto const selectedLayers = selectedLayerFilterFromOptions(JsValue(options_));
    auto const requestedScope = requestedSearchScopeFromString(scope);
    auto attributeScopes = JsValue::List();
    std::set<std::string> seenAttributeScopes;
    std::set<std::string> matchedFeatureTypesSet;
    std::vector<std::string> normalizedAttributeQueries;
    bool anyAttributeScope = false;
    bool rewriteSuppressed = false;
    size_t attributeScopeCandidateCount = 0;
    std::string rewriteSuppressionReason;
    std::optional<std::string> firstError;

    for (auto const& [_, dataSource] : info_) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (layerInfo && !selectedLayers.contains(dataSource.mapId_, layerInfo->layerId_)) {
                continue;
            }
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->layerSchema();
            if (!registry) {
                continue;
            }

            // LayerSchema::normalizeSearchQuery compiles the query with
            // SIMFIL RewriteMode::Schema against each feature root, maps the
            // resulting referencedSchemaPaths to feature/attribute owners, and
            // rewrites explicit feature-root attribute paths to attribute-root
            // paths via AST source locations. Generic wildcard/scalar
            // shorthand stays in the normal SIMFIL compile path used during
            // final mapget evaluation.
            auto normalized = registry->normalizeSearchQuery(query, requestedScope);
            if (!normalized) {
                if (!firstError) {
                    firstError = normalized.error().message;
                }
                continue;
            }

            attributeScopeCandidateCount += normalized->attributeScopeCandidateCount_;
            if (normalized->rewriteSuppressed_) {
                rewriteSuppressed = true;
                if (normalized->concreteScope_ == mapget::LayerSchema::SearchQueryConcreteScope::Attribute) {
                    anyAttributeScope = true;
                    normalizedAttributeQueries.push_back(normalized->normalizedQuery_);
                }
                if (rewriteSuppressionReason.empty()) {
                    rewriteSuppressionReason = normalized->rewriteSuppressionReason_;
                }
                continue;
            }

            if (normalized->concreteScope_ == mapget::LayerSchema::SearchQueryConcreteScope::Attribute) {
                anyAttributeScope = true;
                normalizedAttributeQueries.push_back(normalized->normalizedQuery_);
                appendNormalizedAttributeScopes(
                    attributeScopes,
                    normalized->attributeScopes_,
                    dataSource.mapId_,
                    layerInfo->layerId_,
                    seenAttributeScopes);
                for (auto const& featureType : normalized->matchedFeatureTypes_) {
                    matchedFeatureTypesSet.insert(featureType);
                }
            }
        }
    }

    auto normalizedQuery = query;
    auto concreteScope = std::string("feature");
    if (requestedScope == mapget::LayerSchema::SearchQueryRequestedScope::Attribute || anyAttributeScope) {
        concreteScope = "attribute";
        // A single erdblick search request may cover several selected layers.
        // Each layer-local normalizer already produced guarded attribute-root
        // predicates, so merging by OR preserves backend correctness when the
        // same query string is evaluated independently on every selected layer.
        if (auto merged = mergeNormalizedAttributeQueries(std::move(normalizedAttributeQueries)); !merged.empty()) {
            normalizedQuery = std::move(merged);
        }
    }

    auto matchedFeatureTypes = JsValue::List();
    for (auto const& featureType : matchedFeatureTypesSet) {
        matchedFeatureTypes.push(JsValue(featureType));
    }

    auto result = JsValue::Dict({
        {"concreteScope", JsValue(concreteScope)},
        {"normalizedQuery", JsValue(normalizedQuery)},
        {"attributeScopes", attributeScopes},
        {"attributeScopeCandidateCount", JsValue(static_cast<int>(attributeScopeCandidateCount))},
        {"rewriteSuppressed", JsValue(rewriteSuppressed)},
        {"rewriteSuppressionReason", JsValue(rewriteSuppressionReason)},
        {"matchedFeatureTypes", matchedFeatureTypes}
    });
    if (firstError) {
        result.set("error", JsValue(*firstError));
    }
    return *result;
}

/** Discover only the requested semantic scope and share metadata at the JS boundary. */
NativeJsValue TileLayerParser::searchStyleFieldsForQuery(
    std::string const& query,
    std::string const& scope,
    NativeJsValue const& options_) const
{
    auto options = JsValue(options_);
    auto const selectedLayers = selectedLayerFilterFromOptions(options);
    StyleFieldDiscovery discovery(options);
    auto const requestedScope = requestedSearchScopeFromString(scope);
    bool attributeScope = requestedScope == mapget::LayerSchema::SearchQueryRequestedScope::Attribute;
    std::vector<FeatureSchemaInfo> featureScopes;
    for (auto const& [_, source] : info_) {
        for (auto const& [__, layer] : source.layers_) {
            if (!layer || layer->type_ != mapget::LayerType::Features ||
                !selectedLayers.contains(source.mapId_, layer->layerId_))
                continue;
            auto registry = layer->layerSchema();
            if (!registry)
                continue;

            // A confirmed search supplies its exact owners in one batch.
            // Browse them directly; their predicates already have the correct
            // result root and must not undergo another inference pass here.
            if (requestedScope == mapget::LayerSchema::SearchQueryRequestedScope::Attribute &&
                discovery.collectPrepared(registry, source.mapId_, layer->layerId_))
            {
                continue;
            }

            // Resolve owners exactly as execution does. Leaf/enum matching
            // also reaches shared metadata and can turn SPEED_LIMIT_METRIC
            // into every attribute in a layer. Never widen a failed or
            // ambiguous normalization to an unrelated full-layer inventory.
            if (requestedScope != mapget::LayerSchema::SearchQueryRequestedScope::Feature) {
                auto normalized = registry->normalizeSearchQuery(query, requestedScope);
                if (!normalized)
                    throw std::invalid_argument(normalized.error().message);
                if (normalized->rewriteSuppressed_) {
                    attributeScope |= normalized->concreteScope_ == mapget::LayerSchema::SearchQueryConcreteScope::Attribute;
                    continue;
                }
                if (normalized->concreteScope_ == mapget::LayerSchema::SearchQueryConcreteScope::Attribute) {
                    attributeScope = true;
                    for (auto const& owner : normalized->attributeScopes_)
                        discovery.collect(registry, owner.attributeSchema_, source.mapId_, layer->layerId_,
                            owner.featureType_, owner.attributeName_, owner.attributeLayerName_);
                    continue;
                }
            }
            // Auto scope is chosen across all selected layers, like query
            // normalization. Do not mix feature paths from an unmatched layer
            // into an attribute inventory resolved by another layer.
            for (auto const& type : registry->featureTypes()) {
                featureScopes.push_back(
                    {type,
                     source.mapId_,
                     layer->layerId_,
                     layer,
                     registry,
                     registry->featureSchema(type)});
            }
        }
    }
    if (!attributeScope) {
        for (auto const& context : featureScopes)
            discovery.collect(context.registry, context.featureSchema,
                context.mapId, context.layerId, context.featureType);
    }
    return discovery.result();
}

JsValue TileLayerParser::FilteredFeatureJumpTarget::toJsValue() const
{
    auto result = JsValue::Dict({
        {"id", JsValue(jumpTarget_.id_)},
        {"name", JsValue(jumpTarget_.name_)},
        {"error", error_ ? JsValue(*error_) : JsValue()},
    });
    auto mapNameList = JsValue::List();
    for (auto const& m : jumpTarget_.maps_) {
        mapNameList.push(JsValue(m));
    }
    result.set("maps", mapNameList);
    auto idPartList = JsValue::List();
    for (auto const& [key, value] : parsedParams_) {
        idPartList.push(JsValue::Dict({
            {"key", JsValue(key)},
            {"value", JsValue::fromVariant(value)}
        }));
    }
    result.set("idParts", idPartList);
    return result;
}

}
