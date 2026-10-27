// Local MCP transport; reconnecting never replays a mutating command.
export async function connectUnityMcp({ projectRoot, endpoint = 'http://127.0.0.1:8080/mcp' }) {
  let sessionId;
  let protocol = '2024-11-05';
  let nextId = 1;
  const timings = [];
  async function post(method, params, notification = false) {
    const id = notification ? undefined : nextId++;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (sessionId) headers['mcp-protocol-version'] = protocol;
    const started = performance.now();
    const response = await fetch(endpoint, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(40000) });
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
    const raw = await response.text();
    timings.push({ method, tool: params?.name, ms: Math.round(performance.now() - started) });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}; no automatic replay`);
    if (notification) return;
    const packet = raw.trim().startsWith('{') ? JSON.parse(raw) : raw.split(/\r?\n/)
      .filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(item => item.id === id);
    if (!packet || packet.error) throw new Error(packet?.error?.message ?? 'Missing MCP response');
    return packet.result;
  }
  function unpack(result) {
    if (result?.structuredContent) return result.structuredContent;
    const part = (result?.content ?? result?.contents ?? []).find(item => typeof item.text === 'string');
    if (!part) throw new Error('MCP returned no structured/text result');
    return JSON.parse(part.text);
  }
  const init = await post('initialize', { protocolVersion: protocol, capabilities: {},
    clientInfo: { name: 'qa-learned-ui', version: '1' } });
  protocol = init.protocolVersion;
  await post('notifications/initialized', undefined, true);
  const project = unpack(await post('resources/read', { uri: 'mcpforunity://project/info' }));
  const normalize = value => String(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  if (!project.success || normalize(project.data?.projectRoot) !== normalize(projectRoot))
    throw new Error('Unexpected Unity project; no UI input enabled');
  return {
    timings,
    async invoke(name, args) {
      const result = unpack(await post('tools/call', { name, arguments: args }));
      if (!result?.success) throw new Error(result?.message ?? 'MCP tool failed; observe before retrying');
      return result;
    },
  };
}
