#include "interop/js-object.h"
#include <stdexcept>
#include "fmt/core.h"

#if !defined(EMSCRIPTEN)
    #include <stdexcept>
    #include "base64.h"
#endif


namespace erdblick
{

JsValue JsValue::fromBitmask(simfil::Bitmask const& mask)
{
    if (!mask.domain || !mask.domain.definition())
        throw std::invalid_argument("Cannot expose a bitmask without its exact domain");
    return Dict(
        {{"_bitmask", JsValue(true)},
         {"bits", JsValue(fmt::format("0x{:016x}", mask.bits))},
         {"schema", JsValue(std::string(mask.domain.binding->identity()))},
         {"domain", JsValue(mask.domain.id)}});
}

JsValue JsValue::fromSchema(simfil::SchemaReference const& reference)
{
    auto const* domain = reference.definition();
    if (!domain)
        return Undefined();
    auto result = Dict(
        {{"schemaId", JsValue(std::string(reference.binding->identity()))},
         {"domainId", JsValue(reference.id)},
         {"typeName", JsValue(std::string(domain->typeName()))}});
    // Numeric bounds and named literals may exceed JS's exact integer range.
    // Their type remains explicit; decimal strings preserve those raw encodings.
    auto scalar = [](auto const& value)
    {
        return std::visit(
            [](auto const& raw) -> JsValue
            {
                using T = std::decay_t<decltype(raw)>;
                if constexpr (std::is_same_v<T, std::string_view>)
                    return JsValue(std::string(raw));
                else if constexpr (std::is_same_v<T, uint64_t>) {
                    return raw > 9007199254740991ULL ?
                        JsValue(std::to_string(raw)) :
                        JsValue(double(raw));
                }
                else if constexpr (std::is_same_v<T, int64_t>) {
                    return raw < -9007199254740991LL || raw > 9007199254740991LL ?
                        JsValue(std::to_string(raw)) :
                        JsValue(double(raw));
                }
                else
                    return JsValue(raw);
            },
            value);
    };
    if (auto numeric = domain->numericDomain()) {
        auto ranges = List();
        for (auto const& range : numeric->ordinaryRanges)
            ranges.push(Dict({{"min", scalar(range.min)}, {"max", scalar(range.max)}}));
        auto metadata = Dict(
            {{"encoding", JsValue(std::string(numeric->encoding))},
             {"unit", JsValue(std::string(numeric->unit))},
             {"ordinaryRanges", ranges},
             {"scale", JsValue(numeric->scale)},
             {"offset", JsValue(numeric->offset)},
             {"complete", JsValue(numeric->complete)}});
        if (numeric->minimum)
            metadata.set("minimum", scalar(*numeric->minimum));
        if (numeric->maximum)
            metadata.set("maximum", scalar(*numeric->maximum));
        result.set("numeric", metadata);
    }
    auto names = List();
    domain->forEachNamedValue(
        [&](simfil::Schema::NamedValue const& named)
        {
            using Named = simfil::Schema::NamedValue;
            auto valueType = std::visit(
                [](auto const& value) -> std::string
                {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, bool>)
                        return "boolean";
                    if constexpr (std::is_same_v<T, std::string_view>)
                        return "string";
                    if constexpr (std::is_same_v<T, double>)
                        return "number";
                    return "integer";
                },
                named.value);
            auto raw = scalar(named.value);
            if (named.role == Named::Role::Flag) {
                raw = std::visit(
                    [](auto const& value) -> JsValue
                    {
                        using T = std::decay_t<decltype(value)>;
                        if constexpr (std::is_same_v<T, uint64_t> || std::is_same_v<T, int64_t>)
                            return JsValue(fmt::format("0x{:016x}", uint64_t(value)));
                        throw std::invalid_argument("A named flag must have an exact integer mask");
                    },
                    named.value);
            }
            std::string role = named.role == Named::Role::Flag ?
                "flag" :
                named.role == Named::Role::Special ?
                "special" :
                "constant";
            std::string meaning;
            switch (named.meaning) {
            case Named::Meaning::Ordinary: meaning = "ordinary"; break;
            case Named::Meaning::Unknown: meaning = "unknown"; break;
            case Named::Meaning::Variable: meaning = "variable"; break;
            case Named::Meaning::Unbounded: meaning = "unbounded"; break;
            case Named::Meaning::Saturated: meaning = "saturated"; break;
            }
            names.push(Dict(
                {{"name", JsValue(std::string(named.name))},
                 {"value", raw},
                 {"valueType", JsValue(valueType)},
                 {"role", JsValue(role)},
                 {"meaning", JsValue(meaning)},
                 {"deprecated", JsValue(named.deprecated)},
                 {"removed", JsValue(named.removed)}}));
        });
    result.set("namedValues", names);
    if (domain->hasAffinity(simfil::ValueType::Bitmask))
        result.set("bitWidth", JsValue(domain->bitWidth()));
    return result;
}

