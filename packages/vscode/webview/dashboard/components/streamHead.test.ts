// t-qi09w0 item 4 — the flowing streaming colour. Nothing here asserts a
// COLOUR: this suite loads no <style> and jsdom has no layout, so a computed
// colour would be '' whatever the code did. What is decidable, and what a
// careless split gets wrong, is WHERE the cut lands and whether the reply
// survives it intact.
import { describe, expect, it } from 'vitest';
import { HEAD_CLASS, HEAD_WORDS, markStreamHead, splitStreamHead } from './streamHead';

/** The one invariant that matters: a split never loses or invents text. */
function rejoins(text: string, words?: number) {
  const { body, head } = splitStreamHead(text, words);
  expect(body + head).toBe(text);
  return { body, head };
}

describe('splitStreamHead — the newest words ride at the head', () => {
  it('hands the last four words to the head and everything before to the body', () => {
    const { body, head } = rejoins('the model has written quite a lot of prose by now');
    expect(head).toBe('of prose by now');
    expect(body).toBe('the model has written quite a lot ');
  });

  it('cuts on a WORD boundary, never inside a word', () => {
    const { body, head } = rejoins('alpha beta gamma delta epsilon zeta');
    expect(head.startsWith(' ')).toBe(false);
    expect(body.endsWith(' ')).toBe(true);
    expect(head.split(/\s+/)).toHaveLength(HEAD_WORDS);
  });

  it('a reply shorter than the head is ALL head — the first words are blue too', () => {
    const { body, head } = rejoins('just started');
    expect(body).toBe('');
    expect(head).toBe('just started');
  });

  it('nothing to colour in an empty or blank reply', () => {
    expect(splitStreamHead('')).toEqual({ body: '', head: '' });
    expect(splitStreamHead('   \n ')).toEqual({ body: '   \n ', head: '' });
  });

  it('the head stays on the LAST line, so it never welds two blocks together', () => {
    const { body, head } = rejoins('# A heading\n\nand then the prose starts here');
    expect(body).toBe('# A heading\n\nand then ');
    expect(head).toBe('the prose starts here');
  });

  it('the head follows the text as it grows — the colour flows, it does not wait', () => {
    const a = splitStreamHead('one two three four five').head;
    const b = splitStreamHead('one two three four five six').head;
    expect(a).toBe('two three four five');
    expect(b).toBe('three four five six');
  });
});

describe('splitStreamHead — the markdown must survive the cut', () => {
  it('a code span at the boundary is swallowed WHOLE, never cut in half', () => {
    // The span holds SPACES, so counting four words back lands between its
    // backticks. Cut there and marked sees one opening backtick in the body and
    // the closing one inside the span: a stray backtick and a literal <span> in
    // the reader's prose. The cut must move back to before the span.
    // (A single-word span needs no rule — the cut falls on its backtick anyway.)
    const text = 'please run `npm run typecheck now` and report';
    const { body, head } = rejoins(text);
    expect(body).toBe('please run ');
    expect(head).toBe('`npm run typecheck now` and report');
    // The proof, stated as the defect: backticks balance on both sides.
    expect((body.match(/`/g) ?? []).length % 2).toBe(0);
    expect((head.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('a code span still being typed is swallowed too — the open backtick stays in the head', () => {
    // A span with spaces in it, so the four-word cut really does land inside one
    // that has no closing backtick yet. The head must start AT the backtick.
    const { body, head } = rejoins('ok now `git worktree list --porcelain extra');
    expect(body).toBe('ok now ');
    expect(head).toBe('`git worktree list --porcelain extra');
  });

  it('a code span the head clears entirely is left alone in the body', () => {
    const { head } = rejoins('read `foo.ts` and then say something useful about it');
    expect(head).toBe('something useful about it');
  });

  it('bold at the boundary is swallowed whole — the same failure as a code span', () => {
    // Cut between the ** pairs and marked renders four literal asterisks in the
    // reader's prose. The ticket named code spans; bold breaks identically.
    const { body, head } = rejoins('the answer is **quite a lot more** than that');
    expect(body).toBe('the answer is ');
    expect(head).toBe('**quite a lot more** than that');
  });

  it('a link label at the boundary is swallowed whole too', () => {
    const { body, head } = rejoins('see [the full release notes](https://x/y) for it');
    expect(body).toBe('see ');
    expect(head).toBe('[the full release notes](https://x/y) for it');
  });

  it('inside an open fence there is no head at all — a tag there is code, not markup', () => {
    const text = 'here is the patch\n\n```ts\nconst a = 1;\nconst b = 2;';
    expect(splitStreamHead(text)).toEqual({ body: text, head: '' });
  });

  it('once the fence CLOSES the head comes back on the prose after it', () => {
    const { head } = rejoins('```ts\nconst a = 1;\n```\n\nthat is the whole change here');
    expect(head).toBe('the whole change here');
  });
});

describe('markStreamHead — what the renderer is handed', () => {
  it('wraps only the head, leaving the body as plain markdown', () => {
    expect(markStreamHead('alpha beta gamma delta epsilon', true))
      .toBe(`alpha <span class="${HEAD_CLASS}">beta gamma delta epsilon</span>`);
  });

  it('a settled reply is handed back UNTOUCHED — nothing is left blue', () => {
    const text = 'alpha beta gamma delta epsilon';
    expect(markStreamHead(text, false)).toBe(text);
  });

  it('no safe cut means no tag rather than a tag in the wrong place', () => {
    const text = 'here it is\n\n```ts\nconst a = 1;';
    expect(markStreamHead(text, true)).toBe(text);
  });
});
