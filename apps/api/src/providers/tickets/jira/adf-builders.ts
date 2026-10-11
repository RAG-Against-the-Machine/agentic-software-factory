/**
 * Atlassian Document Format constructors, dependency-free.
 *
 * The Jira REST API takes description and comment bodies as ADF (a JSON tree),
 * never Markdown. These are the small set of node builders the provider needs to
 * author machine-written comments (a run's status, a change-request link) and to
 * back the Markdown↔ADF codec in `adf.ts`. Keeping them here rather than pulling
 * a library means the grammar we *emit* is exactly the grammar the codec reads —
 * one specification, no third-party surface that could produce a shape the
 * reader cannot parse back.
 */

export interface AdfNode {
  type: string;
  /** Only on the root `doc` node, where Jira requires it. */
  version?: number;
  text?: string;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function adfText(text: string): AdfNode {
  return { type: 'text', text };
}

export function adfLink(text: string, href: string): AdfNode {
  return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
}

export function adfParagraph(...content: (AdfNode | string)[]): AdfNode {
  return {
    type: 'paragraph',
    content: content.map((node) => (typeof node === 'string' ? adfText(node) : node)),
  };
}

export function adfDoc(...blocks: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content: blocks };
}

/** Plain lines, one paragraph each. The common case. */
export function adfLines(...lines: string[]): AdfNode {
  return adfDoc(...lines.map((line) => adfParagraph(line)));
}

/**
 * A block of text kept exactly as written, newlines and all. Jira renders a
 * code block in a scrollable box, which is the honest presentation of a chunk
 * of Markdown (a rendered plan, a diff) that we do not want flattened.
 */
export function adfCode(text: string): AdfNode {
  return { type: 'codeBlock', content: [adfText(text)] };
}
