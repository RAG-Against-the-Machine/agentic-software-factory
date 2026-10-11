import { adfDoc, type AdfNode } from './adf-builders.js';

/**
 * Atlassian Document Format, out to markdown and back without losing anything.
 *
 * The board edits Jira descriptions in a textarea. The first version of this
 * module flattened ADF to plain text and rebuilt it as one paragraph per line,
 * so every save turned headings into sentences, lists into hyphens and links
 * into nothing. It guarded that with a confirmation — which meant the only two
 * outcomes were "cannot save" and "saved, formatting destroyed".
 *
 * This version is a round trip with one guarantee behind it:
 *
 *   **no ADF node is ever silently rewritten.** A block is rendered as markdown
 *   only if every node and every mark inside it can be parsed back to the same
 *   shape. Anything else — a table, a panel, embedded media, a coloured word, a
 *   macro nobody has heard of — is left as an opaque placeholder line and put
 *   back verbatim on save.
 *
 * That all-or-nothing-per-block rule is what makes this safe to reason about. A
 * partial converter that handles the easy 90% of a table and mangles the rest
 * is exactly the silent corruption this file exists to prevent; declining to
 * represent the whole block, and saying so in the UI, is honest and reversible.
 *
 * The placeholder map is NOT round-tripped through the browser. It is rebuilt
 * on the server from the issue as it stands at save time, which costs a read we
 * were making anyway and buys a concurrency check for free: a placeholder that
 * no longer resolves means the description changed in Jira while the drawer was
 * open, and the write is refused rather than dropping the block.
 *
 * The grammar accepted by the writer is exactly the grammar the reader emits.
 * They are one specification in two directions, which is why there is no
 * markdown library here — a library would accept input this side can produce
 * and that side cannot.
 */

// --- shape -------------------------------------------------------------------

interface AdfLike {
  type?: string;
  text?: string;
  content?: AdfLike[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

/**
 * An image inside a preserved block, named well enough for the caller to find
 * the attachment it came from.
 *
 * Read-only detail lifted out of the node — the node itself is still preserved
 * verbatim, and nothing here is consulted on the way back. It exists so the
 * drawer can render the picture rather than the word "image", which is the one
 * preserved kind where the placeholder loses something a reader actually needs.
 */
export interface AdfMediaRef {
  /** Media Services file id. Also the id in the attachment's redirect target. */
  id: string;
  /**
   * Jira sets this to the attachment's filename for anything uploaded or
   * pasted into a description, which is what makes the match to the issue's
   * attachment list possible without a second API. Null when it does not.
   */
  filename: string | null;
  width: number | null;
  height: number | null;
}

/** One block the markdown cannot represent, held aside and put back on save. */
export interface AdfPreservedBlock {
  /** The exact line that stands in for it in the markdown. */
  token: string;
  /** Human-readable node kind, for the message the drawer shows. */
  kind: string;
  /** The original ADF, untouched. */
  node: unknown;
  /**
   * Every `media` node anywhere inside it, in document order.
   *
   * Anywhere rather than at the top: an image dropped inline in a paragraph
   * preserves the paragraph, and an image in a panel preserves the panel, so
   * the media that matters is rarely the block's own child.
   */
  media: AdfMediaRef[];
}

export interface AdfMarkdown {
  text: string;
  preserved: AdfPreservedBlock[];
}

/**
 * The placeholder line.
 *
 * `⟦⟧` rather than brackets or braces because it has to be impossible to
 * produce by accident: no markdown, no code sample and no Jira description
 * contains a mathematical white square bracket. It is also unmistakable on
 * screen, which matters — the one thing an operator must not do is retype one.
 */
const TOKEN = /^[ \t]*⟦jira-block-(\d+):[^⟧]*⟧[ \t]*$/;

function tokenFor(index: number, kind: string): string {
  return `⟦jira-block-${index}: ${kind}⟧`;
}

/** Jira sends `description: null` for an empty one, and sometimes a bare string. */
export function parseAdf(raw: unknown): AdfLike | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    return {
      type: 'doc',
      content: raw === '' ? [] : raw.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
    };
  }
  if (typeof raw === 'object') return raw as AdfLike;
  return null;
}

