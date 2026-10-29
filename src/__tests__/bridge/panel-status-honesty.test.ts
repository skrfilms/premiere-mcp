/**
 * The panel's own status lights must not claim more than they proved.
 *
 * A server that refuses to report an unverified edit as done had shipped a UI that
 * reported an unverified HOST as ready: `startBridge` turned the Premiere light green on
 * the strength of the temp directory existing, and `testPremiereConnection` — the one
 * method that actually round-trips ExtendScript — was never called from anywhere in the
 * panel. Nothing caught it because no test could observe the panel's DOM writes at all.
 *
 * These tests drive the real panel with observable elements, so the claim on screen is
 * checked against what was actually proven. They also pin the in-flight guard, because
 * Stop -> Start during a long host script used to clear it and let two commands run at once.
 */

import { loadPanel } from '../helpers/panel.js';

const STATUS_IDS = [
  'connectionStatus',
  'connectionText',
  'serverStatus',
  'serverText',
  'startButton',
  'stopButton',
  'tempDirectory',
  'commandQueue',
];

/** A panel wired to a resolvable DOM, with the temp directory already settled. */
function panelWithDom(tempDir: string | null = '/tmp/premiere-mcp-bridge') {
  const panel = loadPanel({ elements: STATUS_IDS });
  panel.bridge.getTempDirectory = () => tempDir;
  panel.bridge.commandQueue = [];
  panel.bridge.isConnected = false;
  panel.bridge.isProcessing = false;
  panel.bridge.currentCommandId = null;
  panel.bridge.currentCommandStartedAt = null;
  return panel;
}

describe('the Premiere light is earned, not assumed', () => {
  it('does NOT claim the host is ready when only the temp directory was checked', () => {
    const panel = panelWithDom();
    panel.bridge.startBridge();

    // The bridge itself IS connected — that part is true and locally observable.
    expect(panel.elements.connectionText.textContent).toBe('Connected');
    // The host has been ASKED, not answered. Anything containing "Ready" here would be
    // the panel asserting something no round trip has established.
    expect(panel.elements.serverText.textContent).not.toContain('Ready');
    expect(panel.elements.serverText.textContent).toContain('verifying');
    // Asserted as an exact class, not `not.toContain('connected')` — "disconnected"
    // contains "connected", which would have passed either way and proved nothing.
    expect(panel.elements.serverStatus.className).toBe('status-dot disconnected');
  });

  it('dispatches a real host round trip on start', () => {
    const panel = panelWithDom();
    panel.bridge.startBridge();

    // testPremiereConnection existed and was dead code; this asserts it is wired.
    expect(panel.evalScriptCalls()).toBe(1);
    expect(panel.handedToEvalScript()).toContain('app.version');
  });

  it('turns the light green only once the host actually answers', () => {
    const panel = panelWithDom();
    // Stub the round trip so both outcomes can be driven deterministically.
    panel.bridge.executeExtendScript = (
      _script: string,
      cb: (err: unknown, result: unknown) => void,
    ) => {
      cb(null, { appVersion: '26.3.2', projectName: 'feature_cut_v2.prproj' });
    };

    panel.bridge.testPremiereConnection();
    expect(panel.elements.serverText.textContent).toBe('Premiere Pro: Ready');
    expect(panel.elements.serverStatus.className).toBe('status-dot connected');
  });

  it('reports not-ready when the host round trip fails', () => {
    const panel = panelWithDom();
    panel.bridge.executeExtendScript = (_script: string, cb: (err: unknown) => void) => {
      cb(new Error('evalScript timed out'));
    };

    panel.bridge.testPremiereConnection();
    expect(panel.elements.serverText.textContent).not.toContain('Ready');
    expect(panel.elements.serverStatus.className).toBe('status-dot disconnected');
  });

  it('stays not-ready when there is no temp directory to watch', () => {
    const panel = panelWithDom(null);
    panel.bridge.startBridge();

    expect(panel.elements.connectionText.textContent).toBe('Disconnected');
    expect(panel.elements.serverText.textContent).not.toContain('Ready');
    // No probe: there is nothing to bridge to yet.
    expect(panel.evalScriptCalls()).toBe(0);
  });
});

describe('the in-flight guard survives a stop/start', () => {
  it('keeps the guard set when a host command is still outstanding', () => {
    const panel = panelWithDom();
    panel.bridge.isProcessing = true;
    panel.bridge.currentCommandId = 'cmd-in-flight';
    panel.bridge.currentCommandStartedAt = Date.now() - 5000;

    panel.bridge.startBridge();

    // Clearing this was the bug: the 250ms poller would dispatch a SECOND command, and the
    // first command's completion callback would then clear the state out from under it.
    expect(panel.bridge.isProcessing).toBe(true);
    expect(panel.bridge.currentCommandId).toBe('cmd-in-flight');
    // And no probe is dispatched alongside the outstanding script, for the same reason.
    expect(panel.evalScriptCalls()).toBe(0);
  });

  it('stopBridge does not pretend an outstanding command went away', () => {
    const panel = panelWithDom();
    panel.bridge.isConnected = true;
    panel.bridge.isProcessing = true;
    panel.bridge.currentCommandId = 'cmd-in-flight';

    panel.bridge.stopBridge();

    // Stopping stops picking up NEW commands; it cannot recall a script already handed to
    // the host, so the guard must not be cleared.
    expect(panel.bridge.isConnected).toBe(false);
    expect(panel.bridge.isProcessing).toBe(true);
  });

  it('clears the guard normally when nothing is outstanding', () => {
    const panel = panelWithDom();
    panel.bridge.isProcessing = true;
    panel.bridge.currentCommandId = null;

    panel.bridge.startBridge();
    expect(panel.bridge.isProcessing).toBe(false);
  });
});

describe('queue rendering escapes server-supplied script text', () => {
  it('does not let a script prefix inject markup', () => {
    const panel = panelWithDom();
    panel.bridge.commandQueue = [
      { id: 'a', status: 'executing', script: 'if (a < b && c) { <img src=x onerror=alert(1)>' },
    ];

    panel.bridge.updateCommandQueueUI();
    const html = panel.elements.commandQueue.innerHTML;

    // The one element per row the panel authors is the row itself; the payload must be text.
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).toContain('&amp;&amp;');
  });

  it('still renders the empty state', () => {
    const panel = panelWithDom();
    panel.bridge.commandQueue = [];
    panel.bridge.updateCommandQueueUI();
    expect(panel.elements.commandQueue.innerHTML).toContain('No commands in queue');
  });
});
