import {expect, test} from '../fixtures/test';
import type {ErdblickCore_} from '../../app/integrations/wasm';

test.use({stateSnapshot: null});

test('WASM completes feature and attribute domains without materialized sample features', async ({page}) => {
    await page.goto('/?v2=1&n=1&m=1&f=0&lon=10&lat=40&alt=1000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=0&bg=~10&l=');
    await expect.poll(() => page.evaluate(() => !!window.ebDebug)).toBe(true);
    const results = await page.evaluate(() => {
        const core: ErdblickCore_ = window.ebDebug!.coreLib();
        const parser = new core.TileLayerParser();
        const metadata = [{stringPoolId: 'completion-test', mapId: 'completion-test', layers: {Road: {
            layerId: 'Road', type: 'Features',
            featureTypes: [{name: 'Road', uniqueIdCompositions: [[{partId: 'id', datatype: 'U32'}]]}],
            featureModelSchema: {
                oneOf: [{$ref: '#/$defs/Feature'}],
                $defs: {Feature: {
                    type: 'object', 'x-mapget': {metaType: 'Feature', featureType: 'Road'},
                    properties: {
                        typeId: {const: 'Road'},
                        properties: {$ref: '#/$defs/FeatureProperties'},
                        samples: {type: 'array', items: {
                            type: 'object', properties: {
                                speedLimit: {type: 'number'}, next: {$ref: '#/$defs/Feature'}
                            }
                        }}
                    }
                }, FeatureProperties: {
                    type: 'object', 'x-mapget': {metaType: 'FeatureProperties', featureType: 'Road'},
                    properties: {layer: {$ref: '#/$defs/AttributeLayerMap'}}
                }, AttributeLayerMap: {
                    type: 'object', 'x-mapget': {metaType: 'AttributeLayerMap', featureType: 'Road'},
                    properties: {RoadRulesLayer: {$ref: '#/$defs/RulesLayer'}}
                }, RulesLayer: {
                    type: 'object', 'x-mapget': {metaType: 'AttributeContainer'},
                    properties: {WARNING_SIGN: {$ref: '#/$defs/WarningSignAttribute'}}
                }, WarningSignAttribute: {
                    type: 'object', 'x-mapget': {metaType: 'Attribute', attributeTypeCode: 'WARNING_SIGN'},
                    properties: {
                        attributeValue: {type: 'object', properties: {
                            warningSign: {type: 'string', enum: ['SPEED_LIMIT_END']}
                        }},
                        validity: {type: 'array', items: {type: 'object', properties: {
                            direction: {type: 'string', enum: ['POSITIVE', 'NEGATIVE']}
                        }}}
                    }
                }}
            }
        }}}];
        const bytes = new TextEncoder().encode(JSON.stringify(metadata));
        const buffer = new core.SharedUint8Array(bytes.length);
        try {
            core.HEAPU8.set(bytes, Number(buffer.getPointer()));
            parser.setDataSourceInfo(buffer);
            return [
                {query: 'samples[17].spe', scope: 'feature', text: 'speedLimit'},
                {query: 'samples[-1].spe', scope: 'feature', text: 'speedLimit'},
                {query: 'samples[0].next.samples[0].next.samples[0].spe', scope: 'feature', text: 'speedLimit'},
                {query: '$fea', scope: 'attribute', text: '["$feature"]'},
                {query: '$feature.samples[17].spe', scope: 'attribute', text: 'speedLimit'},
                {query: '$validityC', scope: 'attribute', text: '["$validityCount"]'},
                {query: '$hasV', scope: 'attribute', text: '["$hasValidity"]'},
                {query: 'validity[17].dir', scope: 'attribute', text: 'direction'},
                {query: 'attributeValue.warningSign == SPE', scope: 'attribute', text: '"SPEED_LIMIT_END"'}
            ].map(({query, scope, text}) => ({
                query, text, candidates: parser.completeSearchQuery(query, query.length,
                    {scope, timeoutMs: 1000, limit: 40})
            }));
        } finally {
            buffer.delete();
            parser.delete();
        }
    });
    for (const {query, text, candidates} of results) {
        const suffix = query.match(/\$?[\w]+$/)![0];
        expect(candidates).toContainEqual(expect.objectContaining({
            text, query: query.slice(0, -suffix.length) + text,
            range: [query.length - suffix.length, suffix.length],
            type: text.startsWith('"') ? 'Constant' : 'Field'
        }));
    }
});
