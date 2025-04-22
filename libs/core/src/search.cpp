#include "search.h"
#include <algorithm>
#include "cesium-interface/object.h"
#include "geometry.h"
#include "cesium-interface/point-conversion.h"
#include "simfil/environment.h"

erdblick::FeatureLayerSearch::FeatureLayerSearch(TileFeatureLayer& tfl) : tfl_(tfl)
{}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::filter(const std::string& q)
{
    auto obj = JsValue::Dict();

    auto results = JsValue::List();

    simfil::Diagnostics mergedDiagnostics;
    std::map<std::string, simfil::Trace> mergedTraces;

    auto mapTileKey = tfl_.id();
    for (const auto& feature : *tfl_.model_) {
        auto [evalResult, evalTraces, evalDiagnostics] = tfl_.model_->evaluate(q, *feature, true);

        /* Merge traces */
        for (auto&& [key, trace] : evalTraces) {
            mergedTraces[key].append(std::move(trace));
        }

        /* Merge diagnostics */
        mergedDiagnostics.append(evalDiagnostics);

        if (evalResult.empty())
            continue;

        auto& firstEvalResult = evalResult[0];
        if (!firstEvalResult.template as<simfil::ValueType::Bool>())
            continue;

        auto jsResultForFeature = JsValue::List();
        jsResultForFeature.push(JsValue(mapTileKey));
        jsResultForFeature.push(JsValue(feature->id()->toString()));
        auto geometryCenterPoint = geometryCenter(feature->firstGeometry());
        jsResultForFeature.push(JsValue::Dict({
            {"cartesian", JsValue(wgsToCartesian<mapget::Point>(geometryCenterPoint))},
            {"cartographic", JsValue(geometryCenterPoint)}
        }));
        results.push(jsResultForFeature);
    }

    obj.set("result", results);

    auto diagnostics = JsValue::List();
    for (const auto& msg : tfl_.model_->collectQueryDiagnostics(q, mergedDiagnostics)) {
        auto fixValue = JsValue::Undefined();
        if (msg.fix)
            fixValue = JsValue(*msg.fix);

        diagnostics.push(JsValue::Dict({
            {"message", JsValue(msg.message)},
            {"fix", fixValue},
        }));
    }
    obj.set("diagnostics", diagnostics);

    auto traces = JsValue::Dict();
    for (const auto& [key, trace] : mergedTraces) {
        auto values = JsValue::List();
        values.set("length", JsValue(trace.values.size()));
        for (const auto& v : trace.values) {
            values.push(JsValue(v.toString()));
        }

        traces.set(key, JsValue::Dict({
            {"calls", JsValue(trace.calls)},
            {"totalus", JsValue(trace.totalus.count())},
            {"values", std::move(values)}
        }));
    }
    obj.set("traces", traces);

    return *obj;
}

std::string erdblick::anyWrap(const std::string_view& q)
{
    return fmt::format("any({})", q);
}

