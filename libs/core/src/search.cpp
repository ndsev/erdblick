#include "search.h"
#include "geometry.h"
#include "cesium-interface/point-conversion.h"

erdblick::FeatureLayerSearch::FeatureLayerSearch(TileFeatureLayer& tfl) : tfl_(tfl)
{}

erdblick::NativeJsValue erdblick::FeatureLayerSearch::filter(const std::string& q)
{
    auto results = JsValue::List();
    auto mapTileKey = tfl_.id();

    for (const auto& feature : *tfl_.model_) {
        auto evalResult = tfl_.model_->evaluate(anyWrap(q), *feature);
        if (evalResult.empty())
            continue;
        auto& firstEvalResult = evalResult[0];
        if (!firstEvalResult.as<simfil::ValueType::Bool>())
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

