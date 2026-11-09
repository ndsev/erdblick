#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string_view>
#include <unordered_map>
#include "interop/js-object.h"
#include "mapget/model/feature.h"
#include "sfl/small_vector.hpp"
#include "simfil/model/string-pool.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/incoming-relations.h"

namespace erdblick
{

/**
 * Converts mapget feature model nodes into the tree-shaped inspection model
 * consumed by the frontend.
 *
 * The converter keeps transient state while traversing one feature, including
 * translated field names, relation bookkeeping, and enough tile context to
 * produce hover ids and source-data links that the UI can round-trip later.
 * Use a fresh converter for each convert/convertIncoming call: neither clears
 * the tree or caches. Model nodes and cached string storage must remain alive
 * throughout conversion; the returned JS/JSON tree contains copied presentation data.
 */
class InspectionConverter
{
public:
    /** Describes how the frontend should interpret a rendered inspection value. */
    enum class ValueType: uint8_t {
        Null = 0,
        Number = 1,
        String = 2,
        Boolean = 3,
        FeatureId = 4,
        Section = 5,
        ArrayBit = 128,
    };

    /**
     * Node in the exported inspection tree.
     *
     * The structure mirrors the JS representation. toJsValue() recursively exports
     * children and summary bubbles; it does not return a view into this C++ tree.
     */
    struct InspectionNode
    {
        JsValue key_;
        JsValue value_;

        /** Display labels/units are separate from the scalar payload projection, which
         * uses decimal strings for large integers and text for bytes/bitmasks. */
        std::string displayValue_;
        std::optional<JsValue> scalarType_;
        std::optional<JsValue> mapId_;

        /** Foreign references keep named, typed ID parts until target-map resolution. */
        std::optional<JsValue> featureReference_;
        ValueType type_ = ValueType::Null;
        std::string hoverId_;  // For highlight attribs/relations on hovering.
        std::string info_;
        std::deque<InspectionNode> children_;
        JsValue direction_;
        std::string geoJsonPath_;
        std::string nodeId_;

        /** Source owner for incoming relation rows, independent of the selected target. */
        std::string mapTileKey_;
        std::optional<JsValue> address_;
        bool addressScope_ = false;
        std::string schemaType_;

        /** Populates a fresh scalar node and type decorations; returns false for compound values. */
        bool setScalarValue(simfil::Value const& value);

        /** Source-data backlink attached to an inspection node. */
        struct SourceDataReference {
            mapget::PartitionId partitionId_;
            uint64_t address_;
            std::string layerId_;
            std::string qualifier_;
        };
        sfl::small_vector<SourceDataReference, 1> sourceDataRefs_; // Most nodes have a single source-data reference.

        /** Clickable scalar summary shown in a parent node's value column. */
        struct ValueBubble {
            std::string label_;
            std::string targetNodeId_;
            std::string hoverTargetNodeId_;
            std::string kind_;
            std::string colorKey_;
            std::deque<ValueBubble> children_;
        };
        std::deque<ValueBubble> valueBubbles_;

        /** Compact metadata badge shown next to the node key. */
        struct KeyBubble {
            std::string label_;
            std::string kind_;
        };
        std::deque<KeyBubble> keyBubbles_;

        /** Materialize this node and its metadata as a JS object for the UI. */
        [[nodiscard]] JsValue toJsValue(std::string_view const& mapId) const;

        /** Convert only the child array when the parent object already exists. */
        [[nodiscard]] JsValue childrenToJsValue(std::string_view const& mapId) const;
    };

    /**
     * Preserves existing row IDs, assigns missing IDs from child positions/keys,
     * and rebuilds propagated summaries. IDs can change when children are reordered.
     *
     * Feature and source-data inspection both call this after constructing
     * their tree so summary semantics cannot drift between the two views.
     */
    static void finalizeTree(InspectionNode& root);

    /** Renders incoming rows using their source models, grouping adjacent entries with the same source identity. */
    JsValue convertIncoming(mapget::FeatureInspectionView const& view);

    /**
     * RAII helper that temporarily pushes a child node onto the converter stack.
     *
     * This keeps deeply nested conversion code readable and guarantees that the
     * stack is restored even when a branch exits early. Guards must be destroyed
     * in LIFO order and before their converter; moving a guard transfers its pop.
     */
    struct InspectionNodeScope
    {
        /** Access the currently scoped node. */
        InspectionNode& operator* () const;

        /** Access the currently scoped node pointer-style. */
        InspectionNode* operator-> () const;

        /** Restore the previous conversion scope on destruction. */
        ~InspectionNodeScope();

        /** Scopes are move-only so one push can only be popped once. */
        InspectionNodeScope(InspectionNodeScope const&) = delete;

        /** Transfer ownership of the scoped push to another guard. */
        InspectionNodeScope(InspectionNodeScope&&) noexcept;

        /** Adopt a node that was just pushed by the converter. */
        InspectionNodeScope(InspectionNode* n, InspectionConverter* c);

        InspectionNode* node_ = nullptr;
        InspectionConverter* converter_ = nullptr;
    };

    /** Marker for a pre-rendered GeoJSON path segment that should not be escaped again. */
    struct RawPath {
        std::string_view value_;
    };

