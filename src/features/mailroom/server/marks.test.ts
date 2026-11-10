import { expect, test } from 'bun:test';
import { foldForSearch, highlight, marksOf, type Envelope } from '../../mail/core/index.ts';
import { envelopeIndex } from './envelope-index.ts';
import { testSql } from './test-sql.ts';

/**
 * The index and the list's highlighter read a search the same way: the index finds a row exactly
 * when every word typed marks something in it. Both are checked against the index's own tokenizer,
 * not against each other's code.
 */

/** Letters and digits of the scripts mail is mostly written in, and the forms that trip folding. */
const RANGES = [
  [0x30, 0x7a],
  [0xaa, 0x24f],
  [0x370, 0x3ff],
  [0x400, 0x4ff],
  [0x1e00, 0x1eff],
  [0x1f00, 0x1fff],
  [0x2100, 0x214f],
  [0xfb00, 0xfb06],
  [0xff10, 0xff5a],
] as const;

test('every letter and digit folds as the index stores it', () => {
  const sql = testSql();
  const letters: string[] = [];
  for (const [first, last] of RANGES) {
    for (let code = first; code <= last; code++) {
      const char = String.fromCodePoint(code);
      if (/[\p{L}\p{N}]/u.test(char)) letters.push(char);
    }
  }
  letters.forEach((char, at) =>
    sql.run(
      `INSERT INTO search (rowid, senders, recipients, subject, preview) VALUES (?, '', '', ?, '')`,
      at + 1,
      char,
    ),
  );
  sql.run(`CREATE VIRTUAL TABLE terms USING fts5vocab(search, 'instance')`);
  const stored = new Map(
    sql
      .all<{ term: string; doc: number }>(`SELECT term, doc FROM terms`)
      .map(({ term, doc }) => [doc, term]),
  );

  expect(letters.filter((char, at) => foldForSearch(char) !== stored.get(at + 1))).toEqual([]);
});

/** Subjects that each test one way folding can go wrong. */
const SUBJECTS = [
  'Café on Friday',
  'Naïve plans',
  'ﬁle cabinet',
  'Straße works',
  'ΣΟΦΙΑ notes',
  'Σοφός',
  'Йод and иод',
  'İstanbul trip',
  'Ångström units',
  'Łódź visit',
  'Œuvre complète',
  'Ａｂｃ fullwidth',
  'Résumé review',
  'Ørsted',
  'Don’t panic',
  'Ǣsir and Ǽ',
  'µ-law codec',
  '東京 meetup',
];

/** Searches across those subjects, matching some and narrowly missing others. */
const SEARCHES = [
  'cafe',
  'CAFÉ fri',
  'naive',
  'file',
  'ﬁle',
  'straß',
  'strasse',
  'σοφ',
  'ς',
  'и',
  'й',
  'istanbul',
  'i',
  'angstrom',
  'lodz',
  'łodz',
  'oeuvre',
  'œuv compl',
  'abc',
  'ａｂｃ',
  'resume rev',
  'orsted',
  'ørs',
  'don t',
  'ǣ',
  'æsir',
  'μ law',
  'µ',
  '東',
  'friday panic',
];

test('the index finds a row exactly when every word typed is marked in it', () => {
  const store = envelopeIndex(testSql());
  store.listFolders('personal', [
    { account: 'personal', path: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: 0 },
  ]);
  store.fold(
    SUBJECTS.map((subject, at) => ({ type: 'message', envelope: envelope(subject, at + 1) })),
  );

  const disagree: string[] = [];
  for (const search of SEARCHES) {
    const found = new Set(store.search(search).items.map(({ subject }) => subject));
    for (const subject of SUBJECTS) {
      const isMarked = marksOf(search).every((mark) =>
        highlight(subject, [mark]).some((run) => run.isMarked),
      );
      if (found.has(subject) !== isMarked) {
        disagree.push(
          `"${search}" in "${subject}": index ${found.has(subject)}, marks ${isMarked}`,
        );
      }
    }
  }
  expect(disagree).toEqual([]);
});

/** A message whose only searchable words are its subject's. */
function envelope(subject: string, uid: number): Envelope {
  return {
    account: 'personal',
    path: 'INBOX',
    uidValidity: 1,
    uid,
    messageId: `<${uid}@zz.zz>`,
    references: [],
    from: { email: 'zz@zz.zz' },
    to: [],
    cc: [],
    subject,
    date: `2026-11-09T12:00:${String(uid).padStart(2, '0')}.000Z`,
    preview: '',
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
  };
}
