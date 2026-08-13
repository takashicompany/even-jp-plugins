#!/usr/bin/env node
// 登録URLのCORS自動チェック。
//
// 「イーブン」はプラグインのHTMLを fetch(url, { mode: "cors" }) で取得して起動するため、
// ホスティングが Access-Control-Allow-Origin を返さないと起動できない。
// HTML本体だけでなく、HTMLが読み込むJSアセットにも同じヘッダが必要で、
// リダイレクトしている場合は各ホップの応答にも必要になる。
//
// このファイルはネットワークI/Oを注入可能にしてあり（options.fetch）、テストからモックできる。

export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_REDIRECTS = 10;
export const DEFAULT_ORIGIN = 'https://even-jp-plugins.invalid';
const USER_AGENT = 'even-jp-plugins-registry-builder';

// botコメントの種別を後から判定するための隠しマーカー
export const COMMENT_MARKER_NG = '<!-- even-jp-plugins-cors-check: ng -->';
export const COMMENT_MARKER_OK = '<!-- even-jp-plugins-cors-check: ok -->';

/**
 * Access-Control-Allow-Origin ヘッダが存在するか。
 * @param {Headers} headers
 * @returns {boolean}
 */
export function hasAcao(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  const value = headers.get('access-control-allow-origin');
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * HTMLから最初の同一オリジンな <script src> を探して絶対URLで返す。
 * 見つからなければ null。
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string | null}
 */
export function findFirstSameOriginScript(html, baseUrl) {
  if (typeof html !== 'string') return null;

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const tagRe = /<script\b([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const attrs = match[1];
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    if (!srcMatch) continue;
    const raw = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim();
    if (raw === '') continue;

    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    // 別オリジンのCDN等はプラグイン作者が直せないことが多いので対象外にする
    if (resolved.origin !== base.origin) continue;
    return resolved.toString();
  }
  return null;
}

function isTimeoutError(err) {
  if (!err) return false;
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return /timeout|timed out|aborted/i.test(message);
}

function errorText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * リダイレクトを1ホップずつ辿り、各ホップの応答にACAOがあるか検証する。
 * @returns {Promise<{ ok: true, response: Response, finalUrl: string, hops: object[] }
 *                   | { ok: false, reason: string, detail: string, hops: object[] }>}
 */
async function fetchChain(startUrl, ctx, label) {
  const hops = [];
  let current = startUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let res;
    try {
      res = await ctx.fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Origin: ctx.origin,
          Accept: '*/*',
          'User-Agent': USER_AGENT,
        },
        signal: ctx.createSignal(),
      });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      return {
        ok: false,
        reason: timedOut ? `${label}への接続がタイムアウトしました` : `${label}に接続できません`,
        detail: timedOut
          ? `${current} が ${ctx.timeoutMs}ms 以内に応答しませんでした`
          : `${current} への接続に失敗しました: ${errorText(err)}`,
        hops,
      };
    }

    const status = typeof res.status === 'number' ? res.status : 0;
    const acao = hasAcao(res.headers);
    hops.push({ url: current, status, acao });

    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;

    if (status >= 300 && status < 400 && location) {
      // リダイレクト応答自体にもACAOが必要（例: GitHub Pages の独自ドメインへの301には付かない）
      if (!acao) {
        return {
          ok: false,
          reason: `${label}のリダイレクト応答がCORS未対応のため起動できません`,
          detail: `${current} が HTTP ${status} を返しましたが、この応答に Access-Control-Allow-Origin がありません（転送先: ${location}）`,
          hops,
        };
      }
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return {
          ok: false,
          reason: `${label}のリダイレクト先URLが不正です`,
          detail: `${current} の Location ヘッダ "${location}" を解決できませんでした`,
          hops,
        };
      }
      current = next;
      continue;
    }

    return { ok: true, response: res, finalUrl: current, hops };
  }

  return {
    ok: false,
    reason: `${label}のリダイレクトが多すぎます`,
    detail: `${startUrl} から ${MAX_REDIRECTS} 回を超えてリダイレクトしました`,
    hops,
  };
}

/**
 * 登録URLをチェックする。
 * @param {string} url
 * @param {{ fetch?: typeof fetch, origin?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: string, scriptUrl?: string | null, hops: object[] }>}
 */
