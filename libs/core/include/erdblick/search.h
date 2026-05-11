#pragma once

#include "layer.h"

namespace erdblick
{

/**
 * Wrap the given simfil query in an any operator to ensure, that
 * it returns a boolean, and limit wildcard evaluations to the necessary
 * minimum.
 */
std::string anyWrap(std::string_view const& q);

/**
 * Simfil-backed search and completion helper for one parsed feature tile.
 *
 * The class is intentionally tile-scoped; higher-level orchestration decides
 * which tiles participate and when partial results are acceptable.
 */
class FeatureLayerSearch
{
public:
    /** Bind a search helper to one parsed tile layer. */
    explicit FeatureLayerSearch(TileFeatureLayer& tfl);

    /** Returns a resuct dictionary of the following structure:
     *
     *  {
     *    result: [[map tile key, feature id], ...],
     *    traces: map<string, {calls: int, values: [string, ...], totalus: int}>,
     *    diagnostics: [{message: "...", location: [offset, size], fix: null | "..."}, ...],
     *  }
     */
    NativeJsValue filter(std::string const& q);

    /** Returns a list of completion candidates of the following structure:
     *
     * [
     *   {text: string, range: [begin, end]}, ...
     * ]
     */
    NativeJsValue complete(std::string const& q, int point, NativeJsValue const& options);

private:
    TileFeatureLayer& tfl_;
};

}
