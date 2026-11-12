// The Hermes bridge's MCP server answering a CAST card for the user. With confirmation on (the default), nothing
// reaches CAST unless the user said yes to the bridge's own prompt (MCP elicitation, which Hermes shows in the user's
// chat and its model cannot answer): a client that can't ask, a "decline", or a card answered elsewhere meanwhile
// sends nothing. Read tools are marked read-only so a `trust: untrusted` Hermes entry gates only tell and answer.
import { describe, expect, test } from 'bun:test';
import type { AgentInfo, ApprovalRequest, ClientMsg, ServerMsg } from '../../shared/protocol';
import type { Requestable } from '../../hermes/client';
import { McpServer, TOOLS, type Town } from '../../hermes/mcp';
import { shortCode } from '../../hermes/view';

function fakeTown() {
  const agent = { id: 'ag', projectId: 'p', jobId: 'main', kind: 'resident', name: 'Developer', status: 'idle', modelLabel: 'M' } as AgentInfo;
  const approval: ApprovalRequest = { id: 'req-1', agentId: 'ag', projectId: 'p', tool: 'bash', title: 'Allow tool: bash', detail: 'git push', options: ['Approve', 'Approve bash for this session', 'Deny'], ts: 1 };
  const requests: Requestable[] = [];
  const town: Town = {
    url: 'http://127.0.0.1:4860',
    city: { lots: [], projects: [{ id: 'p', name: 'Shop', path: '/w/shop', approvalMode: 'always-ask' }] } as unknown as Town['city'],
    jobs: [{ id: 'main', projectId: 'p', name: 'Main' }] as unknown as Town['jobs'],
    agents: new Map([[agent.id, agent]]),
    approvals: new Map([[approval.id, approval]]),
    plans: new Map(),
    runs: new Map(),
    connected: true,
    problem: '',
    ready: async () => {},
    send: (_m: ClientMsg) => {},
    request: async (m: Requestable) => {
      requests.push(m);
      return { t: 'ack', reqId: 'x', ok: true };
    },
    transcript: async () => [],
    on: (_fn: (m: ServerMsg) => void) => () => {},
  };
  return { town, requests, code: shortCode('a', approval.id) };
}

/** A client: what the server writes, and answers to its elicitation requests. */
function client(town: Town, confirm: boolean, elicit: (msg: { id: string; params: { message: string } }) => unknown) {
  const out: Record<string, unknown>[] = [];
  let server: McpServer;
  server = new McpServer({
    town,
    confirm,
    log: () => {},
    write: (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.method === 'elicitation/create') {
        const reply = elicit(msg as { id: string; params: { message: string } });
        void server.handle(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: reply }));
      } else out.push(msg);
    },
  });
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const n = ++id;
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
    return out.find((m) => m.id === n) as { result?: { content?: { text: string }[]; isError?: boolean; [k: string]: unknown }; error?: unknown };
  };
  return { rpc, out };
}

const init = (elicitation: boolean) => ({ protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {}, clientInfo: { name: 't', version: '0' } });

describe('answer', () => {
  test('confirmed by the user: CAST gets the option the user named', async () => {
    const { town, requests, code } = fakeTown();
    const prompts: string[] = [];
    const c = client(town, true, (m) => (prompts.push(m.params.message), { action: 'accept', content: {} }));
    await c.rpc('initialize', init(true));
    const r = await c.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'approve' } });
    expect(r.result?.isError).toBeFalsy();
    expect(prompts[0]).toContain('git push'); // the user sees what they approve
    expect(requests).toEqual([{ t: 'approve', approvalId: 'req-1', value: 'Approve' }]);
  });

  test('declined, or a client that cannot ask: nothing reaches CAST', async () => {
    const { town, requests, code } = fakeTown();
    const declined = client(town, true, () => ({ action: 'decline' }));
    await declined.rpc('initialize', init(true));
    const r = await declined.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'approve' } });
    expect(r.result?.content?.[0]?.text).toContain('did not confirm');

    const mute = client(town, true, () => ({ action: 'accept' }));
    await mute.rpc('initialize', init(false));
    const r2 = await mute.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'approve' } });
    expect(r2.result?.isError).toBe(true);
    expect(r2.result?.content?.[0]?.text).toContain('CAST_HERMES_CONFIRM=off');
    expect(requests).toEqual([]);
  });

  test('answered elsewhere while the user was confirming: nothing is sent', async () => {
    const { town, requests, code } = fakeTown();
    const c = client(town, true, () => {
      (town.approvals as Map<string, ApprovalRequest>).delete('req-1'); // someone pressed Approve in the browser
      return { action: 'accept', content: {} };
    });
    await c.rpc('initialize', init(true));
    const r = await c.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'deny' } });
    expect(r.result?.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  test('with confirmation off, the model’s answer goes straight to CAST; a word that fits no option never does', async () => {
    const { town, requests, code } = fakeTown();
    const c = client(town, false, () => {
      throw new Error('must not ask');
    });
    await c.rpc('initialize', init(false));
    const bad = await c.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'whatever' } });
    expect(bad.result?.isError).toBe(true);
    expect(requests).toEqual([]);
    await c.rpc('tools/call', { name: 'answer', arguments: { id: code, choice: 'deny' } });
    expect(requests).toEqual([{ t: 'approve', approvalId: 'req-1', value: 'Deny' }]);
  });
});

test('only status, read and pending are read-only', () => {
  expect(TOOLS.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name)).toEqual(['status', 'read', 'pending']);
});