export async function checkUrlCors(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx = {
    fetchImpl: options.fetch ?? globalThis.fetch,
    origin: options.origin ?? DEFAULT_ORIGIN,
    timeoutMs,
    createSignal: () =>
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
  };

  const page = await fetchChain(url, ctx, 'URL');
  if (!page.ok) {
    return { ok: false, reason: page.reason, detail: page.detail, hops: page.hops };
  }

  const res = page.response;
  const status = res.status;

  if (!(status >= 200 && status < 300)) {
    return {
      ok: false,
      reason: `URLが HTTP ${status} を返します`,
      detail: `${page.finalUrl} が HTTP ${status} を返しました。公開されているURLか確認してください`,
      hops: page.hops,
    };
  }

  const contentType = (res.headers.get('content-type') ?? '').trim();
  if (!/^text\/html\b/i.test(contentType)) {
    return {
      ok: false,
      reason: 'URLがHTMLを返していません',
      detail: `${page.finalUrl} の Content-Type が "${contentType || '(なし)'}" です。プラグインのHTMLのURLを登録してください`,
      hops: page.hops,
    };
  }

  if (!hasAcao(res.headers)) {
    return {
      ok: false,
      reason: 'ホスティングがCORS未対応のため起動できません',
      detail: `${page.finalUrl} の応答に Access-Control-Allow-Origin がありません（HTML本体）`,
      hops: page.hops,
    };
  }

  let html = '';
  try {
    html = await res.text();
  } catch (err) {
    return {
      ok: false,
      reason: 'URLの内容を読み取れません',
      detail: `${page.finalUrl} の本文取得に失敗しました: ${errorText(err)}`,
      hops: page.hops,
    };
  }

  const scriptUrl = findFirstSameOriginScript(html, page.finalUrl);
  if (!scriptUrl) {
    return { ok: true, scriptUrl: null, hops: page.hops };
  }

  const asset = await fetchChain(scriptUrl, ctx, 'JSアセット');
  if (!asset.ok) {
    return { ok: false, reason: asset.reason, detail: asset.detail, scriptUrl, hops: [...page.hops, ...asset.hops] };
  }

  const assetRes = asset.response;
  const hops = [...page.hops, ...asset.hops];

  if (!(assetRes.status >= 200 && assetRes.status < 300)) {
    return {
      ok: false,
      reason: `JSアセットが HTTP ${assetRes.status} を返します`,
      detail: `${asset.finalUrl} が HTTP ${assetRes.status} を返しました`,
      scriptUrl,
      hops,
    };
  }

  if (!hasAcao(assetRes.headers)) {
    return {
      ok: false,
      reason: 'JSアセットがCORS未対応のため起動できません',
      detail: `${asset.finalUrl} の応答に Access-Control-Allow-Origin がありません（HTMLが読み込むJS）`,
      scriptUrl,
      hops,
    };
  }

  return { ok: true, scriptUrl, hops };
}

/**
 * チェック結果を description の先頭に反映する。
 * @param {string} description
 * @param {{ ok: boolean, reason?: string }} result
 * @returns {string}
 */
export function applyCheckResultToDescription(description, result) {
  if (!result || result.ok) return description;
  const reason = result.reason ?? 'URLのチェックに失敗しました';
  return `【エラー: ${reason}】${description}`;
}

/**
 * コメント本文からbotコメントの種別を判定する。
 * @param {string} body
 * @returns {'ng' | 'ok' | null}
 */
export function classifyBotComment(body) {
  if (typeof body !== 'string') return null;
  if (body.includes(COMMENT_MARKER_NG)) return 'ng';
  if (body.includes(COMMENT_MARKER_OK)) return 'ok';
  return null;
}

/**
 * 既存コメント列から、最後のbotコメントの種別を求める。
 * @param {{ body?: string }[]} comments
 * @returns {'ng' | 'ok' | null}
 */
export function lastBotCommentKind(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const kind = classifyBotComment(comments[i] && comments[i].body);
    if (kind) return kind;
  }
  return null;
}

/**
 * 今回コメントを投稿すべきか決める。
 * - NGのまま（前回もNG）… 投稿しない
 * - 新規/再発のNG … NGコメントを投稿
 * - NGから解決 … 解決コメントを投稿
 * - もともとOK … 投稿しない
 * @param {'ng' | 'ok' | null} lastKind
 * @param {boolean} ok
 * @returns {'ng' | 'ok' | null}
 */
export function decideComment(lastKind, ok) {
  if (ok) return lastKind === 'ng' ? 'ok' : null;
  return lastKind === 'ng' ? null : 'ng';
}

/**
 * NG時に投稿するコメント本文。
 * @param {{ url: string, result: { reason?: string, detail?: string, hops?: object[] } }} params
 * @returns {string}
 */
export function buildNgComment({ url, result }) {
  const hopLines = (result.hops ?? []).map(
    (hop) => `  - HTTP ${hop.status} ${hop.url} … Access-Control-Allow-Origin: ${hop.acao ? 'あり' : 'なし'}`,
  );

  return [
    COMMENT_MARKER_NG,
    '## ⚠️ 登録URLの自動チェックに失敗しました',
    '',
    'このIssueで登録されたプラグインは一覧からは消えていませんが、説明の先頭にエラー表記が付いた状態で配信されています。',
    '',
    `- 対象URL: ${url}`,
    `- 判定: ${result.reason ?? '不明'}`,
    `- 詳細: ${result.detail ?? '不明'}`,
    ...(hopLines.length > 0 ? ['- 実際の応答:', ...hopLines] : []),
    '',
    '### なぜCORSが必要か',
    '',
    '「イーブン」はプラグインのHTMLをブラウザ上で `fetch(url, { mode: "cors" })` して取り込む方式で起動します。',
    'そのためホスティングが `Access-Control-Allow-Origin` レスポンスヘッダを返さないと、HTMLを読み込めず起動できません。',
    'HTML本体だけでなく、HTMLが読み込む `<script type="module" src="...">` のJSファイルにも同じヘッダが必要です。',
    'また、リダイレクトしている場合はリダイレクト応答（301/302など）自体にもヘッダが必要です。',
    '',
    'ホスティング側を直したうえでこのIssueの本文を編集して保存すると、次回の自動生成で反映されます。',
  ].join('\n');
}

/**
 * 解決を検出したときに投稿するコメント本文。
 * @param {{ url: string }} params
 * @returns {string}
 */
export function buildOkComment({ url }) {
  return [
    COMMENT_MARKER_OK,
    '## ✅ 解決を確認しました',
    '',
    `登録URL ${url} の自動チェックが通りました。`,
    '`registry.json` のエラー表記は外れ、通常の説明で配信されます。',
    '',
    'ご対応ありがとうございました。',
  ].join('\n');
}
