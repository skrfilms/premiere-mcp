/**
 * Version up every shot to the newest render on disk.
 *
 * The ask, near verbatim from editors: "100+ VFX shots, and I relink them one by one." For an
 * AI-VFX pipeline it is the daily loop: new comps land as SH010_comp_v004.mp4 next to v003, and the
 * cut should play the latest of each. This plans the relinks from file names alone (pure, tested
 * without Premiere); the tool then applies them through replace_clip_media, which keeps every
 * timeline clip, trim and effect and renames items that carried the old file name.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** shot_comp_v003.mp4 -> { key: "shot_comp|.mp4", version: 3 }. Separator before v: _ . - or space. */
const VERSIONED = /^(.*?)[_.\- ]v(\d{1,5})$/i;

export interface VersionedName { key: string; stem: string; version: number; digits: number; ext: string }

export function parseVersioned(fileName: string): VersionedName | null {
  const ext = extname(fileName);
  const m = VERSIONED.exec(fileName.slice(0, fileName.length - ext.length));
  if (!m) return null;
  return { key: `${m[1]!.toLowerCase()}|${ext.toLowerCase()}`, stem: m[1]!, version: Number(m[2]), digits: m[2]!.length, ext };
}

export interface ProjectMedia { id: string; name: string; path: string }
export interface VersionUpPlanItem { id: string; name: string; shot: string; fromVersion: number; toVersion: number; from: string; to: string }

/**
 * Plan: for each project item whose file is versioned, the newest file with the same stem and
 * extension among `candidates`. Items already on their newest version are reported as current.
 */
export function planVersionUp(items: ProjectMedia[], candidates: string[]) {
  const newest = new Map<string, { version: number; path: string }>();
  for (const p of candidates) {
    const v = parseVersioned(basename(p));
    if (!v) continue;
    const cur = newest.get(v.key);
    if (!cur || v.version > cur.version) newest.set(v.key, { version: v.version, path: p });
  }
  const relink: VersionUpPlanItem[] = [];
  const current: Array<{ id: string; name: string; version: number }> = [];
  const unversioned: string[] = [];
  for (const it of items) {
    const v = parseVersioned(basename(it.path));
    if (!v) { unversioned.push(it.name); continue; }
    const best = newest.get(v.key);
    if (best && best.version > v.version) relink.push({ id: it.id, name: it.name, shot: v.stem, fromVersion: v.version, toVersion: best.version, from: it.path, to: best.path });
    else current.push({ id: it.id, name: it.name, version: v.version });
  }
  return { relink, current, unversionedCount: unversioned.length };
}

/** Files under the given folders (optionally recursive, bounded), for planVersionUp. */
export function listCandidateFiles(dirs: string[], recursive: boolean, maxFiles = 20000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (seen.has(dir) || out.length >= maxFiles) return;
    seen.add(dir);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = join(dir, n);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (recursive && depth < 6) walk(full, depth + 1); }
      else if (out.length < maxFiles) out.push(full);
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

export const folderOf = (p: string): string => dirname(p);
