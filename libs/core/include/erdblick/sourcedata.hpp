#include "mapget/model/sourcedatalayer.h"
#include "cesium-interface/object.h"

namespace erdblick
{

/**
 * Convert a SourceDataLayar hierarchy to a tree model compatible
 * structure.
 *
 * Layout:
 *   [{ data: [{key: "...", value: ...}, ...], children: [{ ... }] }, ...]
 *
 **/
erdblick::JsValue tileSourceDataLayerToObject(const mapget::TileSourceDataLayer& layer);

}
