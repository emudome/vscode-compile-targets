# Compile Targets Explorer

`compile_commands.json` に基づいて、コンパイル対象のファイルのみをエクスプローラーのツリービューに表示する VS Code 拡張機能です。

## 機能

- **コンパイル対象ファイルの表示**: `compile_commands.json` に記載されたファイルをフォルダ階層付きでエクスプローラーに表示
- **ヘッダーファイルの自動収集**: `#include` を再帰的に辿り、関連ヘッダーをツリーに追加
- **ファイルを直接開く**: ツリー上のファイルをクリックするとエディタで開きます
- **自動リフレッシュ**: `compile_commands.json` の変更を検知して自動更新
- **手動リフレッシュ**: ビューのタイトルバーにあるリフレッシュボタンで手動更新
- **compile_commands.json の自動検出**: clangd設定、CMake設定、CMakePresetsから自動的にパスを解決
- **お気に入り**: よくアクセスするファイルやフォルダをピン留めしてすばやく移動

## compile_commands.json の検出順序

以下の優先順位で `compile_commands.json` を自動検出します:

1. `clangd.arguments` の `--compile-commands-dir`
2. `.clangd` ファイルの `CompileFlags.CompilationDatabase`
3. `cmake.buildDirectory` 設定（変数展開対応）
4. `CMakePresets.json` / `CMakeUserPresets.json` のアクティブプリセットの `binaryDir`
5. `${workspaceFolder}/build`
6. `${workspaceFolder}`（ルート直下）

## 設定

| 設定名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `compileTargetsExplorer.excludePatterns` | `[]` | ツリーから除外するファイルの glob パターン（例: `**/compiler/**`） |

## お気に入り

ツリーの先頭にある **お気に入り** セクションに、よく使うファイルやフォルダをピン留めできます。

- **追加**: ファイルまたはフォルダを右クリック → **お気に入りに追加**
- **削除**: お気に入りセクションのアイテムを右クリック → **お気に入りから削除**
- **ファイルを開く**: お気に入りのファイルをクリックするとエディタで開きます
- **フォルダへ移動**: お気に入りのフォルダをクリックするとツリー上の該当フォルダへジャンプします

お気に入りはワークスペースごとに保存され、セッションをまたいで保持されます。

## 使い方

1. プロジェクトで `compile_commands.json` を生成します:
   ```bash
   cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
   ```
2. エクスプローラーサイドバーに「**コンパイル対象**」ビューが表示されます
