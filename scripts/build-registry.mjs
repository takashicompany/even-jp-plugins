#!/usr/bin/env node
// Even Hub プラグインレジストリ生成スクリプト
//
// label=plugin かつ state=open のIssueをGitHub REST APIで全件取得し、
// Issue Formが生成したMarkdown本文をパースして registry.json を出力する。
//
// Issue本文は一切シェルに渡さず、すべてこのNodeプロセス内で処理する。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIELD_LABELS = {
  name: 'プラグイン名',
  url: 'プラグインのURL',
  description: '説明',
  author: '作者名',
};

export const LIMITS = {
  name: 100,
  description: 500,
  author: 100,
};

const NO_RESPONSE = new Set(['_No response_', '_不明_', '_なし_']);

/**
 * 文字数を数える（絵文字などのサロゲートペアを1文字として数える）。
 * @param {string} value
 * @returns {number}
 */
export function countChars(value) {
  return Array.from(value).length;
}

/**
 * Issue Formが生成する `### 見出し` 区切りのMarkdownを { 見出し: 値 } に分解する。
 * 見出しとして扱うのは knownLabels に含まれるものだけ。
 * こうしないと説明欄にユーザーが書いた `### 何か` で本文が途切れてしまう。
 * @param {string} body
 * @param {string[]} knownLabels
 * @returns {Record<string, string>}
 */
