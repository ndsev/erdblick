import type {APIRequestContext} from '@playwright/test';
import {expect} from '@playwright/test';

const protocolVersion = '2026-07-28';

/** Actual Streamable HTTP client; browser actions travel through mapget and its existing WS. */
export function mcpClient(request: APIRequestContext, defaultHeaders: Record<string, string> = {}) {
    let nextId = 0;
    async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
        const id = ++nextId;
        const response = await request.post('/mcp', {
            headers: {
                'Accept': 'application/json, text/event-stream',
                'MCP-Protocol-Version': protocolVersion,
                'Mcp-Method': method,
                ...(typeof params['name'] === 'string' ? {'Mcp-Name': params['name']} : {}),
                ...defaultHeaders,
                ...headers
            },
            data: {jsonrpc: '2.0', id, method, params: {
                ...params,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': protocolVersion,
                    'io.modelcontextprotocol/clientInfo': {name: 'erdblick-integration', version: '1'},
                    'io.modelcontextprotocol/clientCapabilities': {}
                }
            }}
        });
        if (!response.ok()) return {response, message: null};
        const body = await response.text();
        const messages = response.headers()['content-type']?.includes('text/event-stream')
            ? body.split(/\r?\n\r?\n/).flatMap(event => {
                const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trimStart()).join('\n');
                return data ? [JSON.parse(data)] : [];
            })
            : [JSON.parse(body)];
        const message = messages.find(value => value.id === id);
        expect(message, 'Response for the exact MCP request').toBeDefined();
        return {response, message};
    }
    async function call(name: string, args: Record<string, unknown> = {}) {
        const {response, message} = await rpc('tools/call', {name, arguments: args});
        expect(response.ok(), await response.text()).toBe(true);
        expect(message.error).toBeUndefined();
        return message.result;
    }
    async function sessions(): Promise<Array<{clientId: string; label: string}>> {
        const result = await call('viewer_list_sessions');
        expect(result.isError).not.toBe(true);
        return result.structuredContent.sessions;
    }
    return {rpc, call, sessions};
}
