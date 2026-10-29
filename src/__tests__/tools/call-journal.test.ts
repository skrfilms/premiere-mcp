/**
 * "Did my last call run?" and safe retries, driven through the real MCP handler.
 *
 * The failure this guards: a client times out on an edit that Premiere did perform, retries, and
 * the edit lands twice. With a requestId the retry must return the first result without running
 * the tool again; get_recent_calls must show the call either way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { PremiereProTools } from '../../tools/index.js';
import { PremiereProResources } from '../../resources/index.js';
import { PremiereProPrompts } from '../../prompts/index.js';
import { buildPremiereMcpServer } from '../../server-factory.js';

let dir: string;
const saved = process.env.PREMIERE_MCP_JOURNAL_PATH;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journal-'));
  process.env.PREMIERE_MCP_JOURNAL_PATH = join(dir, 'journal.jsonl');
});
afterEach(() => {
  if (saved === undefined) delete process.env.PREMIERE_MCP_JOURNAL_PATH;
  else process.env.PREMIERE_MCP_JOURNAL_PATH = saved;
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
  let edits = 0;
  const real = tools.executeTool.bind(tools);
  // A stand-in edit tool: counts how often it really runs. Everything else is the real catalogue.
  tools.executeTool = (async (name: string, args: Record<string, unknown>, opts?: unknown) => {
    if (name === 'add_marker') {
      edits++;
      return { success: true, markerId: `m${edits}` };
    }
    return real(name, args, opts as never);
  }) as typeof tools.executeTool;
  const surface = {
    tools,
    resources: new PremiereProResources({} as never),
    prompts: new PremiereProPrompts(),
  };
  const handler = createMcpHandler(() =>
    buildPremiereMcpServer(surface, { wireExposureNotifications: false }),
  );
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const res = await handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
    );
    const text = await res.text();
    const line = text.split(/\r?\n/).find((l) => l.startsWith('data:'));
    return JSON.parse(line ? line.slice(5) : text);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };
  return { handler, rpc, call, edits: () => edits };
}

describe('call journal', () => {
  it('a retry with the same requestId returns the first result and does not run again', async () => {
    const { handler, rpc, call, edits } = setup();
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    const first = await call('add_marker', { time: 1, requestId: 'edit-42' });
    const retry = await call('add_marker', { time: 1, requestId: 'edit-42' });
    expect(edits()).toBe(1);
    expect(first.markerId).toBe('m1');
    expect(retry).toMatchObject({ markerId: 'm1', replayed: true });
    const other = await call('add_marker', { time: 2, requestId: 'edit-43' });
    expect(other.markerId).toBe('m2');
    expect(edits()).toBe(2);
    await handler.close();
  }, 30000);

  it('get_recent_calls shows what ran, newest first, mutating calls flagged', async () => {
    const { handler, rpc, call } = setup();
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    await call('add_marker', { time: 3 });
    await call('find_tool', { query: 'marker' });
    const r = await call('get_recent_calls', { limit: 5 });
    const names = r.calls.map((c: any) => c.tool);
    expect(names.slice(0, 2)).toEqual(['find_tool', 'add_marker']);
    const marker = r.calls.find((c: any) => c.tool === 'add_marker');
    expect(marker).toMatchObject({ status: 'ok', readOnly: false });
    const onlyEdits = await call('get_recent_calls', { mutatingOnly: true });
    expect(onlyEdits.calls.every((c: any) => !c.readOnly)).toBe(true);
    await handler.close();
  }, 30000);

  it('start_job runs a tool in the background and get_job reports its result', async () => {
    const { handler, rpc, call } = setup();
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    const started = await call('start_job', { tool: 'find_tool', args: { query: 'marker' } });
    expect(started.jobId).toEqual(expect.any(String));
    let job: any;
    for (let i = 0; i < 50; i++) {
      job = await call('get_job', { jobId: started.jobId });
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.status).toBe('done');
    expect(job.result.matches.length).toBeGreaterThan(0);
    await handler.close();
  }, 30000);
});

describe('asking the user before a destructive call (elicitation)', () => {
  // Over stdio the server can ask the client a question mid-call. A delete that needs a yes is
  // asked about; on yes it runs again with confirm:true, on no nothing happens.
  async function run(answer: 'yes' | 'no' | 'none') {
    const { PassThrough } = await import('node:stream');
    const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
    const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
    const calls: Array<Record<string, unknown>> = [];
    tools.executeTool = (async (name: string, args: Record<string, unknown>) => {
      if (name !== 'delete_project_item') return { success: true };
      calls.push(args);
      return args.confirm === true
        ? { success: true, deleted: true }
        : {
            success: false,
            error: 'used on the timeline',
            details: {
              needsConfirmation: true,
              confirmPrompt: 'Delete clip X? It is used 2 times.',
            },
          };
    }) as typeof tools.executeTool;
    const surface = {
      tools,
      resources: new PremiereProResources({} as never),
      prompts: new PremiereProPrompts(),
    };
    const c2s = new PassThrough(),
      s2c = new PassThrough();
    const handle = serveStdio(
      () => buildPremiereMcpServer(surface, { wireExposureNotifications: false }),
      { transport: new StdioServerTransport(c2s, s2c) },
    );
    const asked: string[] = [];
    let buf = '';
    const result = new Promise<any>((resolve) => {
      s2c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.method === 'elicitation/create') {
            asked.push(msg.params.message);
            const reply =
              answer === 'yes'
                ? { action: 'accept', content: { confirm: true } }
                : { action: 'decline' };
            c2s.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: reply }) + '\n');
          } else if (msg.id === 2) resolve(JSON.parse(msg.result.content[0].text));
        }
      });
    });
    const caps = answer === 'none' ? {} : { elicitation: {} };
    c2s.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: caps,
          clientInfo: { name: 't', version: '1' },
        },
      }) + '\n',
    );
    c2s.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    c2s.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'delete_project_item', arguments: { projectItemId: 'X' } },
      }) + '\n',
    );
    const r = await result;
    await handle.close();
    return { r, asked, calls };
  }

  it('asks, and on yes runs the delete once with confirm:true', async () => {
    const { r, asked, calls } = await run('yes');
    expect(asked).toEqual(['Delete clip X? It is used 2 times.']);
    expect(calls.map((c) => c.confirm === true)).toEqual([false, true]);
    expect(r).toMatchObject({ success: true, deleted: true });
  }, 30000);

  it('asks, and on no changes nothing', async () => {
    const { r, calls } = await run('no');
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ success: false, userDeclined: true });
  }, 30000);

  it('without elicitation support, returns the needsConfirmation result for the assistant to handle', async () => {
    const { r, asked, calls } = await run('none');
    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(r.details.needsConfirmation).toBe(true);
  }, 30000);
});