    /** Marker for a complete pre-rendered search path that must not inherit the parent path. */
    struct AbsolutePath {
        std::string_view value_;
    };
    using FieldOrIndex = std::variant<uint32_t, std::string_view, RawPath, AbsolutePath>;

    /** Converts a non-null feature on a fresh converter, including identifiers, attributes, relations and geometry. */
    JsValue convert(mapget::model_ptr<mapget::Feature> const& featurePtr);

    /** Push an already prepared node onto the conversion stack. */
    InspectionNodeScope push(InspectionNode* node);

    /** Create and push a child node addressed by a field/index path. */
    InspectionNodeScope push(std::string_view const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);

    /** Create and push a child node with a pre-built JS key value. */
    InspectionNodeScope push(JsValue const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);

    /** Pop the current node from the conversion stack. */
    void pop();

    /** Convert one attribute layer while sharing the feature-wide attribute index used in hover ids. */
    void convertAttributeLayer(
        std::string_view const& name,
        mapget::model_ptr<mapget::AttributeLayer> const& l,
        size_t& attributeIndex);

    /** Pick the canonical relation index used by relation hover ids. */
    uint32_t relationIndexFor(mapget::model_ptr<mapget::Relation> const& r);

    /** Convert one relation row/reference through the same representation everywhere it appears. */
    void convertRelation(
        JsValue const& key,
        FieldOrIndex const& path,
        mapget::model_ptr<mapget::Relation> const& r,
        uint32_t relationIndex,
        std::optional<std::string> targetGeoJsonPath = std::nullopt);

    /** Convert one relation and attach hover metadata if applicable. */
    void convertRelation(mapget::model_ptr<mapget::Relation> const& r);

    /** Converts geometry metadata/coordinates; Points share the preview budget, while other geometries remain complete. */
    void convertGeometry(
        JsValue const& key,
        mapget::model_ptr<mapget::Geometry> const& r,
        std::optional<std::string_view> geometryObjectPath = std::nullopt);

    /** Convert a validity collection and optionally namespace the emitted hover ids. */
    void convertValidity(
        JsValue const& key,
        mapget::model_ptr<mapget::MultiValidity> const& r,
        std::string const* hoverIdPrefix = nullptr);

    /**
     * Expand an interwoven attribute-point validity into source indices and
     * resolved position details while keeping synthetic fields out of search paths.
     */
    void convertAttrPointValidity(
        JsValue const& key,
        mapget::model_ptr<mapget::AttrPointSequence> const& sequence,
        uint32_t start,
        std::optional<uint32_t> end = std::nullopt);

    /** Convert a field value while resolving the field id through the current string pool. */
    void convertField(simfil::StringId const& fieldId, simfil::ModelNode::Ptr const& value);

    /** Convert a named field value into its inspection representation. */
    void convertField(std::string_view const& fieldName, simfil::ModelNode::Ptr const& value);

    /** Convert a field using an already translated key. */
    void convertField(JsValue const& fieldName, simfil::ModelNode::Ptr const& value);

    /** Convert a field using independent display and path metadata. */
    void convertField(
        JsValue const& fieldName,
        FieldOrIndex const& path,
        simfil::ModelNode::Ptr const& value,
        simfil::SchemaType type = {});

    /**
     * Store one referenced feature id as inspection node payload.
     *
     * Detached feature references may point into another map, so the clickable
     * inspection metadata must preserve the referenced map id instead of
     * implicitly inheriting the current feature's tile map.
     */
    void assignFeatureReference(InspectionNode& node, mapget::model_ptr<mapget::FeatureId> const& featureId);

    /** Intern or reuse a field/value string through the converter's JS string cache. */
    JsValue convertString(const simfil::StringId& f);

    /** Caches a copied JS string under a borrowed key; f's storage must outlive all cache lookups. */
    JsValue convertString(const std::string_view& f);

    /** Uses the same borrowed-key cache; the source string must remain alive and unchanged. */
    JsValue convertString(const std::string& f);

    /** Uses the same borrowed-key cache; s must be non-null and its storage must remain alive. */
    JsValue convertString(const char* s);

    std::string featureId_;

    /** Shared across all point geometries in one selected feature. */
    size_t remainingPointPreview_ = 256;
    uint32_t nextRelationIndex_ = 0;

    /** Tracks one relation-name group and the next local index copied as `select(group, n)`. */
    struct RelationTypeState {
        InspectionNode* node_ = nullptr;
        uint32_t nextLocalIndex_ = 0;
    };
    InspectionNode root_;
    std::vector<InspectionNode*> stack_ = {&root_};
    InspectionNode* current_ = &root_;
    std::shared_ptr<simfil::StringPool> stringPool_;
    std::unordered_map<std::string_view, JsValue> translatedFieldNames_;
    std::unordered_map<std::string_view, RelationTypeState> relationsByType_;
    mapget::TileFeatureLayer* tile_ = nullptr;
};

}  // namespace erdblick

/** Combine `ValueType` flags when a node should be marked as an array of values. */
erdblick::InspectionConverter::ValueType
operator|(erdblick::InspectionConverter::ValueType a, erdblick::InspectionConverter::ValueType b);
