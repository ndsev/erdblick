#include "search.h"
#include "geometry.h"
#include "cesium-interface/point-conversion.h"

erdblick::FeatureLayerSearch::FeatureLayerSearch(mapget::TileFeatureLayer& tfl) : tfl_(tfl)
{}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::filter(const std::string& q)
{
    auto const& expr = tfl_.compiledExpression(anyWrap(q));
    auto results = JsValue::List();
    auto mapTileKey = tfl_.id().toString();

    for (auto feature : tfl_) {
        auto evalResult = simfil::eval(
            tfl_.evaluationEnvironment(),
            *expr,
            *feature);
        if (evalResult.empty())
            continue;
        auto& firstEvalResult = evalResult[0];
        if (!firstEvalResult.as<simfil::ValueType::Bool>())
            continue;
        auto jsResultForFeature = JsValue::List();
        jsResultForFeature.push(JsValue(mapTileKey));
        jsResultForFeature.push(JsValue(feature->id()->toString()));
        jsResultForFeature.push(JsValue(
            wgsToCartesian<mapget::Point>(geometryCenter(feature->firstGeometry()))
        ));
        results.push(jsResultForFeature);
    }

    return *results;
}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::traceResults()
{
    // TODO: Implement
    return {};
}

std::string erdblick::anyWrap(const std::string_view& q)
{
    return fmt::format("any({})", q);
}
