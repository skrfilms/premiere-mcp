#!/usr/bin/env node
/**
 * Static API coverage audit.
 *
 * Reads every symbol out of docs/VERIFIED-API-SURFACE.md (live-reflected ground truth)
 * and greps the tool sources for each one. A symbol no tool references is a coverage gap
 * by definition — that is exactly how app.getEnableProxies() was missed: the capability
 * existed on the app object, four proxy tools shipped without it, and nothing compared the
 * API surface to what the catalogue actually called.
 *
 * Offline only. Never touches the Premiere host.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SURFACE = 'docs/VERIFIED-API-SURFACE.md';
// bridge/index.ts is included because several DOM calls live there rather than in a tool
// body (app.openDocument is reached through bridge.openProject). Omitting it reported
// covered symbols as gaps.
const SOURCES = ['src/tools/index.ts', 'src/tools/expanded.ts', 'src/bridge/index.ts'];

const surfaceText = readFileSync(SURFACE, 'utf8');
const sourceText = SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Symbols live in fenced code blocks that follow an object heading. Parse heading ->
 * block so each symbol is attributed to the object it belongs to; a bare name list
 * would lose that and make the matrix unreadable.
 */
const groups = [];
const lines = surfaceText.split('\n');
let currentHeading = null;
let inFence = false;
let fenceBuf = [];

for (const line of lines) {
  const h = line.match(/^#{2,3}\s+(.*)$/);
  if (h && !inFence) {
    currentHeading = h[1].replace(/`/g, '').trim();
    continue;
  }
  if (line.trim().startsWith('```')) {
    if (inFence) {
      // Closing fence: harvest identifiers.
      if (currentHeading) {
        const names = fenceBuf
          .join(' ')
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
        if (names.length) groups.push({ heading: currentHeading, names });
      }
      fenceBuf = [];
    }
    inFence = !inFence;
    continue;
  }
  if (inFence) fenceBuf.push(line);
}

// Symbols that are JS/plumbing rather than Premiere capability. Counting these as gaps
// would bury the real findings in noise.
const NOT_USEFUL = new Set([
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'bind', 'unbind',
  'setTimeout', 'trace', 'write', 'reflect', 'toString', 'valueOf',
  'benchmarkReflectEverything', 'waitForCurrentReflectionToComplete', 'getProcessID',
  'codeProfiler', 'init', 'isStagingEnvironment', 'build', 'userGuid',
  'learnPanelContentDirPath', 'learnPanelExampleProjectDirPath',
]);

function isReferenced(name) {
  // Two call shapes have to be recognised, and missing the second produced false gaps:
  //   1. direct property access .............. obj.detachProxy(...)
  //   2. dynamic dispatch by name ............ tryCall(obj, ["detachProxy", ...], [])
  // expanded.ts uses (2) extensively to probe for a method before calling it, so a
  // symbol can be genuinely covered while never appearing as `.name`.
  const direct = new RegExp(`\\.${name}\\b`);
  const quoted = new RegExp(`["']${name}["']`);
  return direct.test(sourceText) || quoted.test(sourceText);
}

const rows = [];
const seen = new Set();
for (const g of groups) {
  for (const name of g.names) {
    const key = `${g.heading}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      object: g.heading,
      symbol: name,
      notUseful: NOT_USEFUL.has(name),
      referenced: isReferenced(name),
    });
  }
}

const gaps = rows.filter((r) => !r.referenced && !r.notUseful);
const covered = rows.filter((r) => r.referenced);
const noise = rows.filter((r) => !r.referenced && r.notUseful);

console.log(`symbols examined : ${rows.length}`);
console.log(`covered          : ${covered.length}`);
console.log(`GAPS             : ${gaps.length}`);
console.log(`not-useful       : ${noise.length}`);
console.log('');
console.log('=== GAPS BY OBJECT ===');
const byObj = {};
for (const g of gaps) (byObj[g.object] ??= []).push(g.symbol);
for (const [obj, syms] of Object.entries(byObj)) {
  console.log(`\n${obj}  (${syms.length})`);
  console.log('  ' + syms.join(', '));
}

writeFileSync('/tmp/api-coverage-rows.json', JSON.stringify(rows, null, 2));
