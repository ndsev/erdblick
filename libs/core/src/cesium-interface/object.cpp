#include "cesium-interface/object.h"

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

JsValue JsValue::Float64Array(const std::vector<double>& coordinates)
{
#ifdef EMSCRIPTEN
    static thread_local auto JsFloat64ArrayType = emscripten::val::global("Float64Array");
    // Create a typed memory view directly pointing to the vector's data
    auto memoryView = emscripten::typed_memory_view(coordinates.size(), coordinates.data());
    // Create a Float64Array from the memory view
    auto float64Array = JsFloat64ArrayType.new_(memoryView);
    return JsValue(float64Array);
#else
    return JsValue(coordinates);
#endif
}

JsValue JsValue::operator[](std::string const& propertyName)
{
#ifdef EMSCRIPTEN
    return JsValue(value_[propertyName]);
#else
    if(!value_.contains(propertyName))
    {
        value_["properties"][propertyName] = {};
    }
    return JsValue(value_["properties"][propertyName]);
#endif
}

void JsValue::push(const JsValue& o)
{
#ifdef EMSCRIPTEN
    value_.call<void>("push", o.value_);
#else
    value_.push_back(o.value_);
#endif
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
