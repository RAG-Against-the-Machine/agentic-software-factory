import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adfToMarkdown, adfToText, markdownToAdf, parseAdf } from './adf.js';

/**
 * The round-trip contract, stated as tests because it is the only thing keeping
 * somebody's description safe.
 *
 * The important assertion in most of these is not "the markdown looks right" —
 * it is `roundTrip(doc)` deep-equalling `doc`. A converter that reads well and
 * writes back something subtly different is the failure mode this module was
 * written to end, and only a structural comparison catches it.
 */

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text });

/** Read to markdown, write straight back, and hand back what Jira would store. */
function roundTrip(input: unknown): unknown {
  const { text, preserved } = adfToMarkdown(input);
  const { doc: out, unresolved } = markdownToAdf(text, preserved);
  assert.deepEqual(unresolved, [], 'a preserved block went unresolved on an untouched document');
  return out;
}

test('a plain paragraph survives', () => {
  const input = doc(p(t('Turn on the flag tonight.')));
  assert.equal(adfToMarkdown(input).text, 'Turn on the flag tonight.');
  assert.deepEqual(roundTrip(input), input);
});

test('headings keep their level instead of becoming sentences', () => {
  const input = doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('What')] },
    p(t('Turn on the flag.')),
    { type: 'heading', attrs: { level: 3 }, content: [t('Why')] },
  );
  assert.equal(adfToMarkdown(input).text, '## What\n\nTurn on the flag.\n\n### Why');
  assert.deepEqual(roundTrip(input), input);
});

test('bullet lists stay lists rather than paragraphs starting with a hyphen', () => {
  const input = doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [p(t('4031'))] },
      { type: 'listItem', content: [p(t('2468'))] },
    ],
  });
  assert.equal(adfToMarkdown(input).text, '- 4031\n- 2468');
  assert.deepEqual(roundTrip(input), input);
});

test('nested and ordered lists keep their indentation', () => {
  const input = doc({
    type: 'orderedList',
    content: [
      {
        type: 'listItem',
        content: [
          p(t('Enable the flag')),
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [p(t('office 4031'))] }],
          },
        ],
      },
      { type: 'listItem', content: [p(t('Verify'))] },
    ],
  });
  assert.equal(adfToMarkdown(input).text, '1. Enable the flag\n   - office 4031\n2. Verify');
  assert.deepEqual(roundTrip(input), input);
});

test('inline marks and links come back with their attributes', () => {
  const input = doc(
    p(
      t('See '),
      t('SWL-53', [{ type: 'link', attrs: { href: 'https://jira.example/browse/SWL-53' } }]),
      t(' — '),
      t('do not', [{ type: 'strong' }]),
      t(' ship '),
      t('yet', [{ type: 'em' }]),
      t(', run '),
      t('make check', [{ type: 'code' }]),
      t(' first.'),
    ),
  );
  assert.equal(
    adfToMarkdown(input).text,
    'See [SWL-53](https://jira.example/browse/SWL-53) — **do not** ship *yet*, run `make check` first.',
  );
  assert.deepEqual(roundTrip(input), input);
});

test('bold around a code span writes code alone, because ADF will not take both', () => {
  /*
   * Ordinary markdown, and Jira's answer to `[{strong},{code}]` on one text node
   * is a 400 INVALID_INPUT for the entire document with no clue which node did
   * it. Cost a comment post to find. The link mark is the one that may stay.
   */
  const { doc: out } = markdownToAdf('The **`null`** case and a [**`link`**](https://example.test).');
  const marks = JSON.stringify(out).match(/"type":"(strong|code|link)"/g) ?? [];
  assert.deepEqual(marks, ['"type":"code"', '"type":"link"', '"type":"code"']);
});

test('code blocks keep their language and their contents verbatim', () => {
  const input = doc({
    type: 'codeBlock',
    attrs: { language: 'bash' },
    content: [t('flags enable epms-usability --office 4031\n# not a heading')],
  });
  assert.equal(adfToMarkdown(input).text, '```bash\nflags enable epms-usability --office 4031\n# not a heading\n```');
  assert.deepEqual(roundTrip(input), input);
});

test('blockquotes and rules survive', () => {
  const input = doc({ type: 'blockquote', content: [p(t('Rollback is one flag change.'))] }, { type: 'rule' });
  assert.equal(adfToMarkdown(input).text, '> Rollback is one flag change.\n\n---');
  assert.deepEqual(roundTrip(input), input);
});

