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
      "updatedAt": "2026-08-02T00:00:00Z"
    }
  ]
}
```

`plugins` は Issue 番号の昇順で並びます。

## 仕組み

- `.github/ISSUE_TEMPLATE/register-plugin.yml` — 登録用の Issue フォーム（`plugin` ラベルが自動で付きます）
- `scripts/build-registry.mjs` — `plugin` ラベルが付いた open な Issue を集めて `registry.json` を生成
- `.github/workflows/registry.yml` — Issue の作成・編集・close 等をきっかけに上記を実行し、差分があればコミット

ローカルでパース処理のテストを実行する場合:

```
node scripts/test-parse.mjs
```
