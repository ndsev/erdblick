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

class FeatureLayerSearch
{
public:
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

    /** Returns a list of diagnostic messages of the following form:
     *
     *  [
     *    {message: string, location: {offset: number, size: numebr}, fix?: string}
     *  ]
     */
    NativeJsValue diagnostics(std::string const& q, NativeJsValue const& diagnostics);

private:
    TileFeatureLayer& tfl_;
};

}
