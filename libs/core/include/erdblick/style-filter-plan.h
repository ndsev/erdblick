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
 * Channels retain first-seen top-level rule order; compatible feature rules may
 * share one channel. Check valid before submitting: a failed plan may still
 * contain channels built before the failure, but executing those would render
 * only part of the authored style.
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
 * mapget. Select active rules for this layer, highlight mode and LOD, then request
 * the feature/entry projections needed by the renderer. Invalid rule combinations
 * are collected as issues; callers must reject the entire plan when valid is false.
 */
StyleFilterPlan planStyleFilter(
    FeatureLayerStyle const& style,
    mapget::LayerInfo const& layerInfo,
    FeatureStyleRule::HighlightMode highlightMode,
    uint8_t lod);

/**
 * Expand Erdblick-only expression conveniences to their generic server form.
 * Replace the reserved $mergeCount spelling at identifier boundaries with
 * count($features.*) for server group evaluation. This is a textual rewrite.
 * The renderer applies the same mapping when binding an authored expression
 * back to a projected channel slot.
 */
std::string expandStyleExpressionForFilter(std::string_view expression);

}
