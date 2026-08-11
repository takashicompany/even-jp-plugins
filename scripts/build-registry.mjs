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
 * Issue Formが生成する `### 見出し` 区切りのMarkdownを { 見出し: 値 } に分解する。
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseIssueBody(body) {
  const sections = {};
  if (typeof body !== 'string') return sections;

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
    if (m) {
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
 * @param {string} value
 * @returns {boolean}
 */
export function isValidHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
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
  if (name.length > LIMITS.name) {
    return { error: `「${FIELD_LABELS.name}」が${LIMITS.name}文字を超えています (${name.length}文字)` };
  }

  if (!url) return { error: `「${FIELD_LABELS.url}」が見つからないか空です` };
  if (!isValidHttpUrl(url)) {
    return { error: `「${FIELD_LABELS.url}」が http(s) の絶対URLではありません` };
  }

  if (!description) return { error: `「${FIELD_LABELS.description}」が見つからないか空です` };
  if (description.length > LIMITS.description) {
    return {
      error: `「${FIELD_LABELS.description}」が${LIMITS.description}文字を超えています (${description.length}文字)`,
    };
  }

  if (author && author.length > LIMITS.author) {
    return { error: `「${FIELD_LABELS.author}」が${LIMITS.author}文字を超えています (${author.length}文字)` };
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
 * label=plugin / state=open のIssueをページネーション対応で全件取得する。
 * @param {{ token: string, repository: string }} options
 * @returns {Promise<object[]>}
 */
export async function fetchIssues({ token, repository }) {
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const perPage = 100;
  const all = [];

  for (let page = 1; page <= 100; page++) {
    const url = new URL(`${apiBase}/repos/${repository}/issues`);
    url.searchParams.set('labels', 'plugin');
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'created');
    url.searchParams.set('direction', 'asc');

    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'even-jp-plugins-registry-builder',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch)) {
      throw new Error('GitHub API error: unexpected response shape');
    }
    all.push(...batch);
    if (batch.length < perPage) break;
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