test('hard breaks stay inside their paragraph', () => {
  const input = doc(p(t('first'), { type: 'hardBreak' }, t('second')));
  assert.equal(adfToMarkdown(input).text, 'first\nsecond');
  assert.deepEqual(roundTrip(input), input);
});

test('a paragraph that looks like markdown is escaped and unescaped', () => {
  const input = doc(p(t('- not a list')), p(t('# not a heading')), p(t('a * b _ c [d]')));
  assert.equal(adfToMarkdown(input).text, '\\- not a list\n\n\\# not a heading\n\na \\* b \\_ c \\[d\\]');
  assert.deepEqual(roundTrip(input), input);
});

// --- the part that matters: nothing is ever rewritten -------------------------

const TABLE = {
  type: 'table',
  attrs: { isNumberColumnEnabled: false, layout: 'default' },
  content: [
    {
      type: 'tableRow',
      content: [
        { type: 'tableHeader', attrs: {}, content: [p(t('Office ID'))] },
        { type: 'tableCell', attrs: {}, content: [p(t('4031'))] },
      ],
    },
  ],
};

test('a table is preserved verbatim, not flattened', () => {
  const input = doc(p(t('Offices:')), TABLE, p(t('Targeted rollout.')));
  const { text, preserved } = adfToMarkdown(input);

  assert.equal(text, 'Offices:\n\n⟦jira-block-0: table⟧\n\nTargeted rollout.');
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0]?.kind, 'table');
  assert.deepEqual(roundTrip(input), input);
});

test('an edit around a preserved block leaves the block untouched', () => {
  const input = doc(p(t('Offices:')), TABLE);
  const { preserved } = adfToMarkdown(input);

  const edited = markdownToAdf('## Offices\n\n⟦jira-block-0: table⟧\n\nAdded a line.', preserved);
  assert.deepEqual(edited.unresolved, []);
  assert.deepEqual(edited.doc.content?.[1], TABLE);
  assert.equal(edited.doc.content?.[0]?.type, 'heading');
});

test('deleting the placeholder deletes the block, because that is what was asked', () => {
  const { preserved } = adfToMarkdown(doc(TABLE));
  const edited = markdownToAdf('Just words now.', preserved);

  assert.deepEqual(edited.unresolved, []);
  assert.equal(edited.doc.content?.length, 1);
  assert.equal(edited.doc.content?.[0]?.type, 'paragraph');
});

test('a placeholder the map cannot answer is reported rather than dropped', () => {
  // What a concurrent edit in Jira looks like: the drawer still holds a token
  // for a block the issue no longer has.
  const { preserved } = adfToMarkdown(doc(p(t('no blocks here'))));
  const edited = markdownToAdf('⟦jira-block-0: table⟧', preserved);

  assert.deepEqual(edited.unresolved, ['⟦jira-block-0: table⟧']);
});

test('formatting the converter has no spelling for preserves its whole block', () => {
  // An underlined word, a coloured word, a status lozenge: markdown cannot say
  // any of them, so the paragraph is held aside rather than half-written.
  for (const node of [
    p(t('mostly plain '), t('underlined', [{ type: 'underline' }])),
    p(t('red', [{ type: 'textColor', attrs: { color: '#ff5630' } }])),
    p(t('state: '), { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }),
  ]) {
    const input = doc(node);
    const { preserved } = adfToMarkdown(input);
    assert.equal(preserved.length, 1, `expected ${JSON.stringify(node)} to be preserved`);
    assert.deepEqual(roundTrip(input), input);
  }
});

test('an unknown node type from a future Jira is preserved, not discarded', () => {
  const input = doc({ type: 'somethingAtlassianShipsNextYear', attrs: { id: 7 }, content: [p(t('hi'))] });
  const { preserved } = adfToMarkdown(input);

  assert.equal(preserved.length, 1);
  assert.deepEqual(roundTrip(input), input);
});

// --- edges --------------------------------------------------------------------

test('an empty or absent description is empty, not a broken document', () => {
  assert.equal(adfToMarkdown(null).text, '');
  assert.equal(adfToMarkdown(undefined).text, '');
  assert.deepEqual(markdownToAdf('').doc, { type: 'doc', version: 1, content: [] });
});

test('a bare string description, which Jira still sends on some sites, is read', () => {
  assert.equal(adfToMarkdown('line one\nline two').text, 'line one\n\nline two');
  assert.equal(parseAdf('x')?.type, 'doc');
});

test('adfToText names preserved blocks instead of showing tokens', () => {
  assert.equal(adfToText(doc(p(t('before')), TABLE)), 'before\n\n[table]');
});
