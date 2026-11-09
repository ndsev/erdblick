#pragma once

#include <type_traits>
#include <variant>
#include "mapget/model/info.h"
#include "simfil/model/schema-type.h"

#ifdef EMSCRIPTEN
#include <emscripten/bind.h>
#else
#include "nlohmann/json.hpp"
#endif

namespace mapget { class FeatureId; }

namespace erdblick
{

#ifdef EMSCRIPTEN
using NativeJsValue = emscripten::val;
#else
using NativeJsValue = nlohmann::json;
#endif

template<typename T>
/** Helper for exhaustive `if constexpr` / `static_assert` branches over variants. */
struct always_false : std::false_type {};

/**
 * Wraps an Emscripten JavaScript value or a native-build JSON stand-in.
 * Native properties are stored directly; call() additionally records invocations
 * in `methodCalls`. Copies share JS object handles but copy native JSON values.
 */
struct JsValue
{
    /** Unwrap nested `JsValue` arguments before forwarding them to JS/native backends. */
    template <class T>
    static auto UnpackNativeValue(T&& v)
    {
        if constexpr (std::is_base_of_v<JsValue, std::decay_t<T>>) {
            return *v;
        } else {
            return std::forward<T>(v);
        }
    }

    /**
     * Construct an Object from a global JavaScript name using em::val::global.
     * Native builds return a JSON object with a `globalName` marker.
     */
    static JsValue fromGlobal(std::string const& globalName);

    /** Convert a tagged native partition without narrowing an object ID. */
    static JsValue fromPartition(mapget::PartitionId const& partition);

    /** Projects one type without its graph; large integers use decimal strings and masks use hex strings. */
    static JsValue fromSchema(simfil::SchemaType const& type);

    /** Preserve a mask's raw uint64 bits and exact schema/type identity at the JS boundary. */
    static JsValue fromBitmask(simfil::Bitmask const& mask);

    /**
     * Carry a named reference without consulting the source tile's schema.
     * Integers outside JavaScript's exact Number range become BigInts so a
     * subsequent target-map locate preserves both their value and their type.
     */
    static JsValue fromFeatureId(mapget::FeatureId const& reference);

    /**
     * Construct an Object as a new JS or JSON dictionary with provided initializers.
     * An empty native dictionary is represented by JSON null until a field is set.
     * @param initializers An initializer list of key-value pairs.
     */
    static JsValue Dict(std::initializer_list<std::pair<std::string, JsValue>> initializers = {});

    /**
     * Construct an Object as a new JS or JSON list with provided initializers.
     * @param initializers An initializer list of JsValue items.
     */
    static JsValue List(std::initializer_list<JsValue> initializers = {});

    /**
     * Copy data into a JS Float32Array, or a plain JSON array in native builds.
     * @param data Float32 buffer to fill the typed array.
     */
    static JsValue Float32Array(std::span<const float> data);

    /**
     * Copy data into a JS Float64Array, or a plain JSON array in native builds.
     * @param coordinates Float64 buffer to fill the typed array.
     */
    static JsValue Float64Array(std::span<const double> data);

    /**
     * Copy data into a JS Uint32Array, or a plain JSON array in native builds.
     * @param data Data to pass to the Uint32Array
     */
    static JsValue Uint32Array(std::span<const std::uint32_t> data);

    /**
     * Copy data into a JS Uint8Array, or a base64 JSON string in native builds.
     * @param data Data to pass to the Uint8Array
     */
    static JsValue Uint8Array(std::span<const std::uint8_t> data);

    /**
     * Construct JS undefined, or the literal string "<undefined>" in native builds.
     */
    static JsValue Undefined();

    /** Converts string/string_view/int64 variants; integers are narrowed to double on both backends. */
    template<typename T>
    static JsValue fromVariant(T const& variant) {
        JsValue result;
        std::visit([&result](auto&& v){
            if constexpr (std::is_same_v<std::decay_t<decltype(v)>, std::string_view>) {
                result = JsValue(std::string(v));
            } else if constexpr (std::is_same_v<std::decay_t<decltype(v)>, std::string>) {
                result = JsValue(v);
            } else if constexpr (std::is_same_v<std::decay_t<decltype(v)>, int64_t>) {
                result = JsValue(static_cast<double>(v));
            } else {
                static_assert(always_false<decltype(v)>::value, "Type of 'v' is not supported.");
            }
        }, variant);
        return result;
    }

