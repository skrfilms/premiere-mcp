/**
 * reflect_dom_object — the in-engine capability-discovery escape hatch.
 *
 * The reflection itself runs inside Premiere (ExtendScript's .reflect surface),
 * so these tests pin what this side controls and can verify without a host: the
 * generated script targets the right object, routes qe.* paths through the QE
 * DOM, threads the caller's filter/value flags, and passes the host's answer
 * back verbatim. The generated-script-syntax sweep separately parses the emitted
 * ExtendScript as ES3.
 */

import { executeExpandedTool, isExpandedTool } from '../../tools/expanded';

function captureBridge(respond: (script: string) => any = () => ({ success: true, data: {} })) {
  let script = '';
  const bridge = {
    executeScript: async (source: string) => {
      script = source;
      return respond(source);
    },
  };
  return { bridge, getScript: () => script };
}

describe('reflect_dom_object — registration', () => {
  it('is an expanded tool', () => {
    expect(isExpandedTool('reflect_dom_object')).toBe(true);
  });
});

describe('reflect_dom_object — generated script', () => {
  it('reflects the requested path via the .reflect interface', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'reflect_dom_object', {
      object_path: 'app.project.activeSequence',
    });
    const script = getScript();
    expect(script).toContain('reflect_dom_object');
    expect(script).toContain('resolveReflectPath');
    expect(script).toContain('.reflect');
    // enumerates both halves of the surface
    expect(script).toContain('reflectApi.methods');
    expect(script).toContain('reflectApi.properties');
  });

  it('roots qe.* paths at the QE DOM (enabling it first)', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'reflect_dom_object', { object_path: 'qe.project' });
    const script = getScript();
    // resolveReflectPath contains the enableQE branch; the requested path is embedded
    expect(script).toContain('app.enableQE()');
    expect(script).toContain('"qe.project"');
  });

  it('defaults the path to app when none is given', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'reflect_dom_object', {});
    expect(getScript()).toContain('reflect_dom_object');
  });

  it('threads include_values and name_filter into the embedded args', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'reflect_dom_object', {
      object_path: 'app',
      name_filter: 'sequence',
      include_values: true,
    });
    const script = getScript();
    expect(script).toContain('"name_filter":"sequence"');
    expect(script).toContain('"include_values":true');
  });
});

describe('reflect_dom_object — result passthrough', () => {
  it('returns the host reflection payload verbatim', async () => {
    const payload = {
      success: true,
      tool: 'reflect_dom_object',
      data: {
        path: 'app',
        className: 'Application',
        methodCount: 2,
        propertyCount: 1,
        methods: [
          { name: 'getConstant', returns: 'number', args: [{ name: 'name', type: 'string' }] },
          { name: 'setWorkspace', returns: 'boolean', args: [{ name: 'name', type: 'string' }] },
        ],
        properties: [{ name: 'version', type: 'string' }],
      },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'reflect_dom_object', {
      object_path: 'app',
    });
    expect(res).toEqual(payload);
    expect(res.data.methods[0].args[0]).toEqual({ name: 'name', type: 'string' });
  });

  it('passes a host-side "no reflect interface" refusal through unchanged', async () => {
    const fail = {
      success: false,
      tool: 'reflect_dom_object',
      error: 'Object at app.foo exposes no reflect interface',
    };
    const { bridge } = captureBridge(() => fail);
    const res = await executeExpandedTool(bridge as any, 'reflect_dom_object', {
      object_path: 'app.foo',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no reflect interface/);
  });
});
