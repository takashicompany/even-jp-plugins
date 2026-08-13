# even-jp-plugins

Even Hub プラグインのレジストリです。GitHub の Issue を立てるだけでプラグインを登録できます。
登録された内容は `registry.json` に自動でまとめられ、一覧として配信されます。

## 登録方法

1. このリポジトリの Issues タブから「New issue」を選びます。
2. 「プラグイン登録」テンプレートを選びます。
3. プラグイン名・プラグインのURL・説明（作者名は任意）を入力して Issue を作成します。
4. Issue が作られると自動処理が走り、数十秒ほどで `registry.json` に反映されます。

入力のルール:

- プラグインのURL: `https://` または `http://` から始まる絶対URLのみ
- プラグイン名: 100文字以内
- 説明: 500文字以内
- 作者名: 未入力の場合は Issue 投稿者の GitHub アカウント名が使われます

ルールを満たさない Issue は一覧に載りません。反映されない場合は Actions の実行ログにスキップ理由が出ています。

## ホスティングの条件（CORS必須）

「イーブン」はプラグインの HTML を `fetch(url, { mode: "cors" })` で取得して起動します。
そのためホスティング側が `Access-Control-Allow-Origin` レスポンスヘッダを返さないと、HTML を読み込めず起動できません。

必要な条件:

- 登録URLが `2xx` を返し、`Content-Type` が `text/html` であること
- その応答に `Access-Control-Allow-Origin` があること
- HTML が読み込む同一オリジンの JS（`<script type="module" src="...">`）の応答にも `Access-Control-Allow-Origin` があること
- リダイレクトしている場合、**各リダイレクト応答（301/302 など）自体**にも `Access-Control-Allow-Origin` があること

サービス別:

- **GitHub Pages** … 対応不要。既定で `Access-Control-Allow-Origin: *` を返します。
  ただし `xxx.github.io` から独自ドメインへのリダイレクト応答にはヘッダが付かないため、リダイレクト後の最終的なURLを登録してください。
- **Cloudflare Workers（静的アセット配信）** … 既定ではヘッダが付きません。
  静的アセットのディレクトリ（Wrangler でアセットディレクトリに指定しているフォルダ。Vite などを使う場合は `public/`）に `_headers` を置きます。

  ```
  /*
    Access-Control-Allow-Origin: *
  ```

  参考: https://developers.cloudflare.com/workers/static-assets/headers/
  （Worker のコードでレスポンスを生成している場合は `_headers` ではなく Response のヘッダに直接付けます）
- **Netlify** … 公開ディレクトリ（publish directory）に `_headers` を置きます。内容は上と同じです。
  `netlify.toml` に書く場合:

  ```toml
  [[headers]]
    for = "/*"
    [headers.values]
      Access-Control-Allow-Origin = "*"
  ```

  参考: https://docs.netlify.com/manage/routing/headers/

### 自動チェック

`registry.json` の生成時に、登録された各URLへ実際に `Origin` 付きの GET を投げて上記を確認します。
タイムアウト（既定10秒）は失敗扱いです。

チェックに失敗しても **一覧からは消えません**。代わりに `description` の先頭に `【エラー: 理由】` が付いた状態で配信され、
Even Hub のプラグイン詳細画面にそのまま表示されます。

あわせて、該当の Issue に直し方の案内が自動でコメントされます（未解決の間は1回だけ）。
設定を直してから Issue 本文を編集して保存すると再チェックが走り、解消していればエラー表記が外れて「✅ 解決を確認しました」がコメントされます。

## 内容の編集方法

登録済みの Issue の本文を編集してください。編集を保存すると `registry.json` が自動で更新されます。
新しく Issue を立て直す必要はありません。

## 取り下げ方法

自分が立てた Issue を close してください。close された Issue は一覧から自動的に削除されます。
再登録したい場合は同じ Issue を reopen してください。

## registry.json の取得

```
https://raw.githubusercontent.com/takashicompany/even-jp-plugins/main/registry.json
```

形式:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-11T00:00:00.000Z",
  "plugins": [
    {
      "issue": 1,
      "name": "プラグイン名",
      "url": "https://example.com/my-plugin/",
      "description": "説明",
      "author": "作者名",
      "githubUser": "Issue投稿者のGitHubアカウント名",
      "createdAt": "2026-08-01T00:00:00Z",
      "updatedAt": "2026-08-02T00:00:00Z",
      "bodyUpdatedAt": "2026-08-02T00:00:00Z"
    }
  ]
}
```

`plugins` は `bodyUpdatedAt`（Issue 本文の最終編集日時）が新しい順に並びます。
つまり Issue 本文を編集すると一覧の先頭に来ます。コメントの追加や close / reopen では順番は変わりません。
本文を一度も編集していない場合は Issue の作成日時が使われます。日時が同じ場合は Issue 番号の大きい方が先です。

- `updatedAt`（各プラグイン） … Issue の更新日時。コメント等でも動きます
- `bodyUpdatedAt` … 本文の最終編集日時。並び順に使われます
- `description` … URL の自動チェックに失敗している場合、先頭に `【エラー: 理由】` が付きます

## 仕組み

- `.github/ISSUE_TEMPLATE/register-plugin.yml` — 登録用の Issue フォーム（`plugin` ラベルが自動で付きます）
- `scripts/build-registry.mjs` — `plugin` ラベルが付いた open な Issue を GraphQL API で集めて `registry.json` を生成（本文の最終編集日時は GraphQL でしか取得できないため）
- `scripts/cors-check.mjs` — 登録URLの CORS 自動チェックと、Issue へ投稿するコメントの組み立て
- `.github/workflows/registry.yml` — Issue の作成・編集・close 等をきっかけに上記を実行し、差分があればコミット

Issue フォームは `plugin` ラベルを自動で付けますが、これはリポジトリに `plugin` ラベルが存在していることが前提です
（GitHub の Issue Forms は存在しないラベルを作成しません）。ラベルを消さないでください。

ローカルでテストを実行する場合:

```
node scripts/test-parse.mjs
node scripts/test-cors.mjs
```

環境変数:

- `SKIP_URL_CHECK=1` … 登録URLの自動チェックを省略する
- `SKIP_ISSUE_COMMENTS=1` … チェック結果の Issue コメント投稿を省略する
- `CORS_CHECK_TIMEOUT_MS` … 1リクエストあたりのタイムアウト（既定 10000）
- `CORS_CHECK_ORIGIN` … チェック時に送る `Origin` ヘッダ
