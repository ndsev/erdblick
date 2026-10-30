#include "erdblick/style-authoring.h"

namespace erdblick {

nlohmann::ordered_json const& styleAuthoringSchema()
{
    // Keep these records beside the parser. Only presentation shapes and the
    // primitive enums shared with validation belong here; never emulate SIMFIL,
    // inheritance, validity geometry or the native planner in a form schema.
    static auto const schema = nlohmann::ordered_json::parse(R"catalog({
      "records": {
        "stylesheet": {
          "name": {"kind":"string","group":"Common"},
          "layer": {"kind":"string","group":"Common","label":"Layer affinity (regular expression)","help":"Omit for any layer. Matches layer IDs across maps."},
          "rules": {"kind":"list","record":"rule","group":"Common"},
          "version": {"kind":"number","group":"Document","seed":2},
          "category": {"kind":"enum","values":["base","search"],"group":"Document"},
          "default": {"kind":"boolean","group":"Document","label":"Enabled by default","help":"Initial visibility, separate from the current visibility switch."},
          "lod-thresholds": {"kind":"vector","sizes":[7],"group":"Document","help":"Seven positive tile counts in strictly descending order."},
          "options": {"kind":"list","record":"option","group":"Options and presets"},
          "presets": {"kind":"list","record":"preset","group":"Options and presets"},
          "interaction-effects": {"kind":"record","record":"effects","group":"Interaction"}
        },
        "rule": {
          "scope": {"kind":"enum","values":["feature","attribute","relation"],"group":"Common","topLevel":true},
          "geometry": {"kind":"enum-list","values":["point","line","polygon","mesh","aabb","gltf"],"group":"Common"},
          "filter": {"kind":"expression","group":"Common","help":"Feature predicate; in relation scope, evaluated on each relation ($source, $target, $twoway)."},
          "attribute-filter": {"kind":"expression","group":"Common","help":"Attribute/validity predicate ($feature, $name, $layer, $validityIndex)."},
          "color": {"kind":"color","group":"Common","exclusive":["color-expression","color-scale"]},
          "color-expression": {"kind":"expression","group":"Common","exclusive":["color","color-scale"]},
          "color-scale": {"kind":"record","record":"color-scale","group":"Common","exclusive":["color","color-expression"]},
          "width": {"kind":"number","group":"Common","seed":1,"label":"Width / point diameter"},
          "width-scale": {"kind":"record","record":"width-scale","group":"Common"},
          "opacity": {"kind":"number","group":"Common","seed":1},
          "label-text": {"kind":"string","group":"Common"},
          "label-text-expression": {"kind":"expression","group":"Common"},
          "type": {"kind":"string","group":"Matching","label":"Feature type (regular expression)"},
          "geometry-name": {"kind":"string","group":"Matching","seed":"*"},
          "mode": {"kind":"enum-list","values":["none","hover","selection"],"group":"Matching"},
          "selectable": {"kind":"boolean","group":"Matching"},
          "fidelity": {"kind":"enum","values":["any","high","low"],"group":"Matching","topLevel":true,"exclusive":["lod-range"]},
          "lod-range": {"kind":"vector","sizes":[2],"group":"Matching","topLevel":true,"exclusive":["fidelity"]},
          "min-lod-expression": {"kind":"expression","group":"Matching"},
          "attribute-type": {"kind":"string","group":"Attributes","label":"Attribute type (regular expression)"},
          "attribute-layer-type": {"kind":"string","group":"Attributes","label":"Attribute layer (regular expression)"},
          "attribute-validity-geom": {"kind":"enum","values":["any","required","none"],"group":"Attributes","help":"Any accepts entries with or without validity; required keeps only entries with validity; none keeps only entries without validity. Matching validity ranges are used when available."},
          "surface-shading": {"kind":"boolean","group":"Surface and drawing order"},
          "polygon-height": {"kind":"number","group":"Surface and drawing order"},
          "polygon-height-expression": {"kind":"expression","group":"Surface and drawing order"},
          "z-index": {"kind":"number","group":"Surface and drawing order"},
          "z-index-expression": {"kind":"expression","group":"Surface and drawing order"},
          "z-index-group-expression": {"kind":"expression","group":"Surface and drawing order","help":"Requires z-index-role."},
          "z-index-role": {"kind":"enum","values":["support","overlay"],"group":"Surface and drawing order","help":"Requires z-index-group-expression."},
          "billboard": {"kind":"boolean","group":"Surface and drawing order"},
          "depth-test": {"kind":"boolean","group":"Surface and drawing order"},
          "flat": {"kind":"boolean","group":"Surface and drawing order"},
          "offset": {"kind":"vector","sizes":[3],"group":"Offsets","help":"Local XYZ; when present takes precedence over lateral-offset and vertical-offset."},
          "offset-increment": {"kind":"vector","sizes":[3],"group":"Offsets"},
          "lateral-offset": {"kind":"number","group":"Offsets"},
          "vertical-offset": {"kind":"number","group":"Offsets"},
          "lateral-offset-unit": {"kind":"enum","values":["meter","meters","m","pixel","pixels","px"],"group":"Offsets"},
          "dashed": {"kind":"boolean","group":"Lines"},
          "dash-length": {"kind":"number","group":"Lines"},
          "dash-gap": {"kind":"number","group":"Lines"},
          "dash-unit": {"kind":"enum","values":["meter","meters","m","pixel","pixels","px"],"group":"Lines"},
          "arrow": {"kind":"enum","values":["none","forward","backward","double"],"group":"Lines"},
          "arrow-expression": {"kind":"expression","group":"Lines"},
          "glow": {"kind":"record","record":"glow","group":"Lines"},
          "icon-url": {"kind":"string","group":"Points"},
          "icon-url-expression": {"kind":"expression","group":"Points"},
          "point-merge-grid-cell": {"kind":"vector","sizes":[3],"group":"Points"},
          "point-cloud": {"kind":"boolean","group":"Points"},
          "point-cloud-max-points": {"kind":"number","group":"Points","help":"Zero requests exact geometry; positive values use the native point quota limit."},
          "label-color": {"kind":"color","group":"Labels"},
          "label-opacity": {"kind":"number","group":"Labels","seed":1},
          "label-font-family": {"kind":"string","group":"Labels","seed":"sans-serif"},
          "label-font-weight": {"kind":"number","group":"Labels","seed":400},
          "label-size": {"kind":"number","group":"Labels","seed":24},
          "label-size-scale": {"kind":"number","group":"Labels","seed":1},
          "label-size-units": {"kind":"enum","values":["meters","common","pixels"],"group":"Labels"},
          "label-size-min-pixels": {"kind":"number","group":"Labels"},
          "label-size-max-pixels": {"kind":"number","group":"Labels"},
          "label-angle": {"kind":"number","group":"Label layout"},
          "label-text-anchor": {"kind":"enum","values":["start","middle","end"],"group":"Label layout"},
          "label-alignment-baseline": {"kind":"enum","values":["top","center","bottom"],"group":"Label layout"},
          "label-pixel-offset": {"kind":"vector","sizes":[2],"group":"Label layout"},
          "label-line-height": {"kind":"number","group":"Label layout","seed":1},
          "label-word-break": {"kind":"enum","values":["break-word","break-all"],"group":"Label layout"},
          "label-max-width": {"kind":"number","group":"Label layout","seed":-1},
          "label-collision": {"kind":"boolean","group":"Label layout"},
          "label-collision-priority": {"kind":"number","group":"Label layout"},
          "label-outline-color": {"kind":"color","group":"Label decoration"},
          "label-outline-width": {"kind":"number","group":"Label decoration"},
          "label-background": {"kind":"boolean","group":"Label decoration"},
          "label-background-color": {"kind":"color","group":"Label decoration"},
          "label-background-padding": {"kind":"vector","sizes":[2,4],"group":"Label decoration"},
          "label-background-border-radius": {"kind":"vector","sizes":[0,4],"group":"Label decoration"},
          "label-border-color": {"kind":"color","group":"Label decoration"},
          "label-border-width": {"kind":"number","group":"Label decoration"},
          "relation-type": {"kind":"string","group":"Relations","label":"Relation type (regular expression)"},
          "relation-line-height-offset": {"kind":"number","group":"Relations"},
          "relation-line-geometry": {"kind":"enum","values":["centers","connection-stubs"],"group":"Relations"},
          "relation-recursive": {"kind":"boolean","group":"Relations"},
          "relation-merge-twoway": {"kind":"boolean","group":"Relations"},
          "relation-line-end-markers": {"kind":"record","record":"rule","group":"Relations"},
          "relation-source-style": {"kind":"record","record":"rule","group":"Relations"},
          "relation-target-style": {"kind":"record","record":"rule","group":"Relations"},
          "first-of": {"kind":"list","record":"rule","group":"Branches","exclusive":["all-of"],"help":"Render the first matching child. Child fields inherit from their parent."},
          "all-of": {"kind":"list","record":"rule","group":"Branches","exclusive":["first-of"],"help":"Render every matching child. Child fields inherit from their parent."},
          "gap-color": {"kind":"color","group":"Compatibility","help":"Legacy field; currently has no rendering effect."},
          "dash-pattern": {"kind":"number","group":"Compatibility","help":"Legacy field; use dash-length and dash-gap."},
          "outline-color": {"kind":"color","group":"Compatibility","help":"Legacy field; currently has no rendering effect."},
          "outline-width": {"kind":"number","group":"Compatibility","help":"Legacy field; currently has no rendering effect."},
          "offset-type": {"kind":"enum","values":["miter"],"group":"Compatibility","help":"Compatibility field; does not select another offset algorithm."}
        },
        "color-scale": {
          "mode": {"kind":"enum","values":["linear","categorical"]},
          "expression": {"kind":"expression"},
          "stops": {"kind":"stops","valueKind":"color"},
          "fallback": {"kind":"color"}
        },
        "width-scale": {
          "mode": {"kind":"enum","values":["linear","categorical"]},
          "expression": {"kind":"expression"},
          "stops": {"kind":"stops","valueKind":"number"},
          "fallback": {"kind":"number"}
        },
        "glow": {"color":{"kind":"color"},"radius":{"kind":"number"},"opacity":{"kind":"number","seed":1}},
        "option": {
          "id":{"kind":"string"},"label":{"kind":"string"},
          "type":{"kind":"enum","values":["bool","color","string"]},
          "default":{"kind":"option-default"},"description":{"kind":"string"},"internal":{"kind":"boolean"}
        },
        "preset": {"id":{"kind":"string"},"name":{"kind":"string"},"values":{"kind":"list","record":"preset-value"}},
        "preset-value": {"optionId":{"kind":"string","help":"ID of a local, non-internal Boolean option."},"value":{"kind":"boolean"}},
        "effects": {"hover":{"kind":"record","record":"effect"},"selection":{"kind":"record","record":"effect"}},
        "effect": {
          "tint":{"kind":"color-ref"},"tint-mix":{"kind":"number"},"opacity":{"kind":"number","seed":1},
          "edge-width":{"kind":"number"},"halo":{"kind":"record","record":"halo"},"stripe":{"kind":"record","record":"stripe"}
        },
        "halo": {"color":{"kind":"color-ref"},"radius":{"kind":"number"},"opacity":{"kind":"number","seed":1}},
        "stripe": {
          "color":{"kind":"color-ref"},"spacing":{"kind":"number"},"width":{"kind":"number"},
          "opacity":{"kind":"number","seed":1},"angle":{"kind":"number"},"offset":{"kind":"number"},"softness":{"kind":"number"}
        }
      },
      "seeds": {
        "rule":{"geometry":"line","color":"#3388ff","width":2},
        "color-scale":{"mode":"linear","expression":"0","stops":[[0,"#000000"],[1,"#ffffff"]]},
        "width-scale":{"mode":"linear","expression":"0","stops":[[0,1],[1,4]]},
        "option":{"id":"option","label":"Option","type":"bool","default":true},
        "preset":{"id":"preset","name":"Preset","values":[]},
        "preset-value":{"optionId":"","value":true}
      }
    })catalog");
    return schema;
}

std::string styleAuthoringSchemaJson()
{
    return styleAuthoringSchema().dump();
}

std::set<std::string> styleAuthoringEnumValues(std::string const& record, std::string const& field)
{
    return styleAuthoringSchema().at("records").at(record).at(field).at("values").get<std::set<std::string>>();
}

}