namespace {

#ifdef EMSCRIPTEN
/** Create a JS typed array and copy the provided span into it. */
template <typename TypedArrayCtor, typename T>
JsValue makeTypedArray(std::span<const T> data)
{
    static thread_local const auto type = emscripten::val::global(TypedArrayCtor::value);
    auto buffer = type.new_(data.size());
    buffer.template call<void>("set", emscripten::typed_memory_view(data.size(), data.data()));
    return JsValue(buffer);
}
#else
/** Native-build fallback that preserves typed-array payloads as plain JSON arrays. */
template <typename T>
JsValue makeTypedArray(std::span<const T> data)
{
    return JsValue(std::vector<T>(data.begin(), data.end()));
}
#endif

#ifdef EMSCRIPTEN
/** Tag type naming the JS constructor used by `makeTypedArray`. */
struct Float32ArrayCtor { static constexpr auto value = "Float32Array"; };
/** Tag type naming the JS constructor used by `makeTypedArray`. */
struct Float64ArrayCtor { static constexpr auto value = "Float64Array"; };
/** Tag type naming the JS constructor used by `makeTypedArray`. */
struct Uint32ArrayCtor { static constexpr auto value = "Uint32Array"; };
/** Tag type naming the JS constructor used by `makeTypedArray`. */
struct Uint8ArrayCtor { static constexpr auto value = "Uint8Array"; };
#endif

}

JsValue::JsValue()
#ifdef EMSCRIPTEN
    : value_(emscripten::val::null())
#else
    : value_(nullptr)
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

JsValue JsValue::fromPartition(mapget::PartitionId const& partition)
{
    if (partition.kind() == mapget::PartitionKind::Object) {
        return Dict({
            {"kind", JsValue("object")},
            {"id", JsValue(partition.toString())},
        });
    }
    return Dict({
        {"kind", JsValue("tile")},
        {"id", JsValue(partition.value())},
    });
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

JsValue JsValue::Float32Array(std::span<const float> data)
{
#ifdef EMSCRIPTEN
    return makeTypedArray<Float32ArrayCtor>(data);
#else
    return makeTypedArray(data);
#endif
}

JsValue JsValue::Float64Array(std::span<const double> data)
{
#ifdef EMSCRIPTEN
    return makeTypedArray<Float64ArrayCtor>(data);
#else
    return makeTypedArray(data);
#endif
}

JsValue JsValue::Uint32Array(std::span<const std::uint32_t> data)
{
#ifdef EMSCRIPTEN
    return makeTypedArray<Uint32ArrayCtor>(data);
#else
    return makeTypedArray(data);
#endif
}

JsValue JsValue::Uint8Array(std::span<const std::uint8_t> data)
{
#ifdef EMSCRIPTEN
    return makeTypedArray<Uint8ArrayCtor>(data);
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
        value_[propertyName] = {};
    }
    return JsValue(value_[propertyName]);
#endif
}

JsValue JsValue::operator[](std::string const& propertyName) const
{
#ifdef EMSCRIPTEN
    return JsValue(value_[propertyName]);
#else
    if (value_.contains(propertyName))
        return JsValue(value_[propertyName]);
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

            vec.push_back(static_cast<std::uint8_t>(value));
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
#ifdef EMSCRIPTEN
            return value_.call<std::string>("toString");
#else
            return fmt::format("{}", as<bool>());
#endif
        case Type::Number:
#ifdef EMSCRIPTEN
            return value_.call<std::string>("toString");
#else
            return fmt::format("{}", as<double>());
#endif
        case Type::String:
#ifdef EMSCRIPTEN
            return value_.call<std::string>("toString");
#else
            return fmt::format("{}", as<std::string>());
#endif
        case Type::ObjectOrList:
            return "Object";
        default:
            return "Undefined";
    }
}

JsValue::Type JsValue::type() const
{
#ifdef EMSCRIPTEN
    if (value_.isUndefined()) return Type::Undefined;
    if (value_.isNull()) return Type::Null;
    std::string typeStr = value_.typeOf().as<std::string>(); // Convert emscripten::val to std::string
    if (typeStr == "object") return Type::ObjectOrList;
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

} // namespace erdblick
