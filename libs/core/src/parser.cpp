#include <algorithm>
#include <cctype>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <span>
#include <sstream>
#include <tuple>
#include <unordered_set>
#include <nlohmann/json.hpp>
#include "mapget/model/stringpool.h"
#include "mapget/model/schemaregistry.h"
#include "mapget/model/simfilutil.h"
#include "simfil/model/model.h"
#include "simfil/simfil.h"
#include "parser.h"

using namespace mapget;

namespace erdblick
{

namespace {

constexpr int kSchemaCompletionDepth = 6;

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
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
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
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    simfil::SchemaId schemaId,
    int depth)
{
    if (!registry || schemaId == simfil::NoSchemaId) {
        return model->newValue(std::string_view{});
    }

    switch (registry->kind(schemaId)) {
    case simfil::Schema::Kind::Object: {
        auto object = model->newObject();
        (void)object->setSchema(schemaId);
        if (depth > 0) {
            for (auto const& fieldName : registry->directFields(schemaId)) {
                auto childSchema = registry->childSchema(schemaId, fieldName);
                auto child = makeSchemaCompletionNode(model, registry, childSchema, depth - 1);
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
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    std::string const& featureType)
{
    (void)attributeRoot->addField("$name", std::string_view{});
    (void)attributeRoot->addField("$layer", std::string_view{});
    (void)attributeRoot->addField("$validityIndex", int64_t{0});
    (void)attributeRoot->addField("$validityCount", int64_t{1});

    auto featureSchema = registry ? registry->featureSchema(featureType) : simfil::NoSchemaId;
    if (featureSchema != simfil::NoSchemaId) {
        auto featureRoot = makeSchemaCompletionNode(model, registry, featureSchema, kSchemaCompletionDepth);
        (void)attributeRoot->addField("$feature", featureRoot);
    }
}

void addCompletionCandidates(
    std::set<simfil::CompletionCandidate>& merged,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    std::shared_ptr<simfil::StringPool> const& strings,
    std::string const& query,
    int point,
    simfil::ModelNode const& root,
    simfil::CompletionOptions const& options)
{
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, registry, strings);

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
    return !layerInfo.featureModelSchema_.is_null();
}

struct AttributeScopeInfo
{
    std::string attrName;
    std::string attrLayerName;
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::SchemaRegistry const> registry;
    simfil::SchemaId attributeSchema = simfil::NoSchemaId;
    simfil::SchemaId featureSchema = simfil::NoSchemaId;
};

struct FeatureSchemaInfo
{
    std::string featureType;
    std::string mapId;
    std::string layerId;
    std::shared_ptr<mapget::SchemaRegistry const> registry;
    simfil::SchemaId featureSchema = simfil::NoSchemaId;
};

struct SearchStyleFieldInfo
{
    std::string path;
    std::string mapId;
    std::string layerId;
    std::string attrName;
    std::string featureType;
};

/** Returns string literals from direct positive comparisons such as `$name == "SpeedLimit"`. */
std::set<std::string> positiveStringLiteralsForIdentifier(
    std::string const& query,
    std::string const& identifier)
{
    std::set<std::string> literals;
    bool inString = false;
    char quote = '\0';
    bool escaped = false;
    for (size_t i = 0; i < query.size();) {
        auto const c = query[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == quote) {
                inString = false;
            }
            ++i;
            continue;
        }
        if (c == '"' || c == '\'') {
            inString = true;
            quote = c;
            ++i;
            continue;
        }

        auto const isStart = std::isalpha(static_cast<unsigned char>(c)) || c == '_' || c == '$';
        if (!isStart) {
            ++i;
            continue;
        }
        auto const start = i;
        ++i;
        while (i < query.size()) {
            auto const next = query[i];
            if (!std::isalnum(static_cast<unsigned char>(next)) && next != '_' && next != '$') {
                break;
            }
            ++i;
        }
        if (query.substr(start, i - start) != identifier || (start > 0 && query[start - 1] == '.')) {
            continue;
        }

        auto j = i;
        while (j < query.size() && std::isspace(static_cast<unsigned char>(query[j]))) {
            ++j;
        }
        if (j + 1 < query.size() && query[j] == '=' && query[j + 1] == '=') {
            j += 2;
        }
        else if (j < query.size() && query[j] == '=') {
            ++j;
        }
        else {
            continue;
        }
        while (j < query.size() && std::isspace(static_cast<unsigned char>(query[j]))) {
            ++j;
        }
        if (j >= query.size() || (query[j] != '"' && query[j] != '\'')) {
            continue;
        }

        auto const literalQuote = query[j++];
        std::string literal;
        bool literalEscaped = false;
        while (j < query.size()) {
            auto const literalChar = query[j++];
            if (literalEscaped) {
                literal.push_back(literalChar);
                literalEscaped = false;
                continue;
            }
            if (literalChar == '\\') {
                literalEscaped = true;
                continue;
            }
            if (literalChar == literalQuote) {
                literals.insert(literal);
                break;
            }
            literal.push_back(literalChar);
        }
    }
    return literals;
}

/** Collects every attribute context that can be styled or searched through schema metadata. */
std::vector<AttributeScopeInfo> collectAttributeScopes(std::map<std::string, mapget::DataSourceInfo> const& infos)
{
    std::vector<AttributeScopeInfo> scopes;
    for (auto const& [_, dataSource] : infos) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->schemaRegistry();
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
std::vector<FeatureSchemaInfo> collectFeatureSchemaScopes(std::map<std::string, mapget::DataSourceInfo> const& infos)
{
    std::vector<FeatureSchemaInfo> scopes;
    for (auto const& [_, dataSource] : infos) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->schemaRegistry();
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

struct QueryScopeAnalysis
{
    std::vector<AttributeScopeInfo> attributeScopes;
    std::set<std::string> seenScopeKeys;
    bool hasFeatureOwnedPath = false;
    bool hasUnknownOwnedPath = false;
    bool hasDynamicOrBroadAccess = false;
};

std::string attributeScopeKey(AttributeScopeInfo const& scope)
{
    return scope.mapId + "\n" + scope.layerId + "\n" + scope.featureType + "\n"
        + scope.attrLayerName + "\n" + scope.attrName;
}

void addAnalyzedAttributeScope(
    QueryScopeAnalysis& analysis,
    std::vector<AttributeScopeInfo> const& allScopes,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    mapget::SchemaRegistry::AttributePathOwner const& owner)
{
    for (auto const& scope : allScopes) {
        if (scope.registry == registry
            && scope.featureType == owner.featureType_
            && scope.attrLayerName == owner.attributeLayerName_
            && scope.attrName == owner.attributeName_) {
            auto key = attributeScopeKey(scope);
            if (analysis.seenScopeKeys.insert(key).second) {
                analysis.attributeScopes.push_back(scope);
            }
        }
    }
}

std::optional<std::vector<std::string>> schemaPathFieldNames(
    simfil::Environment& env,
    simfil::SchemaPath const& path)
{
    std::vector<std::string> fieldNames;
    for (auto const& segment : path) {
        if (segment.kind != simfil::SchemaPathSegment::Kind::Field) {
            continue;
        }
        auto fieldName = env.strings()->resolve(segment.field);
        if (!fieldName) {
            return std::nullopt;
        }
        fieldNames.emplace_back(*fieldName);
    }
    return fieldNames;
}

constexpr simfil::SchemaId kAttributeSearchRootSchema = simfil::MaxSchemaId;

std::shared_ptr<simfil::ObjectSchema> makeAttributeSearchRootSchema(
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    std::shared_ptr<simfil::StringPool> const& strings,
    simfil::SchemaId attributeSchema,
    simfil::SchemaId featureSchema)
{
    auto root = std::make_shared<simfil::ObjectSchema>();
    for (auto const& fieldName : registry->directFields(attributeSchema)) {
        auto fieldId = strings->emplace(fieldName);
        if (!fieldId) {
            continue;
        }

        auto childSchema = registry->childSchema(attributeSchema, fieldName);
        if (childSchema == simfil::NoSchemaId) {
            root->addField(*fieldId);
        }
        else {
            root->addField(*fieldId, {childSchema});
        }
    }

    root->addField(mapget::StringPool::OverlayNameStr);
    root->addField(mapget::StringPool::OverlayLayerStr);
    root->addField(mapget::StringPool::OverlayValidityIndexStr);
    root->addField(mapget::StringPool::OverlayValidityCountStr);
    if (featureSchema == simfil::NoSchemaId) {
        root->addField(mapget::StringPool::OverlayFeatureStr);
    }
    else {
        root->addField(mapget::StringPool::OverlayFeatureStr, {featureSchema});
    }
    return root;
}

void installAttributeSearchRootSchema(
    simfil::Environment& env,
    std::shared_ptr<simfil::ObjectSchema> schema)
{
    auto registrySchemaLookup = std::move(env.querySchemaCallback);
    env.querySchemaCallback = [
        registrySchemaLookup = std::move(registrySchemaLookup),
        schema = std::move(schema)
    ](simfil::SchemaId schemaId) -> const simfil::Schema* {
        if (schemaId == kAttributeSearchRootSchema) {
            return schema.get();
        }
        return registrySchemaLookup ? registrySchemaLookup(schemaId) : nullptr;
    };
}

struct FeatureScopeAstDebug
{
    std::string ast;
    std::vector<AttributeScopeInfo> attributeScopes;
};

/** Compile a query against one feature root and keep the referenced attribute paths. */
tl::expected<FeatureScopeAstDebug, simfil::Error> compileFeatureScopeQueryAstDebug(
    FeatureSchemaInfo const& featureScope,
    std::string const& query)
{
    auto strings = std::make_shared<mapget::StringPool>("SearchScopeAnalysis");
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, featureScope.registry, strings);
    auto ast = simfil::compile(*env, query, simfil::CompileOptions{
        .any = false,
        .autoWildcard = true,
        .rootSchema = featureScope.featureSchema});
    if (!ast) {
        return tl::unexpected(ast.error());
    }

    FeatureScopeAstDebug result;
    result.ast = (*ast)->expr().toString();
    auto references = simfil::referencedSchemaPaths(*env, **ast, featureScope.featureSchema);
    if (!references) {
        return result;
    }

    std::set<std::string> seen;
    for (auto const& reference : references->paths) {
        auto fieldNames = schemaPathFieldNames(*env, reference.path);
        if (!fieldNames) {
            continue;
        }
        auto owner = featureScope.registry->ownerForPath(
            featureScope.featureType,
            featureScope.featureSchema,
            *fieldNames);
        if (owner.kind_ != mapget::SchemaRegistry::PathOwnerKind::Attribute) {
            continue;
        }

        AttributeScopeInfo scope{
            owner.attribute_.attributeName_,
            owner.attribute_.attributeLayerName_,
            owner.attribute_.featureType_,
            featureScope.mapId,
            featureScope.layerId,
            featureScope.registry,
            owner.attribute_.attributeSchema_,
            featureScope.featureSchema};
        auto key = attributeScopeKey(scope);
        if (seen.insert(key).second) {
            result.attributeScopes.push_back(std::move(scope));
        }
    }
    return result;
}

/** Compile a query against one synthetic attribute root exactly as scope inference does. */
tl::expected<simfil::ASTPtr, simfil::Error> compileAttributeScopeQueryAst(
    AttributeScopeInfo const& scope,
    std::string const& query)
{
    auto strings = std::make_shared<mapget::StringPool>("SearchScopeAnalysis");
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, scope.registry, strings);
    installAttributeSearchRootSchema(
        *env,
        makeAttributeSearchRootSchema(scope.registry, strings, scope.attributeSchema, scope.featureSchema));
    return simfil::compile(*env, query, simfil::CompileOptions{
        .any = false,
        .autoWildcard = true,
        .rootSchema = kAttributeSearchRootSchema});
}

/** Format the source context for a schema-AST diagnostics line. */
std::string schemaAstContext(AttributeScopeInfo const& scope)
{
    return scope.mapId + "/" + scope.layerId + "/" + scope.featureType
        + "." + scope.attrLayerName + "." + scope.attrName;
}

/** Format the source context for a feature-root schema-AST diagnostics line. */
std::string schemaAstContext(FeatureSchemaInfo const& scope)
{
    return scope.mapId + "/" + scope.layerId + "/" + scope.featureType;
}

/** Append one deduplicated AST diagnostics message in the same shape as simfil diagnostics. */
void addSchemaAstDiagnostic(
    JsValue& result,
    std::set<std::string>& seenMessages,
    std::string const& query,
    std::string const& label,
    std::string const& ast)
{
    constexpr uint32_t kMaxSchemaAstMessages = 8;
    auto message = label + ": " + ast;
    if (result.size() >= kMaxSchemaAstMessages || !seenMessages.insert(message).second) {
        return;
    }

    result.push(JsValue::Dict({
        {"query", JsValue(query)},
        {"message", JsValue(std::move(message))},
        {"location", JsValue::Dict({
            {"offset", JsValue(0)},
            {"size", JsValue(static_cast<int>(query.size()))},
        })},
        {"fix", JsValue()},
    }));
}

void analyzeFeatureRootQuery(
    QueryScopeAnalysis& analysis,
    std::vector<AttributeScopeInfo> const& allAttributeScopes,
    FeatureSchemaInfo const& featureScope,
    std::string const& query)
{
    auto strings = std::make_shared<mapget::StringPool>("SearchScopeAnalysis");
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, featureScope.registry, strings);

    auto ast = simfil::compile(*env, query, simfil::CompileOptions{
        .any = false,
        .autoWildcard = true,
        .rootSchema = featureScope.featureSchema});
    if (!ast) {
        return;
    }

    auto references = simfil::referencedSchemaPaths(*env, **ast, featureScope.featureSchema);
    if (!references) {
        return;
    }
    analysis.hasDynamicOrBroadAccess = analysis.hasDynamicOrBroadAccess
        || references->hasDynamicAccess
        || references->hasBroadWildcardAccess;

    for (auto const& reference : references->paths) {
        auto fieldNames = schemaPathFieldNames(*env, reference.path);
        if (!fieldNames) {
            analysis.hasUnknownOwnedPath = true;
            continue;
        }
        if (!fieldNames->empty() && fieldNames->front().starts_with("$")) {
            // Attribute-root overlay fields are handled by the attribute-root pass.
            continue;
        }
        auto owner = featureScope.registry->ownerForPath(
            featureScope.featureType,
            featureScope.featureSchema,
            *fieldNames);
        switch (owner.kind_) {
        case mapget::SchemaRegistry::PathOwnerKind::Attribute:
            addAnalyzedAttributeScope(analysis, allAttributeScopes, featureScope.registry, owner.attribute_);
            break;
        case mapget::SchemaRegistry::PathOwnerKind::Feature:
            analysis.hasFeatureOwnedPath = true;
            break;
        case mapget::SchemaRegistry::PathOwnerKind::Unknown:
            analysis.hasUnknownOwnedPath = true;
            break;
        }
    }
}

void analyzeAttributeRootQuery(
    QueryScopeAnalysis& analysis,
    AttributeScopeInfo const& scope,
    std::string const& query)
{
    auto strings = std::make_shared<mapget::StringPool>("SearchScopeAnalysis");
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, scope.registry, strings);
    installAttributeSearchRootSchema(
        *env,
        makeAttributeSearchRootSchema(scope.registry, strings, scope.attributeSchema, scope.featureSchema));

    auto ast = simfil::compile(*env, query, simfil::CompileOptions{
        .any = false,
        .autoWildcard = true,
        .rootSchema = kAttributeSearchRootSchema});
    if (!ast) {
        return;
    }

    auto references = simfil::referencedSchemaPaths(*env, **ast, kAttributeSearchRootSchema);
    if (!references) {
        return;
    }
    if (references->hasDynamicAccess || references->hasBroadWildcardAccess) {
        analysis.hasDynamicOrBroadAccess = true;
        return;
    }
    if (references->hasUnresolvedAccess) {
        return;
    }

    bool matchedAttributeField = false;
    for (auto const& reference : references->paths) {
        auto fieldNames = schemaPathFieldNames(*env, reference.path);
        if (!fieldNames || fieldNames->empty()) {
            analysis.hasUnknownOwnedPath = true;
            continue;
        }
        if (fieldNames->front() == "$feature") {
            analysis.hasFeatureOwnedPath = true;
            continue;
        }
        if (fieldNames->front().starts_with("$")) {
            matchedAttributeField = true;
            continue;
        }
        matchedAttributeField = true;
    }

    if (matchedAttributeField) {
        mapget::SchemaRegistry::AttributePathOwner owner;
        owner.featureType_ = scope.featureType;
        owner.attributeLayerName_ = scope.attrLayerName;
        owner.attributeName_ = scope.attrName;
        owner.attributeSchema_ = scope.attributeSchema;
        addAnalyzedAttributeScope(analysis, {scope}, scope.registry, owner);
    }
}

std::vector<AttributeScopeInfo> filterScopesByAttributeLiterals(
    std::vector<AttributeScopeInfo> scopes,
    std::string const& query)
{
    auto const attributeNameLiterals = positiveStringLiteralsForIdentifier(query, "$name");
    auto const attributeLayerLiterals = positiveStringLiteralsForIdentifier(query, "$layer");
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

/** Resolves the exact attribute contexts implied by schema-referenced query paths. */
std::vector<AttributeScopeInfo> resolveAttributeScopesForQuery(
    std::map<std::string, mapget::DataSourceInfo> const& infos,
    std::string const& query)
{
    auto const allAttributeScopes = collectAttributeScopes(infos);
    if (allAttributeScopes.empty() || query.empty()) {
        return {};
    }

    QueryScopeAnalysis analysis;
    for (auto const& featureScope : collectFeatureSchemaScopes(infos)) {
        analyzeFeatureRootQuery(analysis, allAttributeScopes, featureScope, query);
    }
    for (auto const& attributeScope : allAttributeScopes) {
        analyzeAttributeRootQuery(analysis, attributeScope, query);
    }

    if (analysis.hasFeatureOwnedPath || analysis.hasUnknownOwnedPath || analysis.hasDynamicOrBroadAccess) {
        return {};
    }

    return filterScopesByAttributeLiterals(std::move(analysis.attributeScopes), query);
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

/** Recursively enumerates nested schema paths that mapget can return through `withFields`. */
void collectSchemaFieldPaths(
    std::vector<std::string>& paths,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    simfil::SchemaId schemaId,
    std::string const& basePath,
    int depth)
{
    if (!registry || schemaId == simfil::NoSchemaId || depth <= 0) {
        return;
    }

    for (auto const& field : registry->directFields(schemaId)) {
        auto const path = appendFieldPathSegment(basePath, field);
        paths.push_back(path);
        auto const childSchema = registry->childSchema(schemaId, field);
        if (childSchema != simfil::NoSchemaId && registry->kind(childSchema) == simfil::Schema::Kind::Object) {
            collectSchemaFieldPaths(paths, registry, childSchema, path, depth - 1);
        }
    }
}

/** Adds one search-style field candidate while preserving map/layer/attribute context. */
void addSearchStyleField(
    std::vector<SearchStyleFieldInfo>& fields,
    std::set<std::string>& seen,
    std::string const& path,
    std::string const& mapId,
    std::string const& layerId,
    std::string const& attrName,
    std::string const& featureType)
{
    if (path.empty()) {
        return;
    }
    auto const key = mapId + "\n" + layerId + "\n" + attrName + "\n" + featureType + "\n" + path;
    if (!seen.insert(key).second) {
        return;
    }
    fields.push_back({path, mapId, layerId, attrName, featureType});
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

/** Converts native search-style field candidates into the embind JS value shape. */
NativeJsValue searchStyleFieldsToJs(std::vector<SearchStyleFieldInfo> const& fields)
{
    auto result = JsValue::List();
    for (auto const& field : fields) {
        result.push(JsValue::Dict({
            {"path", JsValue(field.path)},
            {"mapId", JsValue(field.mapId)},
            {"layerId", JsValue(field.layerId)},
            {"attrName", field.attrName.empty() ? JsValue::Undefined() : JsValue(field.attrName)},
            {"featureType", field.featureType.empty() ? JsValue::Undefined() : JsValue(field.featureType)}
        }));
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
    for (auto const& [nodeId, highestFieldId] : offsets)
        result.set(nodeId, JsValue(highestFieldId));
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
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
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
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
    return result;
}

TileSearchResultLayer TileLayerParser::readTileSearchResultLayer(SharedUint8Array const& buffer)
{
    auto result = TileSearchResultLayer(std::make_shared<mapget::TileSearchResultLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
    return result;
}

TileLayerParser::TileLayerMetadata TileLayerParser::readTileLayerMetadata(const SharedUint8Array& buffer)
{
    // Parse just the TileLayer part of the blob, which is the base class of
    // e.g. the TileFeatureLayer. The base class blob always precedes the
    // blob from the derived class.
    size_t bytesRead = 0;
    TileLayer tileLayer(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        &bytesRead
    );
    int32_t numFeatures = -1;
    uint32_t stage = 0;
    auto layerInfo = tileLayer.info();
    auto const& bytes = buffer.bytes();
    if (tileLayer.layerInfo() &&
        tileLayer.layerInfo()->type_ == LayerType::Features &&
        tileLayer.layerInfo()->stages_ > 1 &&
        bytesRead < bytes.size())
    {
        // TileFeatureLayer serializes stage as std::optional<uint32_t>:
        // one byte "hasValue" marker, followed by 4-byte little-endian value.
        // Staged layers always set stage, but keep a safe fallback to zero.
        const auto hasSerializedStage = bytes[bytesRead];
        if (hasSerializedStage == 1U && bytesRead + 1 + sizeof(uint32_t) <= bytes.size()) {
            const auto stageOffset = bytesRead + 1;
            stage =
                static_cast<uint32_t>(bytes[stageOffset]) |
                (static_cast<uint32_t>(bytes[stageOffset + 1]) << 8U) |
                (static_cast<uint32_t>(bytes[stageOffset + 2]) << 16U) |
                (static_cast<uint32_t>(bytes[stageOffset + 3]) << 24U);
        }
    }
    auto allScalarFields = JsValue::Dict();
    if (layerInfo.is_object()) {
        numFeatures = layerInfo.value<int32_t>("Size/Features#features", -1);
        for (auto const& [k, v] : layerInfo.items()) {
            if (v.is_number()) {
                allScalarFields.set(k, JsValue(v.get<double>()));
            }
        }
    }
    return {
        tileLayer.id().toString(),
        tileLayer.nodeId(),
        tileLayer.id().mapId_,
        tileLayer.id().layerId_,
        tileLayer.tileId().value_,
        stage,
        tileLayer.legalInfo() ? *tileLayer.legalInfo() : "",
        tileLayer.error() ? *tileLayer.error() : "",
        numFeatures,
        *allScalarFields
    };
}

void TileLayerParser::setFallbackLayerInfo(std::shared_ptr<mapget::LayerInfo> info) {
    fallbackLayerInfo_ = std::move(info);
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

void TileLayerParser::getFieldDict(SharedUint8Array& out, std::string const& nodeId)
{
    auto fieldDict = cachedStrings_->getStringPool(nodeId);
    std::ostringstream outStream;
    fieldDict->write(outStream, 0);
    out.writeToArray(outStream.str());
}

void TileLayerParser::addFieldDict(const SharedUint8Array& buffer)
{
    size_t bytesRead;
    auto nodeId = mapget::StringPool::readDataSourceNodeId(buffer.bytes(), 0, &bytesRead);
    auto fieldDict = cachedStrings_->getStringPool(nodeId);
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

    std::set<simfil::CompletionCandidate> mergedCandidates;
    for (auto const& [_, dataSource] : info_) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            std::shared_ptr<mapget::SchemaRegistry const> registry = layerInfo->schemaRegistry();
            if (!registry) {
                continue;
            }

            for (auto const& featureType : layerInfo->featureTypes_) {
                auto const featureSchema = registry->featureSchema(featureType.name_);
                if (includeFeatureScope && featureSchema != simfil::NoSchemaId) {
                    auto strings = std::make_shared<mapget::StringPool>("SearchCompletion");
                    auto model = std::make_shared<simfil::ModelPool>(strings);
                    auto root = makeSchemaCompletionNode(model, registry, featureSchema, kSchemaCompletionDepth);
                    addCompletionCandidates(mergedCandidates, registry, strings, query, point, *root, opts);
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

                        auto strings = std::make_shared<mapget::StringPool>("SearchCompletion");
                        auto model = std::make_shared<simfil::ModelPool>(strings);
                        auto attributeRoot = model->newObject();
                        (void)attributeRoot->setSchema(attributeSchema);
                        for (auto const& fieldName : registry->directFields(attributeSchema)) {
                            auto childSchema = registry->childSchema(attributeSchema, fieldName);
                            auto child = makeSchemaCompletionNode(model, registry, childSchema, kSchemaCompletionDepth - 1);
                            (void)attributeRoot->addField(fieldName, child);
                        }
                        addAttributeOverlayFields(attributeRoot, model, registry, featureType.name_);
                        addCompletionCandidates(mergedCandidates, registry, strings, query, point, *attributeRoot, opts);
                    }
                }
            }
        }
    }

    return completionCandidatesToJs(query, mergedCandidates, opts.limit);
}

bool TileLayerParser::isAttributeScopeSearchQuery(std::string const& query) const
{
    return !resolveAttributeScopesForQuery(info_, query).empty();
}

/** Returns schema contexts that can evaluate an attribute-scope search query. */
NativeJsValue TileLayerParser::getAttributeScopeForQuery(std::string const& query) const
{
    return attributeScopesToJs(resolveAttributeScopesForQuery(info_, query));
}

/** Returns schema-AST diagnostics generated by the same parser passes that infer search scope. */
NativeJsValue TileLayerParser::searchQueryAstDiagnostics(std::string const& query, std::string const& scope) const
{
    auto result = JsValue::List();
    if (query.empty()) {
        return *result;
    }

    auto const discoveredAttributeScopes = resolveAttributeScopesForQuery(info_, query);
    std::set<std::string> discoveredAttributeScopeKeys;
    for (auto const& attrScope : discoveredAttributeScopes) {
        discoveredAttributeScopeKeys.insert(attributeScopeKey(attrScope));
    }

    std::set<std::string> seenMessages;
    auto const concreteScope = scope == "auto"
        ? (!discoveredAttributeScopes.empty() ? "attribute" : "feature")
        : scope;

    for (auto const& featureScope : collectFeatureSchemaScopes(info_)) {
        auto astDebug = compileFeatureScopeQueryAstDebug(featureScope, query);
        if (!astDebug) {
            continue;
        }

        if (concreteScope == "feature" || discoveredAttributeScopes.empty()) {
            addSchemaAstDiagnostic(
                result,
                seenMessages,
                query,
                "Schema AST for feature scope " + schemaAstContext(featureScope),
                astDebug->ast);
            continue;
        }

        for (auto const& attrScope : astDebug->attributeScopes) {
            if (!discoveredAttributeScopeKeys.contains(attributeScopeKey(attrScope))) {
                continue;
            }
            addSchemaAstDiagnostic(
                result,
                seenMessages,
                query,
                "Auto-scope schema AST via " + schemaAstContext(attrScope),
                astDebug->ast);
        }
    }

    if (concreteScope == "attribute") {
        auto const allScopes = collectAttributeScopes(info_);
        auto const& scopes = discoveredAttributeScopes.empty() ? allScopes : discoveredAttributeScopes;
        for (auto const& attrScope : scopes) {
            auto ast = compileAttributeScopeQueryAst(attrScope, query);
            if (!ast) {
                continue;
            }
            addSchemaAstDiagnostic(
                result,
                seenMessages,
                query,
                "Schema AST for attribute scope " + schemaAstContext(attrScope),
                (*ast)->expr().toString());
        }
    }

    return *result;
}

/** Enumerates result fields available to search-result style rules for the requested scope. */
NativeJsValue TileLayerParser::searchStyleFieldsForQuery(std::string const& query, std::string const& scope) const
{
    auto const discoveredAttributeScopes = resolveAttributeScopesForQuery(info_, query);
    auto const concreteScope = scope == "auto"
        ? (!discoveredAttributeScopes.empty() ? "attribute" : "feature")
        : scope;

    std::vector<SearchStyleFieldInfo> fields;
    std::set<std::string> seen;
    constexpr int kSearchStyleFieldDepth = 5;

    if (concreteScope == "attribute") {
        // Attribute-scope rules can style both the matched attribute value and
        // selected feature-level fields through the `$feature` overlay.
        auto const allScopes = collectAttributeScopes(info_);
        auto const& scopes = discoveredAttributeScopes.empty() ? allScopes : discoveredAttributeScopes;
        for (auto const& attrScope : scopes) {
            std::vector<std::string> paths;
            collectSchemaFieldPaths(
                paths,
                attrScope.registry,
                attrScope.attributeSchema,
                "",
                kSearchStyleFieldDepth);
            for (auto const& path : paths) {
                addSearchStyleField(
                    fields,
                    seen,
                    path,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.featureType);
            }

            for (auto const& overlayField : {"$name", "$layer", "$validityIndex", "$validityCount"}) {
                addSearchStyleField(
                    fields,
                    seen,
                    overlayField,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.featureType);
            }

            addSearchStyleField(
                fields,
                seen,
                "$feature",
                attrScope.mapId,
                attrScope.layerId,
                attrScope.attrName,
                attrScope.featureType);
            std::vector<std::string> featurePaths;
            collectSchemaFieldPaths(
                featurePaths,
                attrScope.registry,
                attrScope.featureSchema,
                "$feature",
                kSearchStyleFieldDepth);
            for (auto const& path : featurePaths) {
                addSearchStyleField(
                    fields,
                    seen,
                    path,
                    attrScope.mapId,
                    attrScope.layerId,
                    attrScope.attrName,
                    attrScope.featureType);
            }
        }
    }
    else {
        // Feature-scope style fields come directly from each advertised feature schema.
        for (auto const& [_, dataSource] : info_) {
            for (auto const& [__, layerInfo] : dataSource.layers_) {
                if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                    continue;
                }
                auto registry = layerInfo->schemaRegistry();
                if (!registry) {
                    continue;
                }
                for (auto const& featureType : layerInfo->featureTypes_) {
                    std::vector<std::string> paths;
                    collectSchemaFieldPaths(
                        paths,
                        registry,
                        registry->featureSchema(featureType.name_),
                        "",
                        kSearchStyleFieldDepth);
                    for (auto const& path : paths) {
                        addSearchStyleField(
                            fields,
                            seen,
                            path,
                            dataSource.mapId_,
                            layerInfo->layerId_,
                            "",
                            featureType.name_);
                    }
                }
            }
        }
    }

    std::ranges::sort(fields, [](auto const& lhs, auto const& rhs) {
        return std::tie(lhs.path, lhs.mapId, lhs.layerId, lhs.attrName, lhs.featureType)
            < std::tie(rhs.path, rhs.mapId, rhs.layerId, rhs.attrName, rhs.featureType);
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
