# Compile Targets Explorer

`compile_commands.json` に基づいて、コンパイル対象のファイルのみをエクスプローラーのツリービューに表示する VS Code 拡張機能です。

## 機能

- **コンパイル対象ファイルの表示**: `compile_commands.json` に記載されたファイルをフォルダ階層付きでエクスプローラーに表示
- **ヘッダーファイルの自動収集**: `#include` を再帰的に辿り、関連ヘッダーをツリーに追加
- **ファイルを直接開く**: ツリー上のファイルをクリックするとエディタで開きます
- **自動リフレッシュ**: `compile_commands.json` の変更を検知して自動更新
- **手動リフレッシュ**: ビューのタイトルバーにあるリフレッシュボタンで手動更新
- **compile_commands.json の自動検出**: clangd設定、CMake設定、CMakePresetsから自動的にパスを解決

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
| `compileTargetsExplorer.showHeaders` | `true` | コンパイルコマンドの -I パスからヘッダーファイルを収集して表示する |
| `compileTargetsExplorer.headerExtensions` | `[".h", ".hpp", ".hxx", ".hh"]` | ヘッダーファイルとして認識する拡張子のリスト |

## 使い方

1. プロジェクトで `compile_commands.json` を生成します:
   ```bash
   cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
   ```
2. エクスプローラーサイドバーに「**Compile Targets**」ビューが表示されます