// --- read: ADF -> markdown ----------------------------------------------------

/**
 * Marks that survive the trip. Everything else (`underline`, `textColor`,
 * `subsup`, `annotation`, …) makes its whole block unrepresentable: markdown
 * has no spelling for them and inventing one loses them on the way back.
 */
const KNOWN_MARKS = new Set(['strong', 'em', 'code', 'strike', 'link']);

/** Block types the writer below reconstructs exactly. */
const KNOWN_BLOCKS = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'codeBlock',
  'blockquote',
  'rule',
]);

/** A friendly name for the placeholder, so it reads as a thing and not an id. */
const KIND_LABELS: Record<string, string> = {
  table: 'table',
  panel: 'panel',
  mediaSingle: 'image',
  mediaGroup: 'attachments',
  expand: 'expand',
  nestedExpand: 'expand',
  taskList: 'task list',
  decisionList: 'decision list',
  bodiedExtension: 'macro',
  extension: 'macro',
  blockCard: 'linked card',
  embedCard: 'embedded card',
  layoutSection: 'columns',
};

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Every attached image under a node.
 *
 * `type: 'file'` only. An external media node points at a URL this system has
 * no credential for and no reason to proxy, so it stays a placeholder.
 */
function collectMedia(node: AdfLike, into: AdfMediaRef[] = []): AdfMediaRef[] {
  if (node.type === 'media' && node.attrs?.['type'] === 'file') {
    const id = node.attrs['id'];
    if (typeof id === 'string' && id !== '') {
      const alt = node.attrs['alt'];
      into.push({
        id,
        filename: typeof alt === 'string' && alt !== '' ? alt : null,
        width: readNumber(node.attrs['width']),
        height: readNumber(node.attrs['height']),
      });
    }
  }
  for (const child of node.content ?? []) collectMedia(child, into);
  return into;
}

function kindOf(node: AdfLike): string {
  const type = node.type ?? 'unknown';
  if (KIND_LABELS[type]) return KIND_LABELS[type]!;
  // A *known* block type that lands here failed on something inside it — a
  // coloured word, a status lozenge — so name the container, not the offender.
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Escapes what would otherwise parse back as inline formatting.
 *
 * Line-leading block markers are handled separately by `escapeBlockStart`,
 * because whether a `-` starts a list depends on where it sits rather than on
 * what it is.
 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_~[\]])/g, '\\$1');
}

/** A paragraph line whose first character would otherwise read as a block. */
function escapeBlockStart(line: string): string {
  return /^[ \t]*(?:[#>|+-]|\d+[.)]|```|---|___|⟦)/.test(line) ? `\\${line.trimStart()}` : line;
}

/**
 * Marks are applied innermost-first in a fixed order, so the same document
 * always produces the same string. An unstable ordering here would make an
 * untouched description look dirty the moment the drawer opened.
 */
const MARK_ORDER = ['code', 'strike', 'em', 'strong', 'link'] as const;

/** Inline content to markdown, or null if any of it cannot be represented. */
function inlineToMarkdown(nodes: readonly AdfLike[] | undefined): string | null {
  let out = '';

  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      out += '\n';
      continue;
    }
    if (node.type !== 'text' || typeof node.text !== 'string') return null;

    const marks = node.marks ?? [];
    if (marks.some((mark) => !mark.type || !KNOWN_MARKS.has(mark.type))) return null;

    const isCode = marks.some((mark) => mark.type === 'code');
    // Markdown cannot nest anything into a code span, and a backtick inside
    // one has no escape. Either case preserves the block instead of guessing.
    if (isCode && (marks.length > 1 || node.text.includes('`'))) return null;

    let piece = isCode ? node.text : escapeInline(node.text);

    for (const kind of MARK_ORDER) {
      const mark = marks.find((candidate) => candidate.type === kind);
      if (!mark) continue;

      if (kind === 'code') piece = `\`${piece}\``;
      else if (kind === 'strike') piece = `~~${piece}~~`;
      else if (kind === 'em') piece = `*${piece}*`;
      else if (kind === 'strong') piece = `**${piece}**`;
      else {
        const href = mark.attrs?.['href'];
        // A link carrying more than `href` — an inline-comment annotation, a
        // smart-link id — is more than the markdown holds.
        if (typeof href !== 'string' || Object.keys(mark.attrs ?? {}).length !== 1) return null;
        if (/[()\s]/.test(href)) return null;
        piece = `[${piece}](${href})`;
      }
    }
    out += piece;
  }

  return out;
}

