# CMake Compile Explorer

`compile_commands.json` に基づいて、コンパイル対象のファイルのみをエクスプローラーのツリービューに表示する VS Code 拡張機能です。

## 機能

- **コンパイル対象ファイルの表示**: `compile_commands.json` に記載されたファイルをフォルダ階層付きでエクスプローラーに表示
- **ファイルを直接開く**: ツリー上のファイルをクリックするとエディタで開きます
- **自動リフレッシュ**: `compile_commands.json` の変更を検知して自動更新
- **手動リフレッシュ**: ビューのタイトルバーにあるリフレッシュボタンで手動更新

## 設定

| 設定名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `cmakeCompileExplorer.compileCommandsDir` | `build` | `compile_commands.json` が存在するディレクトリ（ワークスペースルートからの相対パス、または絶対パス） |

## 使い方

1. CMake プロジェクトで `compile_commands.json` を生成します:
   ```bash
   cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
   ```
2. VS Code の設定で `cmakeCompileExplorer.compileCommandsDir` に `compile_commands.json` があるディレクトリを指定します（デフォルト: `build`）
3. エクスプローラーサイドバーに「**Compile Targets**」ビューが表示されます