export function parseIssueBody(body, knownLabels = Object.values(FIELD_LABELS)) {
  const sections = {};
  if (typeof body !== 'string') return sections;

  const known = new Set(knownLabels);

  // 改行コードを正規化（CRLF / CR）
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  let currentKey = null;
  let buffer = [];

  const flush = () => {
    if (currentKey === null) return;
    const value = buffer.join('\n').trim();
    // 同じ見出しが複数ある場合は最初のものを優先する
    if (!(currentKey in sections)) sections[currentKey] = value;
    buffer = [];
  };

  for (const line of lines) {
    const m = /^###\s+(.*\S)\s*$/.exec(line);
    if (m && known.has(m[1].trim())) {
      flush();
      currentKey = m[1].trim();
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * 値を正規化する。未入力（_No response_）や空文字は null を返す。
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function normalizeValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (NO_RESPONSE.has(trimmed)) return null;
  return trimmed;
}

/**
 * http(s) の絶対URLかどうかを判定する。
 * `https:example.com` のようにホスト名を欠くものは不正扱いにする。
 * @param {string} value
 * @returns {boolean}
 */
export function isValidHttpUrl(value) {
  // 先頭が http:// または https:// であることを明示的に要求する
  if (!/^https?:\/\//i.test(value)) return false;
  // 空白や制御文字を含むURLは受け付けない
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  return true;
}

/**
 * Issueオブジェクトからレジストリのエントリを作る。
 * 不正な場合は { error } を返す。
 * @param {object} issue
 * @returns {{ entry: object } | { error: string }}
 */
export function buildEntry(issue) {
  const sections = parseIssueBody(issue.body);

  const name = normalizeValue(sections[FIELD_LABELS.name]);
  const url = normalizeValue(sections[FIELD_LABELS.url]);
  const description = normalizeValue(sections[FIELD_LABELS.description]);
  const author = normalizeValue(sections[FIELD_LABELS.author]);

  if (!name) return { error: `「${FIELD_LABELS.name}」が見つからないか空です` };
  const nameLength = countChars(name);
  if (nameLength > LIMITS.name) {
    return { error: `「${FIELD_LABELS.name}」が${LIMITS.name}文字を超えています (${nameLength}文字)` };
  }

  if (!url) return { error: `「${FIELD_LABELS.url}」が見つからないか空です` };
  if (!isValidHttpUrl(url)) {
    return { error: `「${FIELD_LABELS.url}」が http(s) の絶対URLではありません` };
  }

  if (!description) return { error: `「${FIELD_LABELS.description}」が見つからないか空です` };
  const descriptionLength = countChars(description);
  if (descriptionLength > LIMITS.description) {
    return {
      error: `「${FIELD_LABELS.description}」が${LIMITS.description}文字を超えています (${descriptionLength}文字)`,
    };
  }

  if (author && countChars(author) > LIMITS.author) {
    return {
      error: `「${FIELD_LABELS.author}」が${LIMITS.author}文字を超えています (${countChars(author)}文字)`,
    };
  }

  const githubUser = issue.user && typeof issue.user.login === 'string' ? issue.user.login : null;

  return {
    entry: {
      issue: issue.number,
      name,
      url,
      description,
      author: author ?? githubUser,
      githubUser,
      createdAt: issue.created_at ?? null,
      updatedAt: issue.updated_at ?? null,
    },
  };
}

/**
 * Issueの配列からレジストリを組み立てる。スキップ理由は onSkip に渡す。
 * @param {object[]} issues
 * @param {(message: string) => void} onSkip
 * @returns {object[]}
 */
export function buildPlugins(issues, onSkip = () => {}) {
  const plugins = [];
  for (const issue of issues) {
    // Pull Request は issues API にも含まれるため除外する
    if (issue.pull_request) continue;

    const result = buildEntry(issue);
    if ('error' in result) {
      onSkip(`skip: #${issue.number} - ${result.error}`);
      continue;
    }
    plugins.push(result.entry);
  }
  plugins.sort((a, b) => a.issue - b.issue);
  return plugins;
}

/**
 * Link ヘッダーから rel="next" のURLを取り出す。
 * @param {string | null} header
 * @returns {string | null}
 */
export function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (!m) continue;
    if (/rel\s*=\s*"?next"?/i.test(m[2])) return m[1];
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * レート制限・一時障害に対して上限付きで再試行するfetch。
 */
async function requestWithRetry(url, token, attempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'even-jp-plugins-registry-builder',
        },
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      res = null;
    }

    if (res && res.ok) return res;

    if (res) {
      // 403はレート制限のときだけ再試行する（権限不足は即エラーにする）
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 &&
          (res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0'));
      const retryable = rateLimited || res.status >= 500;
      if (!retryable || attempt === attempts) {
        const text = await res.text().catch(() => '');
        throw new Error(`GitHub API error: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let waitMs = 2000 * attempt;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = Math.min(retryAfter * 1000, 60000);
      } else if (Number.isFinite(reset) && reset > 0) {
        waitMs = Math.min(Math.max(reset * 1000 - Date.now(), 0) + 1000, 60000);
      }
      console.log(`APIが ${res.status} を返しました。${Math.round(waitMs / 1000)}秒待って再試行します`);
      await sleep(waitMs);
      continue;
    }

    if (attempt === attempts) throw lastError ?? new Error('GitHub API request failed');
    await sleep(2000 * attempt);
  }

  throw lastError ?? new Error('GitHub API request failed');
}

/**
 * label=plugin / state=open のIssueをページネーション対応で全件取得する。
 * Link ヘッダーの rel="next" を辿るため、件数の上限を切り捨てで見落とすことはない。
 * @param {{ token: string, repository: string }} options
 * @returns {Promise<object[]>}
 */
export async function fetchIssues({ token, repository }) {
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const MAX_PAGES = 500;
  const all = [];

  const first = new URL(`${apiBase}/repos/${repository}/issues`);
  first.searchParams.set('labels', 'plugin');
  first.searchParams.set('state', 'open');
  first.searchParams.set('per_page', '100');
  first.searchParams.set('sort', 'created');
  first.searchParams.set('direction', 'asc');

  let next = first.toString();

  for (let page = 1; next; page++) {
    if (page > MAX_PAGES) {
      // 途中で打ち切ったregistryを正常扱いで書き出さないため、必ずエラーにする
      throw new Error(`ページ数が上限(${MAX_PAGES})を超えました。全件取得に失敗しています`);
    }

    const res = await requestWithRetry(next, token);
    const batch = await res.json();
    if (!Array.isArray(batch)) {
      throw new Error('GitHub API error: unexpected response shape');
    }
    all.push(...batch);
    next = parseNextLink(res.headers.get('link'));
  }

  return all;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!token) {
    console.error('GITHUB_TOKEN が設定されていません');
    process.exit(1);
  }
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    console.error('GITHUB_REPOSITORY が設定されていないか形式が不正です (owner/repo)');
    process.exit(1);
  }

  const issues = await fetchIssues({ token, repository });
  console.log(`取得したIssue: ${issues.length}件`);

  const plugins = buildPlugins(issues, (message) => console.log(message));
  console.log(`登録されたプラグイン: ${plugins.length}件`);

  const outPath = path.resolve(process.cwd(), 'registry.json');

  // 中身が変わっていない場合は updatedAt を据え置き、無意味なコミットを防ぐ
  let previous = null;
  try {
    previous = JSON.parse(await readFile(outPath, 'utf8'));
  } catch {
    previous = null;
  }

  const unchanged =
    previous &&
    previous.schemaVersion === 1 &&
    typeof previous.updatedAt === 'string' &&
    JSON.stringify(previous.plugins) === JSON.stringify(plugins);

  const registry = {
    schemaVersion: 1,
    updatedAt: unchanged ? previous.updatedAt : new Date().toISOString(),
    plugins,
  };

  await writeFile(outPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  console.log(`書き出しました: ${outPath}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
