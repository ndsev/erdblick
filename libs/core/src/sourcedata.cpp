#include "sourcedata.hpp"

#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/sourcedata.h"

/**
 * Convert a SourceDataLayar hierarchy to a tree model compatible
 * structure.
 *
 * Layout:
 *   [{ data: [{key: "...", value: ...}, ...], children: [{ ... }] }, ...]
 *
 **/
emscripten::val tileSourceDataLayerToObject(const mapget::TileSourceDataLayer& layer) {
    namespace em = emscripten;
    using namespace mapget;
    using namespace simfil;

    const auto& strings = *layer.strings();

    std::function<em::val(em::val&&, const simfil::ModelNode&)> visit;
    auto visitAtomic = [&](em::val&& key, const simfil::ModelNode& node) {
        auto value = [&node]() -> em::val {
            switch (node.type()) {
            case simfil::ValueType::Null:
                return em::val::null();
            case simfil::ValueType::Bool:
                return em::val(std::get<bool>(node.value()));
            case simfil::ValueType::Int:
                return em::val(std::get<int64_t>(node.value()));
            case simfil::ValueType::Float:
                return em::val(std::get<double>(node.value()));
            case simfil::ValueType::String: {
                auto v = node.value();
                if (auto vv = std::get_if<std::string>(&v))
                    return em::val(*vv);
                if (auto vv = std::get_if<std::string_view>(&v))
                    return em::val(std::string(*vv));
            }
            default:
                return em::val::null();
            }
        }();

        auto res = em::val::object();
        auto data = em::val::object();
        data.set("key", std::move(key));
        data.set("value", std::move(value));
        res.set("data", std::move(data));

        return res;
    };

    auto visitArray = [&](em::val&& key, const simfil::ModelNode& node) -> em::val {
        auto res = em::val::object();

        auto data = em::val::object();
        data.set("key", std::move(key));
        res.set("data", std::move(data));

        auto children = em::val::array();
        auto i = 0;
        for (const auto& item : node) {
            children.call<void>("push", visit(em::val(i++), *item));
        }

        if (i > 0)
            res.set("children", std::move(children));

        return res;
    };

    auto visitAddress = [&](const SourceDataAddress& addr) {
        if (layer.sourceDataAddressFormat() == mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange) {
            auto res = em::val::object();
            res.set("offset", addr.bitOffset());
            res.set("size", addr.bitSize());

            return res;
        } else {
            return em::val(addr.u64());
        }
    };

    auto visitObject = [&](em::val&& key, const simfil::ModelNode& node) -> em::val {
        auto res = em::val::object();

        auto data = em::val::object();
        data.set("key", std::move(key));

        if (node.addr().column() == mapget::TileSourceDataLayer::Compound) {
            auto compound = layer.resolveCompound(*ModelNode::Ptr::make(layer.shared_from_this(), node.addr()));

            data.set("address", visitAddress(compound->sourceDataAddress()));
            data.set("type", std::string(compound->schemaName()));
        }

        res.set("data", std::move(data));

        auto children = em::val::array();
        for (const auto& [field, v] : node.fields()) {
            if (auto k = strings.resolve(field); k && v) {
                children.call<void>("push", visit(em::val(k->data()), *v));
            }
        }

        if (node.size() > 0)
            res.set("children", std::move(children));

        return res;
    };

    visit = [&](em::val&& key, const simfil::ModelNode& node) -> em::val {
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
        return em::val::object();

    return visit(em::val("root"), *layer.root(0));
}
