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

JsValue JsValue::newDict(std::initializer_list<std::pair<std::string, JsValue>> initializers)
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

JsValue JsValue::newList(std::initializer_list<JsValue> initializers)
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
    value_["methodCalls"].push_back({{"methodName", "push"}, {"arguments", {o.value_}}});
#endif
}

CesiumClass::CesiumClass(const std::string& className)
    : className_(className)
{
    static thread_local auto cesiumLibrary = JsValue::fromGlobal("Cesium");
    value_ = cesiumLibrary.value_[className];
}

} // namespace erdblick
