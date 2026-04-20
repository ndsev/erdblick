#pragma once

#include <cstdint>
#include <deque>
#include <unordered_map>
#include "interop/js-object.h"
#include "mapget/model/feature.h"
#include "sfl/small_vector.hpp"
#include "simfil/model/string-pool.h"
#include "mapget/model/featurelayer.h"

namespace erdblick
{

/**
 * Converts mapget feature model nodes into the tree-shaped inspection model
 * consumed by the frontend.
 *
 * The converter keeps transient state while traversing one feature, including
 * translated field names, relation bookkeeping, and enough tile context to
 * produce hover ids and source-data links that the UI can round-trip later.
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
     * The structure is intentionally close to the JS representation so the final
     * `toJsValue()` conversion stays shallow and predictable.
     */
    struct InspectionNode
    {
        JsValue key_;
        JsValue value_;
        std::optional<JsValue> mapId_;
        ValueType type_ = ValueType::Null;
        std::string hoverId_;  // For highlight attribs/relations on hovering.
        std::string info_;
        std::deque<InspectionNode> children_;
        JsValue direction_;
        std::string geoJsonPath_;

        /** Source-data backlink attached to an inspection node. */
        struct SourceDataReference {
            uint64_t tileId_;
            uint64_t address_;
            std::string layerId_;
            std::string qualifier_;
        };
        sfl::small_vector<SourceDataReference, 1> sourceDataRefs_; // Most nodes have a single source-data reference.

        /** Materialize this node and its metadata as a JS object for the UI. */
        [[nodiscard]] JsValue toJsValue(std::string_view const& mapId) const;
        /** Convert only the child array when the parent object already exists. */
        [[nodiscard]] JsValue childrenToJsValue(std::string_view const& mapId) const;
    };

    /**
     * RAII helper that temporarily pushes a child node onto the converter stack.
     *
     * This keeps deeply nested conversion code readable and guarantees that the
     * stack is restored even when a branch exits early.
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

    using OptionalValueAndType = std::optional<std::pair<JsValue, ValueType>>;
    /** Marker for a pre-rendered GeoJSON path segment that should not be escaped again. */
    struct RawPath {
        std::string_view value_;
    };
    using FieldOrIndex = std::variant<uint32_t, std::string_view, RawPath>;

    /** Convert a feature, including identifiers, attributes, relations, and geometry. */
    JsValue convert(mapget::model_ptr<mapget::Feature> const& featurePtr);

    /** Push an already prepared node onto the conversion stack. */
    InspectionNodeScope push(InspectionNode* node);
    /** Create and push a child node addressed by a field/index path. */
    InspectionNodeScope push(std::string_view const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);
    /** Create and push a child node with a pre-built JS key value. */
    InspectionNodeScope push(JsValue const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);
    /** Pop the current node from the conversion stack. */
    void pop();

    /** Convert one attribute layer into child inspection nodes. */
    void convertAttributeLayer(std::string_view const& name, mapget::model_ptr<mapget::AttributeLayer> const& l);
    /** Convert one relation and attach hover metadata if applicable. */
    void convertRelation(mapget::model_ptr<mapget::Relation> const& r);
    /** Convert one geometry node, including stage/name metadata and points. */
    void convertGeometry(JsValue const& key, mapget::model_ptr<mapget::Geometry> const& r);
    /** Convert a validity collection and optionally namespace the emitted hover ids. */
    void convertValidity(
        JsValue const& key,
        mapget::model_ptr<mapget::MultiValidity> const& r,
        std::string const* hoverIdPrefix = nullptr);

    /** Convert a field value while resolving the field id through the current string pool. */
    OptionalValueAndType convertField(simfil::StringId const& fieldId, simfil::ModelNode::Ptr const& value);
    /** Convert a named field value into its inspection representation. */
    OptionalValueAndType convertField(std::string_view const& fieldName, simfil::ModelNode::Ptr const& value);
    /** Convert a field using an already translated key. */
    OptionalValueAndType convertField(JsValue const& fieldName, simfil::ModelNode::Ptr const& value);

    /** Intern or reuse a field/value string through the converter's JS string cache. */
    JsValue convertString(const simfil::StringId& f);
    /** Intern or reuse a string_view through the converter's JS string cache. */
    JsValue convertString(const std::string_view& f);
    /** Intern or reuse a std::string through the converter's JS string cache. */
    JsValue convertString(const std::string& f);
    /** Intern or reuse a C-string through the converter's JS string cache. */
    JsValue convertString(const char* s);

    std::string featureId_;
    uint32_t nextRelationIndex_ = 0;
    InspectionNode root_;
    std::vector<InspectionNode*> stack_ = {&root_};
    InspectionNode* current_ = &root_;
    std::shared_ptr<simfil::StringPool> stringPool_;
    std::unordered_map<std::string_view, JsValue> translatedFieldNames_;
    std::unordered_map<std::string_view, InspectionNode*> relationsByType_;
    mapget::TileFeatureLayer* tile_ = nullptr;
};

}  // namespace erdblick

/** Combine `ValueType` flags when a node should be marked as an array of values. */
erdblick::InspectionConverter::ValueType
operator|(erdblick::InspectionConverter::ValueType a, erdblick::InspectionConverter::ValueType b);
