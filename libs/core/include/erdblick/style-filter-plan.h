#pragma once

#include "interop/js-object.h"
#include "mapget/model/featurelayer-filter.h"
#include "mapget/model/info.h"
#include "style.h"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace erdblick
{

/** One stylesheet-planning failure tied to its source top-level rule. */
struct StyleFilterPlanIssue
{
    uint32_t ruleIndex = 0;
    std::string message;
};

/**
 * Generic mapget filter channels derived from one stylesheet presentation.
 *
 * Channel order follows active top-level stylesheet order. A failed plan is
 * intentionally not executable even when some earlier channels were valid.
 */
struct StyleFilterPlan
{
    bool valid = true;
    std::vector<mapget::FeatureLayerFilterChannel> channels;
    std::vector<StyleFilterPlanIssue> issues;

    [[nodiscard]] NativeJsValue toJsValue() const;
};

/**
 * Plan one concrete map/layer presentation without sending style semantics to
 * mapget.
 */
StyleFilterPlan planStyleFilter(
    FeatureLayerStyle const& style,
    mapget::LayerInfo const& layerInfo,
    FeatureStyleRule::HighlightMode highlightMode,
    FeatureStyleRule::Fidelity fidelity);

/**
 * Expand Erdblick-only expression conveniences to their generic server form.
 *
 * The renderer applies the same mapping when binding an authored expression
 * back to a projected channel slot.
 */
std::string expandStyleExpressionForFilter(std::string_view expression);

}
