#include <emscripten/bind.h>

#include "aabb.h"
#include "buffer.h"
#include "renderer.h"
#include "style.h"
#include "testdataprovider.h"

using namespace erdblick;
namespace em = emscripten;

Wgs84AABB createWgs84AABB(float x, float y, uint32_t softLimit, uint16_t level)
{
    return Wgs84AABB::fromCenterAndTileLimit(Wgs84Point{x, y, 0}, softLimit, level);
}

EMSCRIPTEN_BINDINGS(FeatureLayerRendererBind)
{
    ////////// SharedUint8Array
    em::class_<SharedUint8Array>("SharedUint8Array")
        .constructor()
        .constructor<uint32_t>()
        .function("getSize", &SharedUint8Array::getSize)
        .function("getPointer", &SharedUint8Array::getPointer);

    ////////// FeatureLayerStyle
    em::class_<FeatureLayerStyle>("FeatureLayerStyle").constructor<SharedUint8Array&>();

    ////////// TileFeatureLayer
    em::class_<mapget::TileFeatureLayer>("TileFeatureLayer")
        .smart_ptr<std::shared_ptr<mapget::TileFeatureLayer>>(
            "std::shared_ptr<mapget::TileFeatureLayer>");

    ////////// FeatureLayerRenderer
    em::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
        .constructor()
        .function("render", &FeatureLayerRenderer::render);

    ////////// TestDataProvider
    em::class_<TestDataProvider>("TestDataProvider")
        .constructor()
        .function("getTestLayer", &TestDataProvider::getTestLayer);

    ////////// Wgs84AABB
    em::register_vector<int64_t>("VectorUint64");
    em::register_vector<double>("VectorDouble");
    em::class_<Wgs84AABB>("Wgs84AABB")
        .function(
            "tileIds",
            std::function<em::val(Wgs84AABB&, double, double, double, uint32_t, uint32_t)>(
                [](Wgs84AABB& self,
                   double camX,
                   double camY,
                   double camOrientation,
                   uint32_t level,
                   uint32_t limit) -> em::val
                {
                    std::vector<TileId> resultTiles;
                    resultTiles.reserve(limit);
                    self.tileIds(level, resultTiles);

                    std::vector<int64_t> tileIdArray;
                    std::vector<double> xArray;
                    std::vector<double> yArray;
                    tileIdArray.reserve(resultTiles.size());
                    xArray.reserve(resultTiles.size());
                    yArray.reserve(resultTiles.size());
                    for (auto& tile : resultTiles) {
                        tileIdArray.emplace_back((int64_t)tile.value_);
                        auto pos = tile.center();
                        xArray.emplace_back(pos.x);
                        yArray.emplace_back(pos.y);
                    }

                    em::val result = em::val::object();
                    result.set("id", tileIdArray);
                    result.set("x", xArray);
                    result.set("y", yArray);

                    return result;
                    // return em::val(resultWithPrio.size());
                }))
        .function(
            "ne",
            std::function<em::val(Wgs84AABB&)>(
                [](Wgs84AABB& self) -> em::val
                {
                    Wgs84Point pt = self.ne();
                    em::val list = em::val::array();
                    list.set(0, pt.x);
                    list.set(1, pt.y);
                    return list;
                }))
        .function(
            "sw",
            std::function<em::val(Wgs84AABB&)>(
                [](Wgs84AABB& self) -> em::val
                {
                    Wgs84Point pt = self.sw();
                    em::val list = em::val::array();
                    list.set(0, pt.x);
                    list.set(1, pt.y);
                    return list;
                }));
    function("createWgs84AABB", &createWgs84AABB, em::allow_raw_pointers());
}
