#include "sourcedata.hpp"

#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/sourcedata.h"

namespace erdblick
{

erdblick::JsValue tileSourceDataLayerToObject(const mapget::TileSourceDataLayer& layer) {
    using namespace erdblick;
    using namespace mapget;
    using namespace simfil;

    const auto& strings = *layer.strings();

    std::function<JsValue(JsValue&&, const simfil::ModelNode&)> visit;
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

    auto visitArray = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));
        res.set("data", std::move(data));

        auto children = JsValue::List();
        auto i = 0;
        for (const auto& item : node) {
            children.call<void>("push", visit(JsValue(i++), *item));
        }

        if (i > 0)
            res.set("children", std::move(children));

        return res;
    };

    auto visitAddress = [&](const SourceDataAddress& addr) {
        if (layer.sourceDataAddressFormat() == mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange) {
            auto res = JsValue::Dict();
            res.set("offset", JsValue(addr.bitOffset()));
            res.set("size", JsValue(addr.bitSize()));

            return res;
        } else {
            return JsValue(addr.u64());
        }
    };

    auto visitObject = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));

        if (node.addr().column() == mapget::TileSourceDataLayer::Compound) {
            auto compound = layer.resolveCompound(*ModelNode::Ptr::make(layer.shared_from_this(), node.addr()));

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

    if (layer.numRoots() == 0)
        return JsValue::Dict();

    return visit(JsValue("root"), *layer.root(0));
}

}