/** A list to markdown lines, or null. `indent` is the nesting pad. */
function listToMarkdown(node: AdfLike, ordered: boolean, indent: string): string | null {
  const items: string[] = [];
  let n = 1;

  for (const item of node.content ?? []) {
    if (item.type !== 'listItem') return null;

    const marker = ordered ? `${n}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    const rendered: string[] = [];
    let seenParagraph = false;

    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        const nested = listToMarkdown(child, child.type === 'orderedList', indent + pad);
        if (nested === null) return null;
        rendered.push(nested);
        continue;
      }
      // One leading paragraph per item. Anything richer — a code block inside a
      // bullet, a second paragraph — is structure the flat writer would not put
      // back, so the whole list is preserved instead.
      if (child.type !== 'paragraph' || seenParagraph) return null;
      const inline = inlineToMarkdown(child.content);
      if (inline === null || inline.includes('\n')) return null;
      rendered.push(`${indent}${marker}${inline}`);
      seenParagraph = true;
    }

    if (rendered.length === 0) rendered.push(`${indent}${marker}`);
    items.push(rendered.join('\n'));
    n += 1;
  }

  return items.join('\n');
}

/** One top-level block to markdown, or null when it must be preserved instead. */
function blockToMarkdown(node: AdfLike): string | null {
  if (!node.type || !KNOWN_BLOCKS.has(node.type)) return null;

  switch (node.type) {
    case 'paragraph': {
      const inline = inlineToMarkdown(node.content);
      if (inline === null) return null;
      return inline.split('\n').map(escapeBlockStart).join('\n');
    }

    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      if (!Number.isInteger(level) || level < 1 || level > 6) return null;
      const inline = inlineToMarkdown(node.content);
      if (inline === null || inline.includes('\n')) return null;
      return `${'#'.repeat(level)} ${inline}`.trimEnd();
    }

    case 'codeBlock': {
      const language = node.attrs?.['language'];
      if (language !== undefined && language !== null && typeof language !== 'string') return null;
      const parts = (node.content ?? []).map((child) => (child.type === 'text' ? (child.text ?? '') : null));
      if (parts.some((part) => part === null)) return null;
      const body = parts.join('');
      // A fence inside the body would close the block early on the way back.
      if (/^\s*```/m.test(body)) return null;
      return `\`\`\`${typeof language === 'string' ? language : ''}\n${body}\n\`\`\``;
    }

    case 'blockquote': {
      const lines: string[] = [];
      for (const child of node.content ?? []) {
        if (child.type !== 'paragraph') return null;
        const inline = inlineToMarkdown(child.content);
        if (inline === null) return null;
        if (lines.length > 0) lines.push('');
        lines.push(...inline.split('\n'));
      }
      return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
    }

    case 'rule':
      return '---';

    case 'bulletList':
    case 'orderedList':
      return listToMarkdown(node, node.type === 'orderedList', '');

    default:
      return null;
  }
}

/**
 * The whole document to markdown, plus the blocks it had to hold aside.
 *
 * Blocks are separated by a blank line, which is what makes the parse below
 * unambiguous: inside a block a newline is a hard break, between blocks it is a
 * boundary.
 */
export function adfToMarkdown(raw: unknown): AdfMarkdown {
  const doc = parseAdf(raw);
  if (!doc) return { text: '', preserved: [] };

  const blocks: string[] = [];
  const preserved: AdfPreservedBlock[] = [];

  for (const node of doc.content ?? []) {
    const markdown = blockToMarkdown(node);
    if (markdown !== null) {
      blocks.push(markdown);
      continue;
    }
    const kind = kindOf(node);
    const token = tokenFor(preserved.length, kind);
    preserved.push({ token, kind, node, media: collectMedia(node) });
    blocks.push(token);
  }

  return { text: blocks.join('\n\n'), preserved };
}

