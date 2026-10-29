/**
 * Project notes: a Markdown file next to the .prproj holding what this project does its own way
 * (shot naming like SPHE_008_0080 or SH010_comp_v003, where renders land, which export preset the
 * client wants). get_project_info returns it, so every session starts knowing it instead of
 * re-learning it, and a teammate opening the project gets the same notes.
 */
import { basename, dirname, join } from 'node:path';

export function notesPathFor(projectPath: string): string {
  return join(
    dirname(projectPath),
    `${basename(projectPath).replace(/\.prproj$/i, '')}.mcp-notes.md`,
  );
}

/** Append a bullet under `## section`, creating the file header and section when missing. */
export function addNote(text: string, note: string, section: string, when: Date): string {
  let doc = text.trim()
    ? text.replace(/\s*$/, '\n')
    : '# Project notes\n\nConventions for this project, kept by Premiere MCP and read at the start of each session.\n';
  const line = `- ${note.replace(/\s*\n\s*/g, ' ')} _(${when.toISOString().slice(0, 10)})_`;
  const heading = `## ${section}`;
  const lines = doc.split('\n');
  const at = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (at === -1) return `${doc}\n${heading}\n\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  while (end > at + 1 && lines[end - 1]!.trim() === '') end--;
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/\s*$/, '\n');
}
