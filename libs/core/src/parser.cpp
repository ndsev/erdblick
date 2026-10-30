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
    simfil::SchemaId rootSchema)
{
    if (!registry || !candidate.hint.empty() || candidate.type != simfil::CompletionCandidate::Type::CONSTANT) {
        return candidate;
    }

    auto const symbolName = completionConstantSymbol(candidate.text);
    candidate.hint = completionTypeHint(registry->constantTypeNames(rootSchema, symbolName));
    return candidate;
}

/** Return whether two completions are the same user-visible candidate before hint decoration. */
bool sameCompletionIdentity(simfil::CompletionCandidate const& lhs, simfil::CompletionCandidate const& rhs)
{
    return lhs.text == rhs.text
        && lhs.location.offset == rhs.location.offset
        && lhs.location.size == rhs.location.size
        && lhs.type == rhs.type;
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
            std::remove_if(normalized.begin(), normalized.end(), [&](auto const& item) {
                return item.type == simfil::CompletionCandidate::Type::CONSTANT
                    && fieldCandidateTexts.contains(completionConstantSymbol(item.text));
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
            {"range", JsValue::List({
                JsValue(static_cast<int>(item.location.offset)),
                JsValue(static_cast<int>(item.location.size)),
            })},
            {"query", JsValue(completedQuery)},
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
    simfil::SchemaId attributeSchema = simfil::NoSchemaId;
    simfil::SchemaId featureSchema = simfil::NoSchemaId;
};

struct FeatureSchemaInfo
{
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::LayerInfo const> layerInfo;
    simfil::model_ptr<mapget::LayerSchema> registry;
    simfil::SchemaId featureSchema = simfil::NoSchemaId;
};

struct SearchStyleFieldInfo
{
    std::string path;
    std::string mapId;
    std::string layerId;
    std::string attrName;
    std::string attrLayerName;
    std::string featureType;
    std::string valueKind = "unknown";
    std::vector<std::string> enumValues;
    std::optional<double> numericMinimum;
    std::optional<double> numericMaximum;
    JsValue domain = JsValue::Undefined();
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

struct SearchStyleFieldPath
{
    std::string path;
    simfil::SchemaId schemaId = simfil::NoSchemaId;
    std::string valueKind = "unknown";
    std::vector<std::string> enumValues;
    std::optional<double> numericMinimum;
    std::optional<double> numericMaximum;
    JsValue domain = JsValue::Undefined();
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
            for (auto const& featureType : layerInfo->featureTypes()) {
                if (!registry->producesFeatureType(featureType.name_))
                    continue;
                auto const featureSchema = registry->featureSchema(featureType.name_);
                auto const layerMapSchema = registry->attributeLayerMapSchema(featureType.name_);
                if (layerMapSchema == simfil::NoSchemaId) {
                    continue;
                }
                for (auto const& attrLayerName : registry->directFields(layerMapSchema)) {
                    auto const layerSchema = registry->childSchema(
                        layerMapSchema,
                        attrLayerName,
                        simfil::Schema::Kind::Object);
                    if (layerSchema == simfil::NoSchemaId) {
                        continue;
                    }
                    for (auto const& attrName : registry->directFields(layerSchema)) {
                        auto const attributeSchema = registry->childSchema(
                            layerSchema,
                            attrName,
                            simfil::Schema::Kind::Object);
                        if (attributeSchema == simfil::NoSchemaId) {
                            continue;
                        }
                        scopes.push_back(
                            {std::string(attrName),
                             std::string(attrLayerName),
                             featureType.name_,
                             dataSource.mapId_,
                             layerInfo->layerId_,
                             layerInfo,
                             registry,
                             attributeSchema,
                             featureSchema});
                    }
                }
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
            for (auto const& featureType : layerInfo->featureTypes()) {
                if (!registry->producesFeatureType(featureType.name_))
                    continue;
                auto const featureSchema = registry->featureSchema(featureType.name_);
                if (featureSchema == simfil::NoSchemaId) {
                    continue;
                }
                scopes.push_back({
                    featureType.name_,
                    dataSource.mapId_,
                    layerInfo->layerId_,
                    layerInfo,
                    registry,
                    featureSchema
                });
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
    simfil::SchemaId schemaId,
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
            if (!featureScope.registry->canHaveField(featureScope.featureSchema, fieldName)) {
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
    simfil::SchemaId schemaId,
    QueryLayerTerms const& terms,
    SearchQueryMapLayerInference* inference)
{
    bool matched = false;
    for (auto const& fieldName : terms.leafFields) {
        if (registry.canHaveField(schemaId, fieldName)) {
            if (inference) {
                inference->matchedFieldNames.insert(fieldName);
            }
            matched = true;
        }
    }
    for (auto const& enumValue : terms.enumValues) {
        if (registry.canHaveEnumSymbol(schemaId, enumValue)
            || !registry.constantTypeNames(schemaId, enumValue).empty()) {
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
    JsValue domain = JsValue::Undefined();
};

/** Builds enum metadata for feature `typeId` values advertised by the selected layer context. */
SearchStyleSchemaMetadata typeIdSchemaMetadata(std::vector<std::string> typeIds)
{
    std::ranges::sort(typeIds);
    auto duplicates = std::ranges::unique(typeIds);
    typeIds.erase(duplicates.begin(), duplicates.end());
    return {"enum", std::move(typeIds), std::nullopt, std::nullopt};
}

/** Returns all feature type ids a layer can produce. */
std::vector<std::string> featureTypeIdsForLayer(mapget::LayerInfo const& layerInfo)
{
    std::vector<std::string> typeIds;
    typeIds.reserve(layerInfo.featureTypes().size());
    for (auto const& featureType : layerInfo.featureTypes()) {
        if (layerInfo.layerSchema()->producesFeatureType(featureType.name_))
            typeIds.push_back(featureType.name_);
    }
    return typeIds;
}

/** Classifies one concrete domain directly, retaining the primitive numeric type. */
SearchStyleSchemaMetadata
schemaMetadata(simfil::model_ptr<mapget::LayerSchema> const& registry, simfil::SchemaId schemaId)
{
    SearchStyleSchemaMetadata metadata;
    if (!registry || schemaId == simfil::NoSchemaId)
        return metadata;
    auto const affinities = simfil::Schema::affinities(registry->kind(schemaId)) &
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
    auto const symbols = registry->directEnumSymbols(schemaId);
    metadata.enumValues.assign(symbols.begin(), symbols.end());
    if (metadata.valueKind == "string" && !metadata.enumValues.empty())
        metadata.valueKind = "enum";
    metadata.domain = JsValue::fromSchema({registry->mapSchema()->binding(), schemaId});
    if (auto numeric = registry->numericDomain(schemaId)) {
        // Only ordinary measurement intervals seed a gradient. Specials remain
        // separate exact-value rules, even when they lie inside the raw encoding.
        auto number = [](simfil::Schema::NumericValue const& value) -> std::optional<double>
        {
            auto result = std::visit([](auto raw) { return double(raw); }, value);
            return std::isfinite(result) && std::abs(result) <= 9007199254740991.0 ?
                std::optional<double>{result} :
                std::nullopt;
        };
        if (numeric->ordinaryRanges.size() == 1) {
            metadata.numericMinimum = number(numeric->ordinaryRanges.front().min);
            metadata.numericMaximum = number(numeric->ordinaryRanges.front().max);
        }
        else if (numeric->ordinaryRanges.empty()) {
            bool hasSpecials = false;
            registry->forEachNamedValue(
                schemaId,
                [&](auto const& value)
                { hasSpecials |= value.role == simfil::Schema::NamedValue::Role::Special; });
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

/** Enumerates concrete native field domains without a JSON-schema export/reparse. */
void collectSchemaFieldPaths(
    std::vector<SearchStyleFieldPath>& paths,
    simfil::model_ptr<mapget::LayerSchema> const& registry,
    simfil::SchemaId schemaId,
    std::string const& basePath,
    std::set<simfil::SchemaId>& activeSchemas)
{
    if (!registry || schemaId == simfil::NoSchemaId || !activeSchemas.insert(schemaId).second)
        return;
    for (auto const field : registry->directFields(schemaId)) {
        auto const path = appendFieldPathSegment(basePath, std::string(field));
        auto const childSchema = registry->childSchema(schemaId, field);
        auto metadata = schemaMetadata(registry, childSchema);
        paths.push_back(
            {path,
             childSchema,
             metadata.valueKind,
             metadata.enumValues,
             metadata.numericMinimum,
             metadata.numericMaximum,
             metadata.domain});
        if (childSchema != simfil::NoSchemaId &&
            (simfil::Schema::affinities(registry->kind(childSchema)) &
             simfil::valueTypeAffinity(simfil::ValueType::Object)))
            collectSchemaFieldPaths(paths, registry, childSchema, path, activeSchemas);
    }
    activeSchemas.erase(schemaId);
}

/** Adds one search-style field candidate while preserving map/layer/attribute context. */
void addSearchStyleField(
    std::vector<SearchStyleFieldInfo>& fields,
    std::set<std::string>& seen,
    std::string const& path,
    std::string const& mapId,
    std::string const& layerId,
    std::string const& attrName,
    std::string const& attrLayerName,
    std::string const& featureType,
    SearchStyleSchemaMetadata metadata = {})
{
    if (path.empty()) {
        return;
    }
    auto const key = mapId + "\n" + layerId + "\n" + attrName + "\n"
        + attrLayerName + "\n" + featureType + "\n" + path;
    if (!seen.insert(key).second) {
        return;
    }
    fields.push_back(
        {path,
         mapId,
         layerId,
         attrName,
         attrLayerName,
         featureType,
         metadata.valueKind,
         metadata.enumValues,
         metadata.numericMinimum,
         metadata.numericMaximum,
         metadata.domain});
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

/** Converts native search-style field candidates into the embind JS value shape. */
NativeJsValue searchStyleFieldsToJs(std::vector<SearchStyleFieldInfo> const& fields)
{
    auto result = JsValue::List();
    for (auto const& field : fields) {
        auto item = JsValue::Dict({
            {"path", JsValue(field.path)},
            {"mapId", JsValue(field.mapId)},
            {"layerId", JsValue(field.layerId)},
            {"attrName", field.attrName.empty() ? JsValue::Undefined() : JsValue(field.attrName)},
            {"attrLayerName", field.attrLayerName.empty() ? JsValue::Undefined() : JsValue(field.attrLayerName)},
            {"featureType", field.featureType.empty() ? JsValue::Undefined() : JsValue(field.featureType)},
            {"valueKind", JsValue(field.valueKind)}
        });
        auto enumValues = JsValue::List();
        for (auto const& value : field.enumValues) {
            enumValues.push(JsValue(value));
        }
        item.set("enumValues", enumValues);
        if (field.numericMinimum && field.numericMaximum) {
            item.set("numericRange", JsValue::Dict({
                {"min", JsValue(*field.numericMinimum)},
                {"max", JsValue(*field.numericMaximum)}
            }));
        }
        item.set("domain", field.domain);
        result.push(item);
    }
    return *result;
}

} // namespace

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

NativeJsValue TileLayerParser::featureTypes(
    std::string const& mapId,
    std::string const& layerId,
    bool includeReferenceTypes) const
{
    auto const source = info_.find(mapId);
    if (source == info_.end())
        throw std::runtime_error("Datasource is not ready: " + mapId);
    auto const layer = source->second.layers_.find(layerId);
    if (layer == source->second.layers_.end())
        throw std::runtime_error("Unknown layer: " + layerId);
    auto const schema = layer->second->layerSchema();
    auto result = JsValue::List();
    for (auto const& type : schema->featureTypeInfos())
        if (includeReferenceTypes || schema->producesFeatureType(type.name_))
            result.push(JsValue(type.name_));
    return *result;
}

void TileLayerParser::setDataSourceInfo(const erdblick::SharedUint8Array& dataSourceInfoJson)
{
    // Validate replacement metadata against exact installed owners first. A bad
    // source must not clear the working catalog or its streamed dictionary state.
    TileLayerParser replacement;
    replacement.schemas_ = schemas_;
    replacement.addDataSourceInfo(dataSourceInfoJson);
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
    reset();
}

void TileLayerParser::addDataSourceInfo(const erdblick::SharedUint8Array& dataSourceInfoJson)
{
    // Validate the entire batch before changing live parser state. Appending a
    // map is safe on the existing stream; replacing one is not.
    std::vector<DataSourceInfo> additions;
    std::set<std::string> addedMapIds;
    for (auto const& node : nlohmann::json::parse(dataSourceInfoJson.toString())) {
        auto dsInfo = DataSourceInfo::fromJson(
            node,
            [this](std::string_view id) { return resolveMapSchema(id); });
        if (dsInfo.isAddOn_)
            continue;
        if (info_.contains(dsInfo.mapId_) || !addedMapIds.insert(dsInfo.mapId_).second)
            throw std::runtime_error(
                fmt::format("Datasource map '{}' is already registered", dsInfo.mapId_));
        additions.push_back(std::move(dsInfo));
    }

    // Index available feature types by their feature id compositions.
    // These will be the available jump-to-feature targets.
    // For each composition, allow a version with and without optional params.
    for (auto& dsInfo : additions) {
        for (auto const& [_, l] : dsInfo.layers_) {
            for (auto const& tp : l->featureTypes()) {
                if (!l->layerSchema()->producesFeatureType(tp.name_))
                    continue;
                for (auto const& composition : tp.uniqueIdCompositions_) {
                    for (auto const& withOptionals : {false, true}) {
                        std::vector<mapget::IdPart> idParts;
                        std::string compositionId = tp.name_;

                        for (auto const& idPart : composition) {
                            if (!idPart.isOptional_ || withOptionals) {
                                compositionId += fmt::format(".{}:{}", idPart.idPartLabel_, static_cast<uint32_t>(idPart.datatype_));
                                idParts.push_back(idPart);
                            }
                        }

                        auto& typeInfo = featureJumpTargets_[compositionId];
                        if (typeInfo.idParts_.empty()) {
                            typeInfo.id_ = compositionId;
                            typeInfo.idParts_ = idParts;
                            typeInfo.name_ = tp.name_;
                            typeInfo.layerInfo_ = l;
                        }
                        if (std::ranges::find(typeInfo.maps_, dsInfo.mapId_) == typeInfo.maps_.end())
                            typeInfo.maps_.emplace_back(dsInfo.mapId_);
                    }
                }
            }
        }

        schemas_.insert_or_assign(dsInfo.schemaId_, dsInfo.mapSchema_);
        info_.emplace(dsInfo.mapId_, std::move(dsInfo));
    }
}

void TileLayerParser::readFieldDictUpdate(SharedUint8Array const& bytes)
{
    try {
        reader_->read(bytes.toString());
    }
    catch(std::exception const& e) {
        std::cout << "ERROR: " << e.what() << std::endl;
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
    // A source-declared hard resource rejection cannot recover on expiration.
    // Keep it visible until explicit refresh/source reconfiguration; transient
    // resource-busy values retain the producer's short retry lifetime.
    const bool permanentPointCloudLimit = tileLayer.error() &&
        layerInfo.is_object() && layerInfo.contains("PointCloud/Error") &&
        layerInfo["PointCloud/Error"] == "resource-limit";
    const auto ttlMs = tileLayer.ttl() && !permanentPointCloudLimit
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
TileLayerParser::resolveMapLayerInfo(std::string const& mapId, std::string const& layerId)
{
    auto& map = info_[mapId];
    auto it = info_[mapId].layers_.find(layerId);
    if (it != map.layers_.end())
        return it->second;
    return fallbackLayerInfo_;
}

std::vector<TileLayerParser::FilteredFeatureJumpTarget>
TileLayerParser::filterFeatureJumpTargets(const std::string& queryString) const
{
    std::vector<FilteredFeatureJumpTarget> results;
    std::regex sep("[\\.,;|\\s]+"); // Regex to split the input based on multiple delimiters
    std::vector<std::string> tokens(
        std::sregex_token_iterator(queryString.begin(), queryString.end(), sep, -1),
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

    // Match all targets if there are no matching ones, or there is no prefix.
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
        for (const auto& part : target->idParts_) {
            auto partError = "?";

            if (tokenIndex >= tokens.size()) {
                result.error_ = "Insufficient parameters.";
                result.parsedParams_.emplace_back(part.idPartLabel_, partError);
                continue; // Skip optional parts if no more tokens.
            }

            std::variant<int64_t, std::string> parsedValue = tokens[tokenIndex++];
            std::string error;
            if (!part.validate(parsedValue, &error)) {
                result.error_ = error;
                parsedValue = partError;
            }

            result.parsedParams_.emplace_back(part.idPartLabel_, parsedValue);
        }

        if (tokenIndex < tokens.size()) {
            result.error_ = "Too many parameters.";
        }

        results.push_back(result);
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
    (void) fieldDict->read(buffer.bytes(), bytesRead);
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
    auto const selectedLayers = selectedLayerFilterFromOptions(options);
    std::set<simfil::CompletionCandidate> mergedCandidates;
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
        [&](simfil::model_ptr<mapget::LayerSchema> const& registry, simfil::SchemaId rootSchema)
    {
        if (rootSchema == simfil::NoSchemaId || completionBudgetExhausted()) {
            return;
        }
        auto& binding = schemaCompletionBindings_
            [{std::string(registry->mapSchema()->schemaId()), std::string(registry->name())}];
        if (!binding) {
            binding = std::make_shared<SchemaCompletionBinding>();
            binding->strings = std::make_shared<mapget::StringPool>("SearchCompletion");
            binding->environment = mapget::makeEnvironment(binding->strings);
            // The native binding retains the registry and translates its field IDs
            // into this private pool. No datasource strings or sample model mutate.
            mapget::installCompletionLayerSchema(*binding->environment, registry, binding->strings);
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
                mergedCandidates.insert(enrichCompletionCandidate(std::move(candidate), registry, rootSchema));
            }
        }
    };

    for (auto const& [_, dataSource] : info_) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (completionBudgetExhausted()) {
                return completionCandidatesToJs(query, mergedCandidates, opts.limit);
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

            for (auto const& featureType : layerInfo->featureTypes()) {
                if (!registry->producesFeatureType(featureType.name_))
                    continue;
                auto const featureSchema = registry->featureSchema(featureType.name_);
                if (includeFeatureScope && featureSchema != simfil::NoSchemaId) {
                    if (completionBudgetExhausted()) {
                        return completionCandidatesToJs(query, mergedCandidates, opts.limit);
                    }
                    addCandidates(registry, featureSchema);
                }

                if (!includeAttributeScope) {
                    continue;
                }

                auto const layerMapSchema = registry->attributeLayerMapSchema(featureType.name_);
                if (layerMapSchema == simfil::NoSchemaId) {
                    continue;
                }
                for (auto const& layerName : registry->directFields(layerMapSchema)) {
                    auto const layerSchema = registry->childSchema(
                        layerMapSchema,
                        layerName,
                        simfil::Schema::Kind::Object);
                    if (layerSchema == simfil::NoSchemaId) {
                        continue;
                    }
                    for (auto const& attributeName : registry->directFields(layerSchema)) {
                        auto const attributeSchema = registry->childSchema(
                            layerSchema,
                            attributeName,
                            simfil::Schema::Kind::Object);
                        if (attributeSchema == simfil::NoSchemaId) {
                            continue;
                        }
                        if (completionBudgetExhausted()) {
                            return completionCandidatesToJs(query, mergedCandidates, opts.limit);
                        }

                        addCandidates(registry, registry->attributeQuerySchema(featureType.name_, attributeSchema));
                    }
                }
            }
        }
    }

    return completionCandidatesToJs(query, mergedCandidates, opts.limit);
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

/** Enumerates result fields available to search-result style rules for the requested scope. */
NativeJsValue TileLayerParser::searchStyleFieldsForQuery(
    std::string const& query,
    std::string const& scope,
    NativeJsValue const& options_) const
{
    auto const selectedLayers = selectedLayerFilterFromOptions(JsValue(options_));
    auto const discoveredAttributeScopes = resolveAttributeScopesForQuery(info_, query, selectedLayers);
    auto const concreteScope = scope == "auto"
        ? (!discoveredAttributeScopes.empty() ? "attribute" : "feature")
        : scope;

    std::vector<SearchStyleFieldInfo> fields;
    std::set<std::string> seen;

    if (concreteScope == "attribute") {
        // Attribute-scope pickers expose the matched value and cheap overlay
        // metadata. Feature-level `$feature` expressions remain available as
        // manually authored expressions without expanding every feature schema.
        auto const allScopes = collectAttributeScopes(info_, selectedLayers);
        auto const& scopes = discoveredAttributeScopes.empty() ? allScopes : discoveredAttributeScopes;
        for (auto const& attrScope : scopes) {
            std::vector<SearchStyleFieldPath> paths;
            std::set<simfil::SchemaId> activeSchemas;
            collectSchemaFieldPaths(
                paths,
                attrScope.registry,
                attrScope.attributeSchema,
                "",
                activeSchemas);
            for (auto const& path : paths) {
                addSearchStyleField(
                    fields,
                    seen,
                    path.path,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.attrLayerName,
                    attrScope.featureType,
                    {path.valueKind,
                     path.enumValues,
                     path.numericMinimum,
                     path.numericMaximum,
                     path.domain});
            }

            for (auto const& overlayField : {"$name", "$layer", "$validityIndex", "$validityCount"}) {
                addSearchStyleField(
                    fields,
                    seen,
                    overlayField,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.attrLayerName,
                    attrScope.featureType,
                    overlayFieldMetadata(overlayField));
            }
        }
    }
    else {
        // Feature-scope style fields come directly from each advertised feature schema.
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
                auto const layerTypeIdMetadata = typeIdSchemaMetadata(featureTypeIdsForLayer(*layerInfo));
                addSearchStyleField(
                    fields,
                    seen,
                    "typeId",
                    dataSource.mapId_,
                    layerInfo->layerId_,
                    "",
                    "",
                    "",
                    layerTypeIdMetadata);
                for (auto const& featureType : layerInfo->featureTypes()) {
                    if (!registry->producesFeatureType(featureType.name_))
                        continue;
                    auto const featureSchema = registry->featureSchema(featureType.name_);
                    std::vector<SearchStyleFieldPath> paths;
                    std::set<simfil::SchemaId> activeSchemas;
                    collectSchemaFieldPaths(paths, registry, featureSchema, "", activeSchemas);
                    // Offer the runtime lookup alias in the picker without duplicating
                    // canonical schema paths. A declared attributes member keeps precedence.
                    auto const rootFields = registry->directFields(featureSchema);
                    if (std::ranges::find(rootFields, "attributes") == rootFields.end() &&
                        std::ranges::find(rootFields, "properties") != rootFields.end())
                    {
                        auto const canonicalCount = paths.size();
                        for (size_t i = 0; i < canonicalCount; ++i) {
                            if (paths[i].path == "properties" ||
                                paths[i].path.starts_with("properties.")) {
                                auto alias = paths[i];
                                alias.path.replace(
                                    0,
                                    std::string_view("properties").size(),
                                    "attributes");
                                paths.push_back(std::move(alias));
                            }
                        }
                    }
                    for (auto const& path : paths) {
                        auto metadata = SearchStyleSchemaMetadata{
                            path.valueKind,
                            path.enumValues,
                            path.numericMinimum,
                            path.numericMaximum,
                            path.domain};
                        if (path.path == "typeId") {
                            metadata = layerTypeIdMetadata;
                        }
                        addSearchStyleField(
                            fields,
                            seen,
                            path.path,
                            dataSource.mapId_,
                            layerInfo->layerId_,
                            "",
                            "",
                            featureType.name_,
                            std::move(metadata));
                    }
                }
            }
        }
    }

    std::ranges::sort(fields, [](auto const& lhs, auto const& rhs) {
        return std::tie(lhs.path, lhs.mapId, lhs.layerId, lhs.attrName, lhs.attrLayerName, lhs.featureType)
            < std::tie(rhs.path, rhs.mapId, rhs.layerId, rhs.attrName, rhs.attrLayerName, rhs.featureType);
    });
    return searchStyleFieldsToJs(fields);
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
