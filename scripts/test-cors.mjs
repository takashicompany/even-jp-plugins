#!/usr/bin/env node
// 登録URLのCORS自動チェックのテスト。ネットワークはモックする。
// 実行: node scripts/test-cors.mjs

import assert from 'node:assert/strict';
import {
  applyCheckResultToDescription,
  buildNgComment,
  buildOkComment,
  checkUrlCors,
  classifyBotComment,
  COMMENT_MARKER_NG,
  COMMENT_MARKER_OK,
  decideComment,
  findFirstSameOriginScript,
  hasAcao,
  lastBotCommentKind,
} from './cors-check.mjs';
import { annotatePlugins } from './build-registry.mjs';

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

/** ルーティングテーブルからモックfetchを作る */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (route === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (route === 'network-error') throw new TypeError('fetch failed');
    return {
      status: route.status ?? 200,
      headers: new Headers(route.headers ?? {}),
      text: async () => route.body ?? '',
    };
  };
  return { fetchImpl, calls };
}

const CORS_HTML = { headers: { 'content-type': 'text/html', 'access-control-allow-origin': '*' } };

function html(scriptSrc) {
  return `<!doctype html><html><head><script type="module" crossorigin src="${scriptSrc}"></script></head><body></body></html>`;
}

test('hasAcao: ヘッダの有無を判定する', () => {
  assert.equal(hasAcao(new Headers({ 'access-control-allow-origin': '*' })), true);
  assert.equal(hasAcao(new Headers({ 'Access-Control-Allow-Origin': 'https://example.com' })), true);
  assert.equal(hasAcao(new Headers({})), false);
  assert.equal(hasAcao(null), false);
});

test('findFirstSameOriginScript: 相対URLを解決する', () => {
  const found = findFirstSameOriginScript(
    html('./assets/index-abc.js'),
    'https://example.com/plugins/hello/',
  );
  assert.equal(found, 'https://example.com/plugins/hello/assets/index-abc.js');
});

test('findFirstSameOriginScript: 絶対パスも解決する', () => {
  const found = findFirstSameOriginScript(html('/assets/index.js'), 'https://example.com/a/b/');
  assert.equal(found, 'https://example.com/assets/index.js');
});

test('findFirstSameOriginScript: 別オリジンのscriptは対象外', () => {
  const body = [
    '<script src="https://cdn.example.net/lib.js"></script>',
    '<script src="/own.js"></script>',
  ].join('');
  assert.equal(findFirstSameOriginScript(body, 'https://example.com/'), 'https://example.com/own.js');
});

test('findFirstSameOriginScript: src の無いインラインscriptは飛ばす', () => {
  const body = '<script>console.log(1)</script><script src="app.js"></script>';
  assert.equal(findFirstSameOriginScript(body, 'https://example.com/x/'), 'https://example.com/x/app.js');
});

test('findFirstSameOriginScript: シングルクォート・クォート無しも読める', () => {
  assert.equal(
    findFirstSameOriginScript(`<script src='a.js'></script>`, 'https://example.com/'),
    'https://example.com/a.js',
  );
  assert.equal(
    findFirstSameOriginScript(`<script src=b.js></script>`, 'https://example.com/'),
    'https://example.com/b.js',
  );
});

test('findFirstSameOriginScript: scriptが無ければ null', () => {
  assert.equal(findFirstSameOriginScript('<html><body>hi</body></html>', 'https://example.com/'), null);
});

test('checkUrlCors: HTMLもJSもCORS対応なら ok', async () => {
  const { fetchImpl, calls } = mockFetch({
    'https://example.com/p/': { ...CORS_HTML, body: html('./assets/index.js') },
    'https://example.com/p/assets/index.js': {
      headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' },
    },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scriptUrl, 'https://example.com/p/assets/index.js');
  assert.equal(calls.length, 2);
  // Origin ヘッダを付けてGETしている
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(calls[0].init.headers.Origin);
});

test('checkUrlCors: scriptが無くてもHTMLがOKなら ok', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': { ...CORS_HTML, body: '<html><body>hi</body></html>' },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.scriptUrl, null);
});