/**
 * A reading rendering, for anywhere that shows a description rather than edits
 * one. Preserved blocks are named rather than shown as tokens.
 */
export function adfToText(raw: unknown): string {
  const { text, preserved } = adfToMarkdown(raw);
  return preserved.reduce((acc, block) => acc.replace(block.token, `[${block.kind}]`), text);
}

// --- write: markdown -> ADF ---------------------------------------------------

function unescapeInline(text: string): string {
  return text.replace(/\\([\\`*_~[\]])/g, '$1');
}

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

function textNode(text: string, marks: readonly Mark[]): AdfNode {
  const node: AdfNode = { type: 'text', text };
  if (marks.length > 0) {
    node.marks = marks.map((mark) => (mark.attrs ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }));
  }
  return node;
}

/** Inline markdown to ADF text nodes. */
function markdownToInline(source: string): AdfNode[] {
  const out: AdfNode[] = [];

  const push = (value: string, marks: readonly Mark[]): void => {
    if (!value) return;
    const node = textNode(value, marks);
    const last = out[out.length - 1];
    // Adjacent runs with identical marks are one node in Jira's own output, and
    // matching that is what makes an untouched description round-trip byte for
    // byte instead of re-splitting a little more on every save.
    if (last?.type === 'text' && JSON.stringify(last.marks ?? null) === JSON.stringify(node.marks ?? null)) {
      last.text = (last.text ?? '') + value;
      return;
    }
    out.push(node);
  };

  const scan = (input: string, marks: readonly Mark[]): void => {
    let buffer = '';
    let i = 0;

    const emit = (): void => {
      push(unescapeInline(buffer), marks);
      buffer = '';
    };

    while (i < input.length) {
      const rest = input.slice(i);

      if (rest.startsWith('\\') && i + 1 < input.length) {
        buffer += input.slice(i, i + 2);
        i += 2;
        continue;
      }

      if (rest.startsWith('\n')) {
        emit();
        out.push({ type: 'hardBreak' });
        i += 1;
        continue;
      }

      // Code first: nothing inside a code span is formatting.
      const codeEnd = rest.startsWith('`') ? rest.indexOf('`', 1) : -1;
      if (codeEnd > 0) {
        emit();
        /*
         * `code` is exclusive in ADF — everything except a link is dropped, and
         * Jira does not merely ignore the extras, it refuses the whole document
         * with `INVALID_INPUT` and no indication of which node it disliked.
         *
         * Bold around a code span is ordinary markdown (`**\`null\`**`) and
         * someone will type it, so the writer resolves it rather than emitting a
         * doc the API rejects. This also keeps the two directions agreeing: the
         * reader already refuses to render a code span carrying a second mark.
         */
        push(rest.slice(1, codeEnd), [...marks.filter((mark) => mark.type === 'link'), { type: 'code' }]);
        i += codeEnd + 1;
        continue;
      }

      const link = /^\[((?:\\.|[^\\\]])*)\]\(([^()\s]+)\)/.exec(rest);
      if (link) {
        emit();
        scan(link[1] ?? '', [...marks, { type: 'link', attrs: { href: link[2]! } }]);
        i += link[0].length;
        continue;
      }

      const wrapper = ([
        ['**', 'strong'],
        ['~~', 'strike'],
        ['*', 'em'],
      ] as const).find(([delimiter]) => rest.startsWith(delimiter) && rest.indexOf(delimiter, delimiter.length) > 0);

      if (wrapper) {
        const [delimiter, type] = wrapper;
        const end = rest.indexOf(delimiter, delimiter.length);
        emit();
        scan(rest.slice(delimiter.length, end), [...marks, { type }]);
        i += end + delimiter.length;
        continue;
      }

      buffer += input[i];
      i += 1;
    }

    emit();
  };

  scan(source, []);
  return out;
}

