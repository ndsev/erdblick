#ifndef ERDBLICK_FEATURESTYLERULE_H
#define ERDBLICK_FEATURESTYLERULE_H

#include "mapget/model/feature.h"
class FeatureStyleRule
{
public:
    bool match(mapget::Feature const&);

    const float opacity();

    // TODO Create classes for advanced types.
    // const Color color();
    // const GeometryTypeBitmask geometryTypes();
};

#endif  // ERDBLICK_FEATURESTYLERULE_H
