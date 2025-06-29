#include "search.h"
#include "cesium-interface/object.h"
#include "geometry.h"
#include "cesium-interface/point-conversion.h"
#include "simfil/environment.h"

#include <algorithm>
#include <set>

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

        auto location = JsValue::Dict({
            {"offset", JsValue(msg.location.begin)},
            {"size", JsValue(msg.location.size)},
        });

        diagnostics.push(JsValue::Dict({
            {"message", JsValue(msg.message)},
            {"location", location},
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

erdblick::NativeJsValue erdblick::FeatureLayerSearch::complete(std::string const& q, int point, emscripten::val const& options)
{
    point = std::max<int>(0, std::min<int>(point, q.size()));

    size_t limit = 0;
    if (options.hasOwnProperty("limit")) {
        limit = std::max<int>(0, options["limit"].as<int>());
    }

    size_t timeoutMs = 0;
    if (options.hasOwnProperty("timeoutMs")) {
        timeoutMs = std::max<int>(0, options["timeoutMs"].as<int>());
    }

    simfil::CompletionOptions opts;
    opts.limit = limit;
    opts.timeoutMs = timeoutMs;
    opts.autoWildcard = true;

    std::set<simfil::CompletionCandidate> joinedResult;
    try {
        for (const auto& feature : *tfl_.model_) {
            auto result = tfl_.model_->complete(q, point, *feature, opts);

            const auto n = std::min<int>(result.size(), limit - joinedResult.size());
            if (n > 0) {
                auto end = result.begin();
                std::advance(end, n);
                joinedResult.insert(result.begin(), end);
            }

            if (limit > 0 && joinedResult.size() >= limit) {
                break;
            }
        }
    } catch (...) {}

    auto obj = JsValue::List();
    for (const auto& item : joinedResult) {
        std::string query = q;
        query.replace(item.location.begin, item.location.size, item.text);

        auto candidate = JsValue::Dict({
            {"text", JsValue(item.text)},
            {"range", JsValue::List({
                JsValue((int)item.location.begin), JsValue((int)item.location.size)
            })},
            {"query", JsValue(query)},
        });

        obj.push(std::move(candidate));
    }
    return *obj;
}

std::string erdblick::anyWrap(const std::string_view& q)
{
    return fmt::format("any({})", q);
}