test('checkUrlCors: HTMLにACAOが無ければ ng', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': { headers: { 'content-type': 'text/html' }, body: html('./a.js') },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ホスティングがCORS未対応のため起動できません');
});

test('checkUrlCors: JSアセットにACAOが無ければ ng', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': { ...CORS_HTML, body: html('./assets/index.js') },
    'https://example.com/p/assets/index.js': { headers: { 'content-type': 'application/javascript' } },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'JSアセットがCORS未対応のため起動できません');
});

test('checkUrlCors: リダイレクト応答にACAOが無ければ ng', async () => {
  const { fetchImpl } = mockFetch({
    'https://old.example.com/p/': {
      status: 301,
      headers: { location: 'https://new.example.com/p/', 'content-type': 'text/html' },
    },
    'https://new.example.com/p/': { ...CORS_HTML, body: '<html></html>' },
  });
  const result = await checkUrlCors('https://old.example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('リダイレクト応答'), result.reason);
});

test('checkUrlCors: リダイレクト応答にACAOがあれば追跡して判定する', async () => {
  const { fetchImpl } = mockFetch({
    'https://old.example.com/p/': {
      status: 301,
      headers: { location: '/moved/', 'access-control-allow-origin': '*' },
    },
    'https://old.example.com/moved/': { ...CORS_HTML, body: '<html></html>' },
  });
  const result = await checkUrlCors('https://old.example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.hops.length, 2);
});

test('checkUrlCors: 2xx以外は ng', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': { status: 404, headers: { 'content-type': 'text/html', 'access-control-allow-origin': '*' } },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('404'), result.reason);
});

test('checkUrlCors: Content-Typeがtext/htmlでなければ ng', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'URLがHTMLを返していません');
});

test('checkUrlCors: text/html; charset=utf-8 は許容する', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/p/': {
      headers: { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' },
      body: '<html></html>',
    },
  });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('checkUrlCors: タイムアウトは失敗扱い', async () => {
  const { fetchImpl } = mockFetch({ 'https://example.com/p/': 'timeout' });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl, timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('タイムアウト'), result.reason);
});

