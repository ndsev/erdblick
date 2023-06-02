#ifndef ERDBLICK_FEATURELAYERRULE_H
#define ERDBLICK_FEATURELAYERRULE_H

#include "mapget/model/feature.h"
class FeatureLayerRule
{
public:
    bool match(mapget::Feature const&);

    const float opacity();

    // TODO Create classes for advanced types.
    // const Color color();
    // const GeometryTypeBitmask geometryTypes();
};

#endif  // ERDBLICK_FEATURELAYERRULE_H