    /**
     * Constructs a JavaScript or JSON null value.
     */
    JsValue();

    /**
     * Constructor from any type.
     */
    template <class T>
    explicit JsValue(T const& v) : value_(v) {}

    /**
     * Default assignment/copy implementations.
     */
    JsValue(const JsValue& other) = default;
    JsValue(JsValue&& other) noexcept = default;
    JsValue& operator=(const JsValue& other) = default;
    JsValue& operator=(JsValue&& other) noexcept = default;

    /**
     * Templated method for making arbitrary method calls.
     * For EMSCRIPTEN, it will utilize the value_.call<ReturnType>(Args...) function.
     * The native version records the call in `methodCalls` and default-constructs ReturnType.
     */
    template<typename ReturnType=NativeJsValue, typename... Args>
    ReturnType call(std::string const& methodName, Args... args);

    /**
     * Property access using operator[].
     * A missing native property becomes null on non-const access; const access
     * returns null without inserting it. JS access preserves ordinary JS semantics.
     */
    JsValue operator[](std::string const& propertyName);
    JsValue operator[](std::string const& propertyName) const;

    /**
     * Assuming this is a dict, check if the entry with the given key exists.
     */
    bool has(std::string const& propertyName) const;

    /**
     * Get the value at the specified index, assuming that this
     * is a list. For both EMSCRIPTEN and the mock version,
     * it will return value_[i].
     */
    [[nodiscard]] JsValue at(uint32_t index) const;

    /**
     * Set an object field or dictionary entry to a given value.
     */
    void set(std::string const& key, JsValue const& value);

    /**
     * Append a value, assuming that this value is a JS list.
     * For EMSCRIPTEN, it will use value_.push(o.value_).
     * Native builds append directly to the JSON array.
     */
    void push(const JsValue& o);

    /**
     * Get the list length, assuming that this is a list.
     * Returns ["length"] for EMSCRIPTEN, and .size() for
     * the mock version.
     */
    [[nodiscard]] uint32_t size() const;

    /**
     * Get this value as vector<uint8_t>.
     */
    std::vector<std::uint8_t> toUint8Array() const;

    /**
     * Convert this JsValue to string representation.
     */
    std::string toString() const;

    enum class Type {
        Undefined,
        Null,
        Bool,
        Number,
        String,
        ObjectOrList
    };

    /**
     * Get the type of this value.
     */
    [[nodiscard]] Type type() const;

    /** Convert the wrapped native value into a concrete C++ type. */
    template <typename T>
    T as() const {
    #ifdef EMSCRIPTEN
        return value_.as<T>();
    #else
        return value_.get<T>();
    #endif
    }

    /** Access the wrapped native object for low-level interop code. */
    inline NativeJsValue& operator*() {return value_;};

    /** Access the wrapped native object for low-level interop code. */
    inline const NativeJsValue& operator*() const {return value_;};

    /** Converts an even-length list with string keys; retains string/int64 values and skips other types. */
    [[nodiscard]] mapget::KeyValuePairs toKeyValuePairs() const;

    /**
     * Actual JS or JSON object.
     */
    NativeJsValue value_;
};

template <typename ReturnType, typename... Args>
ReturnType JsValue::call(std::string const& methodName, Args... args)
{
#ifdef EMSCRIPTEN
    return value_.call<ReturnType>(methodName.c_str(), UnpackNativeValue(args)...);
#else
    // Record the method call in the mock object
    value_["methodCalls"].push_back({
        {"methodName", methodName},
        {"arguments", {UnpackNativeValue(args)...}} // This assumes Args are convertible to nlohmann::json
    });
    return ReturnType(); // default-constructed value
#endif
}

}
