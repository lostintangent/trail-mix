import { expect, test } from 'bun:test';
import { foldKey, readFolds } from './folds.ts';

const saved = (value: string | null) => ({ getItem: () => value });

test('an account and its folders fold apart, even where a path looks like another’s key', () => {
  const keys = [
    foldKey({ account: 'personal' }),
    foldKey({ account: 'personal', path: 'Projects' }),
    foldKey({ account: 'personal', path: '["personal"]' }),
    foldKey({ account: 'work', path: 'Projects' }),
  ];

  expect(new Set(keys).size).toBe(keys.length);
});

test('what a device saved comes back, and anything else saved leaves everything unfolded', () => {
  const projects = foldKey({ account: 'personal', path: 'Projects' });

  expect([...readFolds(saved(JSON.stringify([projects])))]).toEqual([projects]);
  for (const value of [null, 'not json', '{"Projects":true}', '[1, null]']) {
    expect([...readFolds(saved(value))]).toEqual([]);
  }
});
