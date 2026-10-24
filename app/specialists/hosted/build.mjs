// Builds self-contained agent folders outside the project tree so headless runs
// don't inherit the owner's CLAUDE.md files. Inlines @imports.
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(new URL(import.meta.url).pathname);
const out = process.argv[2] || join(homedir(), '.wittle-rooms', 'hostedagents', 'agents');
const inline = (file) => readFileSync(file, 'utf8').replace(/^@(\S+)$/gm, (_, rel) => inline(resolve(dirname(file), rel)));

for (const name of ['anti-slop-editor', 'local-guide-nyc', 'website-auditor']) {
  const dir = join(out, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), inline(join(here, name, 'CLAUDE.md')));
  const settings = JSON.parse(readFileSync(join(here, name, '.claude', 'settings.json'), 'utf8'));
  // Agents never need local files; instructions arrive via CLAUDE.md.
  settings.permissions.deny = [...new Set([...settings.permissions.deny, 'Read', 'Glob', 'Grep', 'Task', 'WebSearch'].filter((t) => !settings.permissions.allow.includes(t)))];
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  console.log(dir);
}
