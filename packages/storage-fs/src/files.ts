// Serialisation between the in-memory State and the human-readable store layout.
//
//   project.yaml                       blocks/<id>/block.yaml
//   edges.yaml                         blocks/<id>/{design,plan,digest}.md
//   state/seq.json                     blocks/<id>/{progress,steps,decisions}.jsonl
//   state/sessions.json                blocks/<id>/threads/<id>.yaml
//   state/proposals.json
//   state/audit.jsonl
//
// Docs are Markdown: YAML front matter, one `## section` per schema section. Prose sections are
// plain text; every other format is a fenced ```yaml block so the round trip is lossless.
import type { Doc, SectionValue } from '@hafiz/core'
import { parse as parseYaml, stringify as toYaml } from 'yaml'

export type FileMap = Map<string, string>

const FM = '---\n'

export function docToMarkdown(d: Doc): string {
  const { sections, ...meta } = d
  let out = `${FM}${toYaml(meta)}${FM}`
  for (const [name, value] of Object.entries(sections)) {
    out += `\n## ${name}\n\n`
    out +=
      typeof value === 'string' ? `${value.trimEnd()}\n` : `\`\`\`yaml\n${toYaml(value)}\`\`\`\n`
  }
  return out
}

export function markdownToDoc(text: string): Doc {
  if (!text.startsWith(FM)) throw new Error('document is missing front matter')
  const end = text.indexOf(`\n${FM}`, FM.length)
  const meta = parseYaml(text.slice(FM.length, end + 1)) as Omit<Doc, 'sections'>
  const body = text.slice(end + 1 + FM.length)
  const sections: Record<string, SectionValue> = {}
  const parts = body.split(/^## (.+)$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] as string).trim()
    const raw = (parts[i + 1] ?? '').trim()
    const m = /^```yaml\n([\s\S]*?)\n?```$/.exec(raw)
    sections[name] = m ? (parseYaml(m[1] as string) as SectionValue) : raw
  }
  return { ...meta, sections }
}

export const jsonl = {
  stringify: (rows: unknown[]) =>
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  parse: <T>(text: string): T[] =>
    text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T),
}

export const yaml = {
  stringify: (v: unknown) => toYaml(v),
  parse: <T>(t: string) => parseYaml(t) as T,
}

export const paths = {
  project: 'project.yaml',
  edges: 'edges.yaml',
  seq: 'state/seq.json',
  sessions: 'state/sessions.json',
  proposals: 'state/proposals.json',
  audit: 'state/audit.jsonl',
  block: (id: string) => `blocks/${id}/block.yaml`,
  doc: (id: string, type: string) => `blocks/${id}/${type}.md`,
  log: (id: string, log: string) => `blocks/${id}/${log}.jsonl`,
  thread: (block: string, id: string) => `blocks/${block}/threads/${id}.yaml`,
}