function paragraphNode(text: string): AdfNode {
  const content = markdownToInline(text);
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** `AdfNode` has no `attrs`, and widening the write helper's type for one field
 *  here would let every machine-authored comment grow attributes too. */
function withAttrs(node: AdfNode, attrs: Record<string, unknown>): AdfNode {
  return { ...node, ...({ attrs } as object) };
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```(\S*)\s*$/;
const RULE = /^(?:---+|\*\*\*+|___+)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED = /^([ \t]*)\d+[.)][ \t]+(.*)$/;

function startsBlock(line: string): boolean {
  return (
    TOKEN.test(line) ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    RULE.test(line.trim())
  );
}

interface ListLine {
  indent: number;
  ordered: boolean;
  text: string;
}

/** Nested lists from a run of item lines, grouped by indent width. */
function buildList(lines: readonly ListLine[], start: number, indent: number): { node: AdfNode; next: number } {
  const first = lines[start]!;
  const items: AdfNode[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent || line.ordered !== first.ordered) break;

    const item: AdfNode = { type: 'listItem', content: [paragraphNode(line.text)] };
    i += 1;

    if (i < lines.length && lines[i]!.indent > indent) {
      const nested = buildList(lines, i, lines[i]!.indent);
      item.content!.push(nested.node);
      i = nested.next;
    }
    items.push(item);
  }

  return { node: { type: first.ordered ? 'orderedList' : 'bulletList', content: items }, next: i };
}

export interface MarkdownToAdfResult {
  doc: AdfNode;
  /** Placeholder tokens in the text that no map entry answered for. */
  unresolved: string[];
}

/**
 * Markdown back to ADF, with preserved blocks spliced in by token.
 *
 * An unanswerable token is reported rather than dropped or written out as
 * literal text: it means the description changed underneath the editor, and the
 * only safe response is to refuse the write and say so.
 */
export function markdownToAdf(text: string, preserved: readonly AdfPreservedBlock[] = []): MarkdownToAdfResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content: AdfNode[] = [];
  const unresolved: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const token = TOKEN.exec(line);
    if (token) {
      const block = preserved[Number(token[1])];
      if (block && block.token === line.trim()) content.push(block.node as AdfNode);
      else unresolved.push(line.trim());
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence, or the end of the text
      let node: AdfNode = { type: 'codeBlock' };
      if (fence[1]) node = withAttrs(node, { language: fence[1] });
      if (body.length > 0) node.content = [{ type: 'text', text: body.join('\n') }];
      content.push(node);
      continue;
    }

    if (RULE.test(line.trim())) {
      content.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const inline = markdownToInline(heading[2] ?? '');
      const node = withAttrs({ type: 'heading' }, { level: heading[1]!.length });
      if (inline.length > 0) node.content = inline;
      content.push(node);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const paragraphs: string[] = [];
      let buffer: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        const inner = QUOTE.exec(lines[i]!)?.[1] ?? '';
        if (inner.trim() === '') {
          if (buffer.length > 0) paragraphs.push(buffer.join('\n'));
          buffer = [];
        } else {
          buffer.push(inner);
        }
        i += 1;
      }
      if (buffer.length > 0) paragraphs.push(buffer.join('\n'));
      content.push({ type: 'blockquote', content: paragraphs.map(paragraphNode) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const items: ListLine[] = [];
      while (i < lines.length) {
        const ordered = ORDERED.exec(lines[i]!);
        const match = ordered ?? BULLET.exec(lines[i]!);
        if (!match) break;
        items.push({
          indent: (match[1] ?? '').replace(/\t/g, '  ').length,
          ordered: ordered !== null,
          text: match[2] ?? '',
        });
        i += 1;
      }
      const built = buildList(items, 0, items[0]!.indent);
      content.push(built.node);
      continue;
    }

    // A paragraph: every line up to a blank one or the start of another block.
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      if (body.length > 0 && startsBlock(lines[i]!)) break;
      // `\- not a list` was escaped on the way out; put the character back.
      body.push(lines[i]!.replace(/^\\/, ''));
      i += 1;
    }
    content.push(paragraphNode(body.join('\n')));
  }

  return { doc: adfDoc(...content), unresolved };
}
