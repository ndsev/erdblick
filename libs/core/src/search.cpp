#include "search.h"

#include "cesium-interface/object.h"
#include "cesium-interface/point-conversion.h"
#include "geometry.h"
#include "simfil/diagnostics.h"
#include "simfil/environment.h"

#include <algorithm>
#include <istream>
#include <iterator>
#include <set>
#include <sstream>
#include <streambuf>

namespace
{

struct Uint8StreamBuffer : public std::streambuf {
    Uint8StreamBuffer(std::vector<std::uint8_t>& buf) {
        auto begin = reinterpret_cast<char*>(buf.data());
        setg(begin, begin, begin + buf.size());
    }
};

}

erdblick::FeatureLayerSearch::FeatureLayerSearch(TileFeatureLayer& tfl) : tfl_(tfl)
{}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::filter(const std::string& q)
{
    auto obj = JsValue::Dict();

    auto results = JsValue::List();

    simfil::Diagnostics mergedDiagnostics;
    std::map<std::string, simfil::Trace> mergedTraces;
    std::string errorMessage;

    auto mapTileKey = tfl_.id();
    for (const auto& feature : *tfl_.model_) {
        auto res = tfl_.model_->evaluate(q, *feature, true);
        if (!res) {
            errorMessage = std::move(res.error().message);
            break;
        }

        auto [evalResult, evalTraces, evalDiagnostics] = std::move(*res);

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

    if (!errorMessage.empty()) {
        return JsValue::Dict({{"error", JsValue(errorMessage)}}).value_;
    }

    obj.set("result", results);

    std::stringstream stream;
    mergedDiagnostics.write(stream);

    std::vector<std::uint8_t> diagnosticsBuffer(
        std::istreambuf_iterator<char>{stream},
        std::istreambuf_iterator<char>{});

    auto diagnostics = JsValue::Uint8Array(diagnosticsBuffer);
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

    return obj.value_;
}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::complete(std::string const& q, int point, NativeJsValue const& options_)
{
    JsValue options(options_);

    point = std::max<int>(0, std::min<int>(point, q.size()));

    size_t limit = 0;
    if (options.has("limit")) {
        limit = std::max<int>(0, options["limit"].as<int>());
    }

    size_t timeoutMs = 0;
    if (options.has("timeoutMs")) {
        timeoutMs = std::max<int>(0, options["timeoutMs"].as<int>());
    }

    simfil::CompletionOptions opts;
    opts.limit = limit;
    opts.timeoutMs = timeoutMs;

    std::string errorMessage;
    std::set<simfil::CompletionCandidate> joinedResult;
    for (const auto& feature : *tfl_.model_) {
        auto result = tfl_.model_->complete(q, point, *feature, opts);
        if (!result) {
            errorMessage = std::move(result.error().message);
            break;
        }

        joinedResult.insert(result->begin(), result->end());
    }

    auto obj = JsValue::List();
    if (!errorMessage.empty()) {
        return JsValue::Dict({
            {"error", JsValue(errorMessage)}
        }).value_;
    }

    for (const auto& item : joinedResult) {
        auto text = item.text;
        if (item.type == simfil::CompletionCandidate::Type::FUNCTION)
            text += "(";

        auto query = q;
        query.replace(item.location.offset, item.location.size, text);

        const auto type =
            item.type == simfil::CompletionCandidate::Type::CONSTANT ? "Constant" :
            item.type == simfil::CompletionCandidate::Type::FIELD ? "Field" :
            item.type == simfil::CompletionCandidate::Type::FUNCTION ? "Function" :
            item.type == simfil::CompletionCandidate::Type::HINT ? "Hint" :
            "";

        //const auto hint = item.hint.empty() ? JsValue::Undefined() : JsValue(item.hint);
        const auto hint = JsValue::Undefined(); // TODO: Update simfils function information first.

        auto candidate = JsValue::Dict({
            {"text", JsValue(item.text)},
            {"range", JsValue::List({
                JsValue((int)item.location.offset), JsValue((int)item.location.size)
            })},
            {"query", JsValue(query)},
            {"type", JsValue(type)},
            {"hint", std::move(hint)},
        });

        obj.push(std::move(candidate));
    }
    return obj.value_;
}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::diagnostics(std::string const& q, NativeJsValue const& ndiagnostics)
{
    auto diagnostics = JsValue(ndiagnostics);
    simfil::Diagnostics merged;

    const auto length = diagnostics["length"].as<std::size_t>();
    for (auto i = 0; i < length; ++i) {
        auto buffer = diagnostics.at(i).toUint8Array();

        Uint8StreamBuffer streamBuffer(buffer);
        std::istream stream(&streamBuffer);

        simfil::Diagnostics item;
        if (!item.read(stream)) {
            return JsValue::Dict({
                {"error", JsValue("Read error")},
            }).value_;
        } else {
            merged.append(item);
        }
    }

    auto messages = tfl_.model_->collectQueryDiagnostics(q, merged);
    if (!messages) {
        return JsValue::Dict({
            {"error", JsValue(messages.error().message)}
        }).value_;
    }

    auto result = JsValue::List();
    for (const auto& msg : *messages) {
        auto fixValue = JsValue::Undefined();
        if (msg.fix)
            fixValue = JsValue(*msg.fix);

        auto location = JsValue::Dict({
            {"offset", JsValue(msg.location.offset)},
            {"size", JsValue(msg.location.size)},
        });

        result.push(JsValue::Dict({
            {"query", JsValue(q)},
            {"message", JsValue(msg.message)},
            {"location", location},
            {"fix", fixValue},
        }));
    }

    return result.value_;
}

std::string erdblick::anyWrap(const std::string_view& q)
{
    return fmt::format("any({})", q);
}

