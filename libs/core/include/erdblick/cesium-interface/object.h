#pragma once

#include <type_traits>
#include <variant>
#include "mapget/model/info.h"

#ifdef EMSCRIPTEN
#include <emscripten/bind.h>
#else
#include "nlohmann/json.hpp"
#endif

namespace erdblick
{

#ifdef EMSCRIPTEN
using NativeJsValue = emscripten::val;
#else
using NativeJsValue = nlohmann::json;
#endif

template<typename T>
struct always_false : std::false_type {};

/**
 * Class representing an emscripten JavaScript object,
 * or a mock object based on an nlohmann::json value 
 * for debugging or compiling without emscripten support.
 *
 * The mock object has two JSON fields:
 * - `properties` is a dict recording all field accesses.
 * - `methodCalls` is a list containing dicts like {`methodName`: ..., `arguments`: [...]}.
 */
struct JsValue
{
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
     * If EMSCRIPTEN is not defined, simply returns an empty JSON object.
     */
    static JsValue fromGlobal(std::string const& globalName);

    /**
     * Construct an Object as a new JS or JSON dictionary with provided initializers.
     * @param initializers An initializer list of key-value pairs.
     */
    static JsValue Dict(std::initializer_list<std::pair<std::string, JsValue>> initializers = {});

    /**
     * Construct an Object as a new JS or JSON list with provided initializers.
     * @param initializers An initializer list of CesiumObject items.
     */
    static JsValue List(std::initializer_list<JsValue> initializers = {});

    /**
     * Construct an Object as a new JS Float64 TypedArray.
     * @param coordinates Float64 buffer to fill the typed array.
     */
    static JsValue Float64Array(std::vector<double> const& coordinates);

    /**
     * Construct an undefined value.
     */
    static JsValue Undefined();

    /** Construct a JsValue from a variant with specific alternatives. */
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
     * For the mock version, it will add the method call to `methodCalls` and return an empty Object.
     */
    template<typename ReturnType=NativeJsValue, typename... Args>
    ReturnType call(std::string const& methodName, Args... args);

    /**
     * Property access using operator[].
     * Read-access to a non-existing mock property will add the property as an empty object (if non-const).
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
     * For the mock version, it will append the push action to `methodCalls`.
     */
    void push(const JsValue& o);

    /**
     * Get the list length, assuming that this is a list.
     * Returns ["length"] for EMSCRIPTEN, and .size() for
     * the mock version.
     */
    [[nodiscard]] uint32_t size() const;

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

    template <typename T>
    T as() const {
    #ifdef EMSCRIPTEN
        return value_.as<T>();
    #else
        return value_.get<T>();
    #endif
    }

    /**
     * Dereference operator to access the underlying value.
     */
    inline NativeJsValue& operator*() {return value_;};
    inline const NativeJsValue& operator*() const {return value_;};

    /** Turn a [key, value, keyN, valueN, ...] list into KeyValuePairs. */
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

struct CesiumClass : public JsValue
{
public:
    explicit CesiumClass(std::string const& className);

    /**
     * Create a new instance of the represented class using the provided arguments.
     * For EMSCRIPTEN, it utilizes value_.new_(Args...).
     * For the mock version, it will return an empty nlohmann JSON object.
     */
    [[nodiscard]] JsValue New(std::initializer_list<std::pair<std::string, JsValue>> kwArgs = {}) const;
    template<typename... Args>
    JsValue New(Args... args) const;

private:
    std::string className_;
};

template<typename... Args>
JsValue CesiumClass::New(Args... args) const
{
#ifdef EMSCRIPTEN
    auto result = value_.new_(UnpackNativeValue(args)...);
    return JsValue(result);
#else
    return JsValue(nlohmann::json::object({
        {"className", className_},
        {"constructedWith", nlohmann::json::array({UnpackNativeValue(args)...})}
    }));
#endif
}

}
