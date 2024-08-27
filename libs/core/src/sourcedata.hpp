#include <emscripten/bind.h>

#include "mapget/model/sourcedatalayer.h"

emscripten::val tileSourceDataLayerToObject(const mapget::TileSourceDataLayer& layer);
