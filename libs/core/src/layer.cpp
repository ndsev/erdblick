#include "layer.h"

#include "mapget/model/feature.h"
#include <iostream>

namespace erdblick
{

/**
 * Constructor accepting a shared pointer to the original `TileFeatureLayer` class.
 * @param self Shared pointer to `mapget::TileFeatureLayer`.
 */
TileFeatureLayer::TileFeatureLayer(std::shared_ptr<mapget::TileFeatureLayer> self)
    : model_(std::move(self)) {}

/**
 * Retrieves the ID of the tile feature layer as a string.
 * @return The ID string.
 */
std::string TileFeatureLayer::id() const
{
    return model_->id().toString();
}

/**
 * Retrieves the tile ID as a 64-bit unsigned integer.
 * @return The tile ID.
 */
uint64_t TileFeatureLayer::tileId() const
{
    return model_->tileId().value_;
}

/**
 * Gets the number of features in the tile.
 * @return The number of features.
 */
uint32_t TileFeatureLayer::numFeatures() const
{
    return model_->numRoots();
}

/**
 * Retrieves the center point of the tile, including the zoom level as the Z coordinate.
 * @return The center point of the tile.
 */
mapget::Point TileFeatureLayer::center() const
{
    auto result = model_->tileId().center();
    result.z = model_->tileId().z();
    return result;
}

/**
 * Retrieves the legal information / copyright of the tile feature layer as a string.
 * @return The legal information string.
 */
std::string TileFeatureLayer::legalInfo() const
{
    return model_->legalInfo() ? *model_->legalInfo() : "";
}

/**
 * Finds a feature within the tile by its ID.
 * @param id The ID of the feature to find.
 * @return A pointer to the found feature, or `nullptr` if not found.
 */
mapget::model_ptr<mapget::Feature> TileFeatureLayer::find(const std::string& id) const
{
    return model_->find(id);
}

/**
 * Finds the index of a feature based on its type and ID parts.
 * @param type The type of the feature.
 * @param idParts The parts of the feature's ID.
 * @return The index of the feature, or `-1` if not found.
 */
int32_t TileFeatureLayer::findFeatureIndex(std::string type, NativeJsValue idParts) const
{
    auto idPartsKvp = JsValue(idParts).toKeyValuePairs();
    if (auto result = model_->find(type, idPartsKvp))
        return result->addr().index();
    return -1;
}

TileFeatureLayer::~TileFeatureLayer() = default;

/**
 * Constructor accepting a shared pointer to the original `TileSourceDataLayer` class.
 * @param self Shared pointer to `mapget::TileSourceDataLayer`.
 */
TileSourceDataLayer::TileSourceDataLayer(std::shared_ptr<mapget::TileSourceDataLayer> self)
    : model_(std::move(self)) {}

/**
 * Retrieves the source data address format of the layer.
 * @return The address format.
 */
mapget::TileSourceDataLayer::SourceDataAddressFormat TileSourceDataLayer::addressFormat() const
{
    return model_->sourceDataAddressFormat();
}

/**
 * Converts the layer's data to a JSON string with indentation.
 * @return The JSON representation of the layer.
 */
std::string TileSourceDataLayer::toJson() const
{
    return model_->toJson().dump(2);
}

/**
 * Converts the `SourceDataLayer` hierarchy to a tree model compatible structure.
 *
 * **Layout:**
 * ```json
 * [
 *   {
 *     "data": {"key": "...", "value": ...},
 *     "children": [{ ... }]
 *   },
 *   ...
 * ]
 * ```
 * @return A `NativeJsValue` representing the hierarchical data structure.
 */
NativeJsValue TileSourceDataLayer::toObject() const
{
    using namespace erdblick;
    using namespace mapget;
    using namespace simfil;

    const auto& strings = *model_->strings();

    std::function<JsValue(JsValue&&, const simfil::ModelNode&)> visit;

    // Function to handle atomic (non-complex) nodes
    auto visitAtomic = [&](JsValue&& key, const simfil::ModelNode& node) {
        auto value = [&node]() -> JsValue {
            switch (node.type()) {
            case simfil::ValueType::Null:
                return JsValue();
            case simfil::ValueType::Bool:
                return JsValue(std::get<bool>(node.value()));
            case simfil::ValueType::Int:
                return JsValue(std::get<int64_t>(node.value()));
            case simfil::ValueType::Float:
                return JsValue(std::get<double>(node.value()));
            case simfil::ValueType::String: {
                auto v = node.value();
                if (auto vv = std::get_if<std::string>(&v))
                    return JsValue(*vv);
                if (auto vv = std::get_if<std::string_view>(&v))
                    return JsValue(std::string(*vv));
            }
            default:
                return JsValue();
            }
        }();

        auto res = JsValue::Dict();
        auto data = JsValue::Dict();
        data.set("key", std::move(key));
        data.set("value", std::move(value));
        res.set("data", std::move(data));

        return res;
    };

    // Function to handle array nodes
    auto visitArray = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));
        res.set("data", std::move(data));

        auto children = JsValue::List();
        int i = 0;
        for (const auto& item : node) {
            children.call<void>("push", visit(JsValue(i++), *item));
        }

        if (i > 0)
            res.set("children", std::move(children));

        return res;
    };

    // Function to handle source data addresses
    auto visitAddress = [&](const SourceDataAddress& addr) {
        if (model_->sourceDataAddressFormat() == mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange) {
            auto res = JsValue::Dict();
            res.set("offset", JsValue(addr.bitOffset()));
            res.set("size", JsValue(addr.bitSize()));
            return res;
        } else {
            return JsValue(addr.u64());
        }
    };

    // Function to handle object nodes
    auto visitObject = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));

        if (node.addr().column() == mapget::TileSourceDataLayer::Compound) {
            auto compound = model_->resolveCompound(*ModelNode::Ptr::make(model_->shared_from_this(), node.addr()));

            data.set("address", visitAddress(compound->sourceDataAddress()));
            data.set("type", JsValue(std::string(compound->schemaName())));
        }

        res.set("data", std::move(data));

        auto children = JsValue::List();
        for (const auto& [field, v] : node.fields()) {
            if (auto k = strings.resolve(field); k && v) {
                children.call<void>("push", visit(JsValue(k->data()), *v));
            }
        }

        if (node.size() > 0)
            res.set("children", std::move(children));

        return res;
    };

    // Main recursive visit function
    visit = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        switch (node.type()) {
        case simfil::ValueType::Array:
            return visitArray(std::move(key), node);
        case simfil::ValueType::Object:
            return visitObject(std::move(key), node);
        default:
            return visitAtomic(std::move(key), node);
        }
    };

    if (model_->numRoots() == 0)
        return *JsValue::Dict();

    return *visit(JsValue("root"), *model_->root(0));
}

std::string TileSourceDataLayer::getError() const
{
    return model_->error() ? *model_->error() : "";
}

} // namespace erdblick
