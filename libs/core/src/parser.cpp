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

struct TileLayerParser::SchemaCompletionRoot
{
    std::shared_ptr<mapget::StringPool> strings;
    std::shared_ptr<simfil::ModelPool> model;
    simfil::ModelNode::Ptr root;
};

namespace {

constexpr int kSchemaCompletionDepth = 6;
const auto kNoCompletionBudget = [] {
    return false;
};

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
    std::shared_ptr<mapget::LayerSchema const> const& registry,
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

simfil::ModelNode::Ptr makeSchemaCompletionNode(
    std::shared_ptr<simfil::ModelPool> const& model,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    simfil::SchemaId schemaId,
    int depth,
    std::function<bool()> const& budgetExhausted = kNoCompletionBudget)
{
    if (!registry || schemaId == simfil::NoSchemaId || budgetExhausted()) {
        return model->newValue(std::string_view{});
    }

    switch (registry->kind(schemaId)) {
    case simfil::Schema::Kind::Object: {
        auto object = model->newObject();
        (void)object->setSchema(schemaId);
        if (depth > 0) {
            for (auto const& fieldName : registry->directFields(schemaId)) {
                if (budgetExhausted()) {
                    break;
                }
                auto childSchema = registry->childSchema(schemaId, fieldName);
                auto child = makeSchemaCompletionNode(model, registry, childSchema, depth - 1, budgetExhausted);
                (void)object->addField(fieldName, child);
            }
        }
        return object;
    }
    case simfil::Schema::Kind::Array: {
        auto array = model->newArray();
        (void)array->setSchema(schemaId);
        return array;
    }
    case simfil::Schema::Kind::Value:
        return model->newValue(std::string_view{});
    }

    return model->newValue(std::string_view{});
}

void addAttributeOverlayFields(
    simfil::model_ptr<simfil::Object>& attributeRoot,
    std::shared_ptr<simfil::ModelPool> const& model,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    std::string const& featureType,
    std::function<bool()> const& budgetExhausted = kNoCompletionBudget)
{
    (void)attributeRoot->addField("$name", std::string_view{});
    (void)attributeRoot->addField("$layer", std::string_view{});
    (void)attributeRoot->addField("$validityIndex", int64_t{0});
    (void)attributeRoot->addField("$validityCount", int64_t{1});

    auto featureSchema = registry ? registry->featureSchema(featureType) : simfil::NoSchemaId;
    if (featureSchema != simfil::NoSchemaId && !budgetExhausted()) {
        auto featureRoot = makeSchemaCompletionNode(model, registry, featureSchema, kSchemaCompletionDepth, budgetExhausted);
        (void)attributeRoot->addField("$feature", featureRoot);
    }
}

void addCompletionCandidates(
    std::set<simfil::CompletionCandidate>& merged,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    std::shared_ptr<simfil::StringPool> const& strings,
    std::string const& query,
    int point,
    simfil::ModelNode const& root,
    simfil::CompletionOptions const& options)
{
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionLayerSchema(*env, registry, strings);

    auto result = simfil::complete(*env, query, point, root, options);
    if (!result) {
        return;
    }
    for (auto candidate : *result) {
        merged.insert(enrichCompletionCandidate(std::move(candidate), registry, root.schema()));
    }
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
    return static_cast<bool>(layerInfo.featureModelSchema_);
}

/** Return the JSON Schema transport view still needed for search-style metadata. */
nlohmann::json featureModelSchemaJson(mapget::LayerInfo const& layerInfo)
{
    return layerInfo.featureModelSchema_ ? layerInfo.featureModelSchema_->toJsonSchema() : nlohmann::json::object();
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
    std::shared_ptr<mapget::LayerSchema const> registry;
    simfil::SchemaId attributeSchema = simfil::NoSchemaId;
    simfil::SchemaId featureSchema = simfil::NoSchemaId;
};

struct FeatureSchemaInfo
{
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::LayerInfo const> layerInfo;
    std::shared_ptr<mapget::LayerSchema const> registry;
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
            for (auto const& featureType : layerInfo->featureTypes_) {
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
                        scopes.push_back({
                            attrName,
                            attrLayerName,
                            featureType.name_,
                            dataSource.mapId_,
                            layerInfo->layerId_,
                            layerInfo,
                            registry,
                            attributeSchema,
                            featureSchema
                        });
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
            for (auto const& featureType : layerInfo->featureTypes_) {
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
    typeIds.reserve(layerInfo.featureTypes_.size());
    for (auto const& featureType : layerInfo.featureTypes_) {
        typeIds.push_back(featureType.name_);
    }
    return typeIds;
}

bool jsonSchemaHasType(nlohmann::json const& schema, std::string_view type)
{
    auto const typeIt = schema.find("type");
    if (typeIt == schema.end()) {
        return false;
    }
    if (typeIt->is_string()) {
        return typeIt->get_ref<std::string const&>() == type;
    }
    if (typeIt->is_array()) {
        return std::ranges::any_of(*typeIt, [&](auto const& item) {
            return item.is_string() && item.template get_ref<std::string const&>() == type;
        });
    }
    return false;
}

nlohmann::json const* resolveSchemaRef(nlohmann::json const& root, nlohmann::json const& schema)
{
    auto const refIt = schema.find("$ref");
    if (refIt == schema.end() || !refIt->is_string()) {
        return &schema;
    }
    auto const ref = refIt->get<std::string>();
    if (ref.empty() || ref.front() != '#') {
        return &schema;
    }
    try {
        return &root.at(nlohmann::json::json_pointer(ref.substr(1)));
    } catch (...) {
        return &schema;
    }
}

std::string_view schemaCombinerKey(nlohmann::json const& schema)
{
    for (std::string_view key : {"oneOf", "anyOf", "allOf"}) {
        auto const it = schema.find(std::string(key));
        if (it != schema.end() && it->is_array()) {
            return key;
        }
    }
    return {};
}

nlohmann::json const* resolveSchema(nlohmann::json const& root, nlohmann::json const* schema, int depth = 8)
{
    if (!schema || depth <= 0 || !schema->is_object()) {
        return schema;
    }
    auto const* resolved = resolveSchemaRef(root, *schema);
    return resolved == schema ? schema : resolveSchema(root, resolved, depth - 1);
}

nlohmann::json const* schemaChildForField(nlohmann::json const& root, nlohmann::json const* schema, std::string const& field, int depth = 8)
{
    auto const* resolved = resolveSchema(root, schema, depth);
    if (!resolved || !resolved->is_object() || depth <= 0) {
        return nullptr;
    }

    if (auto const combiner = schemaCombinerKey(*resolved); !combiner.empty()) {
        for (auto const& branch : resolved->at(std::string(combiner))) {
            if (auto const* child = schemaChildForField(root, &branch, field, depth - 1)) {
                return child;
            }
        }
    }

    if (auto const itemsIt = resolved->find("items"); itemsIt != resolved->end()) {
        if (auto const* child = schemaChildForField(root, &*itemsIt, field, depth - 1)) {
            return child;
        }
    }

    auto const propertiesIt = resolved->find("properties");
    if (propertiesIt == resolved->end() || !propertiesIt->is_object()) {
        return nullptr;
    }
    auto const childIt = propertiesIt->find(field);
    return childIt == propertiesIt->end() ? nullptr : &*childIt;
}

void appendUniqueEnumValues(std::vector<std::string>& target, std::vector<std::string> const& values)
{
    for (auto const& value : values) {
        if (std::ranges::find(target, value) == target.end()) {
            target.push_back(value);
        }
    }
}

std::optional<double> finiteSchemaNumber(nlohmann::json const& schema, std::string_view key)
{
    auto const it = schema.find(std::string(key));
    if (it == schema.end() || !it->is_number()) {
        return std::nullopt;
    }
    auto const value = it->get<double>();
    return std::isfinite(value) ? std::optional<double>{value} : std::nullopt;
}

void mergeNumericRange(SearchStyleSchemaMetadata& target, SearchStyleSchemaMetadata const& source)
{
    if (source.numericMinimum) {
        target.numericMinimum = target.numericMinimum
            ? std::min(*target.numericMinimum, *source.numericMinimum)
            : source.numericMinimum;
    }
    if (source.numericMaximum) {
        target.numericMaximum = target.numericMaximum
            ? std::max(*target.numericMaximum, *source.numericMaximum)
            : source.numericMaximum;
    }
}

SearchStyleSchemaMetadata schemaMetadata(
    nlohmann::json const& root,
    nlohmann::json const* schema,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    simfil::SchemaId schemaId,
    int depth = 8)
{
    SearchStyleSchemaMetadata metadata;
    auto const* resolved = resolveSchema(root, schema, depth);
    if (!resolved || !resolved->is_object() || depth <= 0) {
        if (registry && schemaId != simfil::NoSchemaId) {
            if (registry->kind(schemaId) == simfil::Schema::Kind::Object) {
                metadata.valueKind = "object";
            }
            else if (registry->kind(schemaId) == simfil::Schema::Kind::Array) {
                metadata.valueKind = "array";
            }
            else {
                auto const enumSymbols = registry->nestedEnumSymbols(schemaId);
                metadata.enumValues.assign(enumSymbols.begin(), enumSymbols.end());
                metadata.valueKind = metadata.enumValues.empty() ? "unknown" : "enum";
            }
        }
        return metadata;
    }

    if (auto const combiner = schemaCombinerKey(*resolved); !combiner.empty()) {
        std::string combinedKind;
        for (auto const& branch : resolved->at(std::string(combiner))) {
            auto branchMetadata = schemaMetadata(root, &branch, registry, simfil::NoSchemaId, depth - 1);
            appendUniqueEnumValues(metadata.enumValues, branchMetadata.enumValues);
            mergeNumericRange(metadata, branchMetadata);
            if (branchMetadata.valueKind == "unknown") {
                continue;
            }
            if (combinedKind.empty()) {
                combinedKind = branchMetadata.valueKind;
            }
            else if (combinedKind != branchMetadata.valueKind) {
                combinedKind = "unknown";
            }
        }
        metadata.valueKind = metadata.enumValues.empty() ? (combinedKind.empty() ? "unknown" : combinedKind) : "enum";
        return metadata;
    }

    auto addStringEnum = [&](nlohmann::json const& value) {
        if (value.is_string()) {
            metadata.enumValues.push_back(value.get<std::string>());
        }
    };
    if (auto const constIt = resolved->find("const"); constIt != resolved->end()) {
        addStringEnum(*constIt);
        if (constIt->is_boolean()) {
            metadata.valueKind = "boolean";
            return metadata;
        }
        if (constIt->is_number_integer()) {
            metadata.valueKind = "integer";
            metadata.numericMinimum = constIt->get<double>();
            metadata.numericMaximum = constIt->get<double>();
            return metadata;
        }
        if (constIt->is_number()) {
            metadata.valueKind = "number";
            metadata.numericMinimum = constIt->get<double>();
            metadata.numericMaximum = constIt->get<double>();
            return metadata;
        }
    }
    if (auto const enumIt = resolved->find("enum"); enumIt != resolved->end() && enumIt->is_array()) {
        for (auto const& value : *enumIt) {
            addStringEnum(value);
        }
    }
    if (!metadata.enumValues.empty()) {
        std::ranges::sort(metadata.enumValues);
        auto duplicates = std::ranges::unique(metadata.enumValues);
        metadata.enumValues.erase(duplicates.begin(), duplicates.end());
        metadata.valueKind = "enum";
        return metadata;
    }

    if (jsonSchemaHasType(*resolved, "integer")) {
        metadata.valueKind = "integer";
    }
    else if (jsonSchemaHasType(*resolved, "number")) {
        metadata.valueKind = "number";
    }
    else if (jsonSchemaHasType(*resolved, "boolean")) {
        metadata.valueKind = "boolean";
    }
    else if (jsonSchemaHasType(*resolved, "string")) {
        metadata.valueKind = "string";
    }
    else if (jsonSchemaHasType(*resolved, "array") || resolved->contains("items")) {
        metadata.valueKind = "array";
    }
    else if (jsonSchemaHasType(*resolved, "object") || resolved->contains("properties")) {
        metadata.valueKind = "object";
    }
    else if (registry && schemaId != simfil::NoSchemaId) {
        if (registry->kind(schemaId) == simfil::Schema::Kind::Object) {
            metadata.valueKind = "object";
        }
        else if (registry->kind(schemaId) == simfil::Schema::Kind::Array) {
            metadata.valueKind = "array";
        }
    }
    if (metadata.valueKind == "integer" || metadata.valueKind == "number") {
        metadata.numericMinimum = finiteSchemaNumber(*resolved, "minimum");
        metadata.numericMaximum = finiteSchemaNumber(*resolved, "maximum");
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

nlohmann::json const* schemaForRegistryKey(
    nlohmann::json const& rootSchema,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    std::string const& key)
{
    if (!registry || rootSchema.is_null()) {
        return nullptr;
    }
    auto const* entry = registry->getSchema(key);
    if (!entry) {
        return nullptr;
    }
    auto const& pointer = entry->jsonPointer_;
    try {
        if (pointer == "#") {
            return &rootSchema;
        }
        if (!pointer.empty() && pointer.front() == '#') {
            return &rootSchema.at(nlohmann::json::json_pointer(pointer.substr(1)));
        }
        return &rootSchema.at(nlohmann::json::json_pointer(pointer));
    } catch (...) {
        return nullptr;
    }
}

/** Recursively enumerates nested schema paths that mapget can return through `withFields`. */
void collectSchemaFieldPaths(
    std::vector<SearchStyleFieldPath>& paths,
    std::shared_ptr<mapget::LayerSchema const> const& registry,
    simfil::SchemaId schemaId,
    nlohmann::json const* schemaJson,
    nlohmann::json const& rootSchema,
    std::string const& basePath,
    std::set<simfil::SchemaId>& activeSchemas)
{
    if (!registry || schemaId == simfil::NoSchemaId) {
        return;
    }
    if (!activeSchemas.insert(schemaId).second) {
        return;
    }

    for (auto const& field : registry->directFields(schemaId)) {
        auto const path = appendFieldPathSegment(basePath, field);
        auto const childSchema = registry->childSchema(schemaId, field);
        auto const* childJson = schemaChildForField(rootSchema, schemaJson, field);
        auto metadata = schemaMetadata(rootSchema, childJson, registry, childSchema);
        paths.push_back({
            path,
            childSchema,
            metadata.valueKind,
            metadata.enumValues,
            metadata.numericMinimum,
            metadata.numericMaximum
        });
        if (childSchema != simfil::NoSchemaId && registry->kind(childSchema) == simfil::Schema::Kind::Object) {
            collectSchemaFieldPaths(paths, registry, childSchema, childJson, rootSchema, path, activeSchemas);
        }
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
    fields.push_back({
        path,
        mapId,
        layerId,
        attrName,
        attrLayerName,
        featureType,
        metadata.valueKind,
        metadata.enumValues,
        metadata.numericMinimum,
        metadata.numericMaximum
    });
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

void TileLayerParser::setDataSourceInfo(const erdblick::SharedUint8Array& dataSourceInfoJson)
{
    info_.clear();
    featureJumpTargets_.clear();
    schemaCompletionRoots_.clear();
    // Datasource reloads may reuse node ids with a fresh string dictionary.
    // Drop offsets here so subsequent requests cannot suppress required pool updates.
    cachedStrings_ = std::make_shared<mapget::TileLayerStream::StringPoolCache>();
    reset();

    // Parse data source info
    auto srcInfoParsed = nlohmann::json::parse(dataSourceInfoJson.toString());

    // Index available feature types by their feature id compositions.
    // These will be the available jump-to-feature targets.
    // For each composition, allow a version with and without optional params.
    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
        if (dsInfo.isAddOn_) {
            // Do not expose add-on datasources in the frontend.
            continue;
        }
        for (auto const& [_, l] : dsInfo.layers_) {
            for (auto const& tp : l->featureTypes_) {
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
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& stringPoolId) {
            return cachedStrings_->getStringPool(stringPoolId);
        }));
    return result;
}

TileSourceDataLayer TileLayerParser::readTileSourceDataLayer(SharedUint8Array const& buffer)
{
    auto result = TileSourceDataLayer(std::make_shared<mapget::TileSourceDataLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& stringPoolId) {
            return cachedStrings_->getStringPool(stringPoolId);
        }));
    return result;
}

TileSubsetLayer TileLayerParser::readTileSubsetLayer(SharedUint8Array const& buffer)
{
    auto result = TileSubsetLayer(std::make_shared<mapget::TileSubsetLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& stringPoolId) {
            return cachedStrings_->getStringPool(stringPoolId);
        }));
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
        tileLayer.tileId().value(),
        tileLayer.legalInfo() ? *tileLayer.legalInfo() : "",
        tileLayer.error() ? *tileLayer.error() : "",
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
            {"tileId", JsValue(dependency.sourceTileKey_.tileId_.value())},
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
    schemaCompletionRoots_.clear();
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
    auto cachedCompletionRoot = [&](std::string const& key, auto&& build) -> SchemaCompletionRoot* {
        auto existing = schemaCompletionRoots_.find(key);
        if (existing != schemaCompletionRoots_.end()) {
            return existing->second.get();
        }

        auto entry = std::make_shared<SchemaCompletionRoot>();
        entry->strings = std::make_shared<mapget::StringPool>("SearchCompletion");
        entry->model = std::make_shared<simfil::ModelPool>(entry->strings);
        entry->root = build(entry->model, entry->strings);
        if (completionBudgetExhausted()) {
            return nullptr;
        }
        auto [inserted, _] = schemaCompletionRoots_.emplace(key, std::move(entry));
        return inserted->second.get();
    };
    auto completionCacheKey = [](std::shared_ptr<mapget::LayerSchema const> const& registry,
                                 std::string_view kind,
                                 simfil::SchemaId schema,
                                 simfil::SchemaId overlaySchema = simfil::NoSchemaId,
                                 std::string_view qualifier = {}) {
        std::ostringstream key;
        key << reinterpret_cast<uintptr_t>(registry.get())
            << ':' << kind
            << ':' << schema
            << ':' << overlaySchema
            << ':' << qualifier;
        return key.str();
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
            std::shared_ptr<mapget::LayerSchema const> registry = layerInfo->layerSchema();
            if (!registry) {
                continue;
            }

            for (auto const& featureType : layerInfo->featureTypes_) {
                auto const featureSchema = registry->featureSchema(featureType.name_);
                if (includeFeatureScope && featureSchema != simfil::NoSchemaId) {
                    if (completionBudgetExhausted()) {
                        return completionCandidatesToJs(query, mergedCandidates, opts.limit);
                    }
                    auto* cachedRoot = cachedCompletionRoot(
                        completionCacheKey(registry, "feature", featureSchema),
                        [&](auto const& model, auto const&) {
                            return makeSchemaCompletionNode(
                                model,
                                registry,
                                featureSchema,
                                kSchemaCompletionDepth,
                                completionBudgetExhausted);
                        });
                    if (!cachedRoot) {
                        return completionCandidatesToJs(query, mergedCandidates, opts.limit);
                    }
                    addCompletionCandidates(mergedCandidates, registry, cachedRoot->strings, query, point, *cachedRoot->root, opts);
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

                        auto* cachedRoot = cachedCompletionRoot(
                            completionCacheKey(
                                registry,
                                "attribute",
                                attributeSchema,
                                featureSchema,
                                featureType.name_),
                            [&](auto const& model, auto const&) -> simfil::ModelNode::Ptr {
                                auto attributeRoot = model->newObject();
                                (void)attributeRoot->setSchema(attributeSchema);
                                for (auto const& fieldName : registry->directFields(attributeSchema)) {
                                    if (completionBudgetExhausted()) {
                                        break;
                                    }
                                    auto childSchema = registry->childSchema(attributeSchema, fieldName);
                                    auto child = makeSchemaCompletionNode(
                                        model,
                                        registry,
                                        childSchema,
                                        kSchemaCompletionDepth - 1,
                                        completionBudgetExhausted);
                                    (void)attributeRoot->addField(fieldName, child);
                                }
                                addAttributeOverlayFields(
                                    attributeRoot,
                                    model,
                                    registry,
                                    featureType.name_,
                                    completionBudgetExhausted);
                                return attributeRoot;
                            });
                        if (!cachedRoot) {
                            return completionCandidatesToJs(query, mergedCandidates, opts.limit);
                        }
                        addCompletionCandidates(
                            mergedCandidates,
                            registry,
                            cachedRoot->strings,
                            query,
                            point,
                            *cachedRoot->root,
                            opts);
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
        // Attribute-scope rules can style both the matched attribute value and
        // selected feature-level fields through the `$feature` overlay.
        auto const allScopes = collectAttributeScopes(info_, selectedLayers);
        auto const& scopes = discoveredAttributeScopes.empty() ? allScopes : discoveredAttributeScopes;
        for (auto const& attrScope : scopes) {
            auto const rootSchema = attrScope.layerInfo
                ? featureModelSchemaJson(*attrScope.layerInfo)
                : nlohmann::json::object();
            auto const* attributeSchemaJson = attrScope.layerInfo
                ? schemaForRegistryKey(
                    rootSchema,
                    attrScope.registry,
                    "Attribute:" + attrScope.featureType + ":" + attrScope.attrLayerName + ":" + attrScope.attrName)
                : nullptr;
            if (!attributeSchemaJson && attrScope.layerInfo) {
                auto const* layerMapJson = schemaForRegistryKey(
                    rootSchema,
                    attrScope.registry,
                    "AttributeLayerMap:" + attrScope.featureType);
                auto const* attrLayerJson = schemaChildForField(
                    rootSchema,
                    layerMapJson,
                    attrScope.attrLayerName);
                attributeSchemaJson = schemaChildForField(
                    rootSchema,
                    attrLayerJson,
                    attrScope.attrName);
            }
            std::vector<SearchStyleFieldPath> paths;
            std::set<simfil::SchemaId> activeSchemas;
            collectSchemaFieldPaths(
                paths,
                attrScope.registry,
                attrScope.attributeSchema,
                attributeSchemaJson,
                rootSchema,
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
                    {path.valueKind, path.enumValues, path.numericMinimum, path.numericMaximum});
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

            addSearchStyleField(
                fields,
                seen,
                "$feature",
                attrScope.mapId,
                attrScope.layerId,
                attrScope.attrName,
                attrScope.attrLayerName,
                attrScope.featureType,
                overlayFieldMetadata("$feature"));
            auto const* featureSchemaJson = attrScope.layerInfo
                ? schemaForRegistryKey(rootSchema, attrScope.registry, "Feature:" + attrScope.featureType)
                : nullptr;
            std::vector<SearchStyleFieldPath> featurePaths;
            std::set<simfil::SchemaId> activeFeatureSchemas;
            collectSchemaFieldPaths(
                featurePaths,
                attrScope.registry,
                attrScope.featureSchema,
                featureSchemaJson,
                rootSchema,
                "$feature",
                activeFeatureSchemas);
            for (auto const& path : featurePaths) {
                auto metadata = SearchStyleSchemaMetadata{
                    path.valueKind,
                    path.enumValues,
                    path.numericMinimum,
                    path.numericMaximum};
                if (path.path == "$feature.typeId") {
                    metadata = typeIdSchemaMetadata({attrScope.featureType});
                }
                addSearchStyleField(
                    fields,
                    seen,
                    path.path,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.attrLayerName,
                    attrScope.featureType,
                    std::move(metadata));
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
                auto const rootSchema = featureModelSchemaJson(*layerInfo);
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
                for (auto const& featureType : layerInfo->featureTypes_) {
                    auto const* featureSchemaJson = schemaForRegistryKey(rootSchema, registry, "Feature:" + featureType.name_);
                    std::vector<SearchStyleFieldPath> paths;
                    std::set<simfil::SchemaId> activeSchemas;
                    collectSchemaFieldPaths(
                        paths,
                        registry,
                        registry->featureSchema(featureType.name_),
                        featureSchemaJson,
                        rootSchema,
                        "",
                        activeSchemas);
                    for (auto const& path : paths) {
                        auto metadata = SearchStyleSchemaMetadata{
                            path.valueKind,
                            path.enumValues,
                            path.numericMinimum,
                            path.numericMaximum};
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
