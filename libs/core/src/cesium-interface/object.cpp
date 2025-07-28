#include "cesium-interface/object.h"

#if !defined(EMSCRIPTEN)
    #include <stdexcept>
#endif


namespace erdblick
{

JsValue::JsValue()
#ifdef EMSCRIPTEN
    : value_(emscripten::val::null())
#else
    : value_({})
#endif
{}

JsValue JsValue::fromGlobal(std::string const& globalName)
{
#ifdef EMSCRIPTEN
    return JsValue(emscripten::val::global(globalName.c_str()));
#else
    return JsValue(nlohmann::json{{"globalName", globalName}});
#endif
}

JsValue JsValue::Dict(std::initializer_list<std::pair<std::string, JsValue>> initializers)
{
#ifdef EMSCRIPTEN
    auto obj = emscripten::val::object();
    for (const auto& pair : initializers) {
        obj.set(pair.first, pair.second.value_);
    }
    return JsValue(obj);
#else
    nlohmann::json jsonDict;
    for (const auto& pair : initializers) {
        jsonDict[pair.first] = pair.second.value_;
    }
    return JsValue(jsonDict);
#endif
}

JsValue JsValue::List(std::initializer_list<JsValue> initializers)
{
#ifdef EMSCRIPTEN
    emscripten::val array = emscripten::val::array();
    int index = 0;
    for (const auto& item : initializers) {
        array.set(index++, item.value_);
    }
    return JsValue(array);
#else
    nlohmann::json jsonArray = nlohmann::json::array();
    for (const auto& item : initializers) {
        jsonArray.push_back(item.value_);
    }
    return JsValue(jsonArray);
#endif
}

JsValue JsValue::Float64Array(const std::span<double>& data)
{
#ifdef EMSCRIPTEN
    static thread_local const auto type = emscripten::val::global("Float64Array");

    auto buffer = type.new_(data.size());
    buffer.call<void>("set", emscripten::typed_memory_view(data.size(), data.data()));

    return JsValue(buffer);
#else
    return JsValue(data);
#endif
}

JsValue JsValue::Uint8Array(const std::span<std::uint8_t>& data)
{
#ifdef EMSCRIPTEN
    static thread_local const auto type = emscripten::val::global("Uint8Array");

    auto buffer = type.new_(data.size());
    buffer.call<void>("set", emscripten::typed_memory_view(data.size(), data.data()));

    return JsValue(buffer);
#else
    return JsValue(base64::encode(data));
#endif
}

JsValue JsValue::Undefined()
{
#ifdef EMSCRIPTEN
    return JsValue(emscripten::val::undefined());
#else
    return JsValue("<undefined>");
#endif
}

JsValue JsValue::operator[](std::string const& propertyName)
{
#ifdef EMSCRIPTEN
    return JsValue(value_[propertyName]);
#else
    if (!value_.contains(propertyName)) {
        value_["properties"][propertyName] = {};
    }
    return JsValue(value_["properties"][propertyName]);
#endif
}

JsValue JsValue::operator[](std::string const& propertyName) const
{
#ifdef EMSCRIPTEN
    return JsValue(value_[propertyName]);
#else
    if (value_.contains(propertyName))
        return JsValue(value_["properties"][propertyName]);
    return JsValue();
#endif
}

bool JsValue::has(std::string const& propertyName) const
{
#ifdef EMSCRIPTEN
    return value_.hasOwnProperty(propertyName.c_str());
#else
    return value_.contains(propertyName);
#endif
}

JsValue JsValue::at(uint32_t index) const
{
    return JsValue(value_[index]);
}

void JsValue::push(const JsValue& o)
{
#ifdef EMSCRIPTEN
    value_.call<void>("push", o.value_);
#else
    value_.push_back(o.value_);
#endif
}

void JsValue::set(const std::string& key, const JsValue& value)
{
#ifdef EMSCRIPTEN
    value_.set(key, *value);
#else
    value_[key] = *value;
#endif
}

uint32_t JsValue::size() const {
#ifdef EMSCRIPTEN
    return value_["length"].as<uint32_t>();
#else
    return value_.size();
#endif
}

std::vector<std::uint8_t> JsValue::toUint8Array() const
{
#ifdef EMSCRIPTEN
    return emscripten::convertJSArrayToNumberVector<std::uint8_t>(value_);
#else
    const auto len = size();
    std::vector<std::uint8_t> vec(len);

    if (value_.is_string()) {
        return base64::decode(value_.get<std::string>());
    } else if (value_.is_array()) {
        for (const auto& element : value_) {
            if (!element.is_number_unsigned()) {
                throw std::range_error("Expected unsigned value");
            }

            auto value = element.get<std::uint64_t>();
            if (value > 0xff) {
                throw std::range_error("Expected value <= 0xff");
            }

            elements.push_back(static_cast<std::uint8_t>(value));
        }
    }

    return vec;
#endif
}

std::string JsValue::toString() const {
    switch(type()) {
        case Type::Null:
            return "Null";
        case Type::Bool:
            return fmt::format("{}", as<bool>());
        case Type::Number:
            return fmt::format("{}", as<double>());
        case Type::String:
            return fmt::format("{}", as<std::string>());
        case Type::ObjectOrList:
            return "Object";
        default:
            return "Undefined";
    }
}

JsValue::Type JsValue::type() const
{
#ifdef EMSCRIPTEN
    std::string typeStr = value_.typeOf().as<std::string>(); // Convert emscripten::val to std::string
    if (typeStr == "undefined") return Type::Undefined;
    else if (typeStr == "object") return Type::ObjectOrList;
    else if (typeStr == "boolean") return Type::Bool;
    else if (typeStr == "number" || typeStr == "bigint") return Type::Number;
    else if (typeStr == "string") return Type::String;
    else return Type::Undefined; // Default case
#else
    if (value_.is_null()) return Type::Null;
    else if (value_.is_boolean()) return Type::Bool;
    else if (value_.is_number()) return Type::Number;
    else if (value_.is_string()) return Type::String;
    else if (value_.is_array() || value_.is_object()) return Type::ObjectOrList;
    else return Type::Undefined; // Catch-all for any types not covered
#endif
}

mapget::KeyValuePairs JsValue::toKeyValuePairs() const
{
    auto numFeatureIdParts = size();
    mapget::KeyValuePairs result;
    for (auto kvIndex = 0; kvIndex < numFeatureIdParts; kvIndex += 2) {
        auto key = at(kvIndex).as<std::string>();
        auto value = at(kvIndex + 1);
        if (value.type() == JsValue::Type::Number) {
            result.emplace_back(key, value.as<int64_t>());
        }
        else if (value.type() == JsValue::Type::String) {
            result.emplace_back(key, value.as<std::string>());
        }
    }
    return result;
}

CesiumClass::CesiumClass(const std::string& className)
    : className_(className)
{
    static thread_local auto cesiumLibrary = JsValue::fromGlobal("Cesium");
    value_ = cesiumLibrary.value_[className];
}

JsValue CesiumClass::New(std::initializer_list<std::pair<std::string, JsValue>> kwArgs) const
{
    return New(*JsValue::Dict(kwArgs));
}

} // namespace erdblick
