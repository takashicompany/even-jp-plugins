#!/usr/bin/env node
// build-registry.mjs のパース／検証ロジックのテスト。
// 実行: node scripts/test-parse.mjs

import assert from 'node:assert/strict';
import { parseIssueBody, buildEntry, buildPlugins, isValidHttpUrl } from './build-registry.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

// GitHub Issue Forms が実際に生成する本文の形（見出し + 空行 + 値 + 空行）
const validBody = [
  '### プラグイン名',
  '',
  'My Awesome Plugin',
  '',
  '### プラグインのURL',
  '',
  'https://example.com/my-plugin/',
  '',
  '### 説明',
  '',
  'Even G1/G2 向けのタイマープラグインです。',
  '複数行の説明にも対応します。',
  '',
  '### 作者名',
  '',
  'takashicompany',
].join('\n');

const noAuthorBody = validBody.replace('takashicompany', '_No response_');

function issue(overrides = {}) {
  return {
    number: 1,
    body: validBody,
    user: { login: 'octocat' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

test('parseIssueBody: 4つの見出しを抽出できる', () => {
  const sections = parseIssueBody(validBody);
  assert.equal(sections['プラグイン名'], 'My Awesome Plugin');
  assert.equal(sections['プラグインのURL'], 'https://example.com/my-plugin/');
  assert.equal(
    sections['説明'],
    'Even G1/G2 向けのタイマープラグインです。\n複数行の説明にも対応します。',
  );
  assert.equal(sections['作者名'], 'takashicompany');
});

test('parseIssueBody: CRLF 改行でも動く', () => {
  const sections = parseIssueBody(validBody.replace(/\n/g, '\r\n'));
  assert.equal(sections['プラグイン名'], 'My Awesome Plugin');
  assert.equal(sections['作者名'], 'takashicompany');
});

test('buildEntry: 正常系', () => {
  const result = buildEntry(issue({ number: 12 }));
  assert.ok('entry' in result, JSON.stringify(result));
  assert.deepEqual(result.entry, {
    issue: 12,
    name: 'My Awesome Plugin',
    url: 'https://example.com/my-plugin/',
    description: 'Even G1/G2 向けのタイマープラグインです。\n複数行の説明にも対応します。',
    author: 'takashicompany',
    githubUser: 'octocat',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
  });
});

test('buildEntry: 作者名が _No response_ ならGitHubアカウント名を使う', () => {
  const result = buildEntry(issue({ body: noAuthorBody }));
  assert.ok('entry' in result);
  assert.equal(result.entry.author, 'octocat');
});

test('buildEntry: URLが相対パスならエラー', () => {
  const body = validBody.replace('https://example.com/my-plugin/', '/my-plugin/');
  const result = buildEntry(issue({ body }));
  assert.ok('error' in result);
});

test('buildEntry: javascript: スキームはエラー', () => {
  const body = validBody.replace('https://example.com/my-plugin/', 'javascript:alert(1)');
  const result = buildEntry(issue({ body }));
  assert.ok('error' in result);
});

test('buildEntry: プラグイン名が空ならエラー', () => {
  const body = validBody.replace('My Awesome Plugin', '');
  const result = buildEntry(issue({ body }));
  assert.ok('error' in result);
});

test('buildEntry: プラグイン名が100文字超ならエラー', () => {
  const body = validBody.replace('My Awesome Plugin', 'あ'.repeat(101));
  const result = buildEntry(issue({ body }));
  assert.ok('error' in result);
});

test('buildEntry: プラグイン名がちょうど100文字ならOK', () => {
  const body = validBody.replace('My Awesome Plugin', 'あ'.repeat(100));
  const result = buildEntry(issue({ body }));
  assert.ok('entry' in result);
});

test('buildEntry: 説明が500文字超ならエラー', () => {
  const body = validBody.replace(
    'Even G1/G2 向けのタイマープラグインです。\n複数行の説明にも対応します。',
    'あ'.repeat(501),
  );
  const result = buildEntry(issue({ body }));
  assert.ok('error' in result);
});

test('buildEntry: 本文が空ならエラー', () => {
  const result = buildEntry(issue({ body: '' }));
  assert.ok('error' in result);
});

test('buildEntry: 本文がnullでもクラッシュしない', () => {
  const result = buildEntry(issue({ body: null }));
  assert.ok('error' in result);
});

test('isValidHttpUrl: http/https のみ許可', () => {
  assert.equal(isValidHttpUrl('https://example.com'), true);
  assert.equal(isValidHttpUrl('http://example.com'), true);
  assert.equal(isValidHttpUrl('ftp://example.com'), false);
  assert.equal(isValidHttpUrl('data:text/html,hi'), false);
  assert.equal(isValidHttpUrl('example.com'), false);
});

test('buildPlugins: Issue番号昇順・不正はスキップ・PRは除外', () => {
  const skipped = [];
  const plugins = buildPlugins(
    [
      issue({ number: 30 }),
      issue({ number: 10 }),
      issue({ number: 20, body: 'ただのテキスト' }),
      issue({ number: 40, pull_request: { url: 'https://example.com' } }),
    ],
    (m) => skipped.push(m),
  );
  assert.deepEqual(plugins.map((p) => p.issue), [10, 30]);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].includes('#20'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
