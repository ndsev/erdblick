#include <emscripten/bind.h>

#include "mapget/model/sourcedatalayer.h"
#include "cesium-interface/object.h"

erdblick::JsValue tileSourceDataLayerToObject(const mapget::TileSourceDataLayer& layer);