test('checkUrlCors: 接続失敗は失敗扱い', async () => {
  const { fetchImpl } = mockFetch({ 'https://example.com/p/': 'network-error' });
  const result = await checkUrlCors('https://example.com/p/', { fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('接続できません'), result.reason);
});

test('applyCheckResultToDescription: NGなら先頭にエラー表記を付ける', () => {
  assert.equal(
    applyCheckResultToDescription('元の説明', { ok: false, reason: 'ホスティングがCORS未対応のため起動できません' }),
    '【エラー: ホスティングがCORS未対応のため起動できません】元の説明',
  );
  assert.equal(applyCheckResultToDescription('元の説明', { ok: true }), '元の説明');
});

test('classifyBotComment / lastBotCommentKind: 最後のbotコメント種別を取る', () => {
  assert.equal(classifyBotComment(`${COMMENT_MARKER_NG}\nこんにちは`), 'ng');
  assert.equal(classifyBotComment(`${COMMENT_MARKER_OK}\nこんにちは`), 'ok');
  assert.equal(classifyBotComment('ただのコメント'), null);
  assert.equal(lastBotCommentKind([]), null);
  assert.equal(
    lastBotCommentKind([{ body: COMMENT_MARKER_NG }, { body: '人間のコメント' }, { body: COMMENT_MARKER_OK }]),
    'ok',
  );
  assert.equal(
    lastBotCommentKind([{ body: COMMENT_MARKER_OK }, { body: COMMENT_MARKER_NG }, { body: '人間のコメント' }]),
    'ng',
  );
});

test('decideComment: NGは未解決の間1回だけ、解決も1回だけ', () => {
  // 初回NG
  assert.equal(decideComment(null, false), 'ng');
  // NGのまま（重複投稿しない）
  assert.equal(decideComment('ng', false), null);
  // 解決を検出
  assert.equal(decideComment('ng', true), 'ok');
  // 解決のまま（重複投稿しない）
  assert.equal(decideComment('ok', true), null);
  // 再NG
  assert.equal(decideComment('ok', false), 'ng');
  // もともとOK
  assert.equal(decideComment(null, true), null);
});

test('buildNgComment: マーカー・URL・検出結果・CORSの説明を含む', () => {
  const body = buildNgComment({
    url: 'https://example.com/p/',
    result: {
      reason: 'ホスティングがCORS未対応のため起動できません',
      detail: 'ACAOがありません',
      hops: [{ url: 'https://example.com/p/', status: 200, acao: false }],
    },
  });
  assert.ok(body.startsWith(COMMENT_MARKER_NG));
  assert.ok(body.includes('https://example.com/p/'));
  // 検出結果
  assert.ok(body.includes('ホスティングがCORS未対応のため起動できません'));
  assert.ok(body.includes('ACAOがありません'));
  assert.ok(body.includes('HTTP 200'));
  // なぜCORSが必要かの説明
  assert.ok(body.includes('なぜCORSが必要か'));
  assert.ok(body.includes('Access-Control-Allow-Origin'));
  // 再チェックの案内は1行だけ残す
  assert.ok(body.includes('本文を編集'));
  assert.ok(body.includes('次回の自動生成'));
});

test('buildNgComment: 具体的な直し方（各サービスの設定例）は含めない', () => {
  const body = buildNgComment({
    url: 'https://example.com/p/',
    result: { reason: 'ホスティングがCORS未対応のため起動できません', detail: '', hops: [] },
  });
  for (const forbidden of [
    '_headers',
    'Netlify',
    'netlify',
    'Cloudflare',
    'GitHub Pages',
    'netlify.toml',
    'wrangler',
    '直し方',
    'Access-Control-Allow-Origin: *',
  ]) {
    assert.ok(!body.includes(forbidden), `「${forbidden}」への言及が残っています`);
  }
});

test('buildOkComment: マーカーと解決文言を含む', () => {
  const body = buildOkComment({ url: 'https://example.com/p/' });
  assert.ok(body.startsWith(COMMENT_MARKER_OK));
  assert.ok(body.includes('✅ 解決を確認しました'));
  assert.ok(body.includes('https://example.com/p/'));
});

test('annotatePlugins: NGだけ説明を書き換え、一覧からは消さない', async () => {
  const plugins = [
    { issue: 1, url: 'https://ok.example.com/', description: 'OKなプラグイン' },
    { issue: 2, url: 'https://ng.example.com/', description: 'NGなプラグイン' },
  ];
  const results = await annotatePlugins(plugins, {
    check: async (url) =>
      url === 'https://ok.example.com/'
        ? { ok: true, hops: [] }
        : { ok: false, reason: 'ホスティングがCORS未対応のため起動できません', detail: '', hops: [] },
  });

  assert.equal(plugins.length, 2);
  assert.equal(plugins[0].description, 'OKなプラグイン');
  assert.equal(plugins[1].description, '【エラー: ホスティングがCORS未対応のため起動できません】NGなプラグイン');
  assert.equal(results.length, 2);
  assert.equal(results[1].result.ok, false);
});

test('annotatePlugins: 同じURLは1回しかチェックしない', async () => {
  const plugins = [
    { issue: 1, url: 'https://same.example.com/', description: 'A' },
    { issue: 2, url: 'https://same.example.com/', description: 'B' },
  ];
  let count = 0;
  await annotatePlugins(plugins, {
    check: async () => {
      count += 1;
      return { ok: true, hops: [] };
    },
  });
  assert.equal(count, 1);
});

test('annotatePlugins: チェックが例外を投げてもNG扱いで続行する', async () => {
  const plugins = [{ issue: 1, url: 'https://boom.example.com/', description: '説明' }];
  const results = await annotatePlugins(plugins, {
    check: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(results[0].result.ok, false);
  assert.ok(plugins[0].description.startsWith('【エラー: '));
});

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err instanceof Error ? err.stack : String(err)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
