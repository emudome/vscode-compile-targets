# Compile Targets Explorer

A VS Code extension that displays only compilation target files in the Explorer tree view, based on `compile_commands.json`.

## Features

- **Display Compile Target Files**: Shows files listed in `compile_commands.json` with their folder hierarchy in the Explorer
- **Automatic Header Collection**: Recursively follows `#include` directives and adds related headers to the tree
- **Open Files Directly**: Click a file in the tree to open it in the editor
- **Auto Refresh**: Automatically updates when `compile_commands.json` changes
- **Manual Refresh**: Manually update via the refresh button in the view title bar
- **Auto-detection of compile_commands.json**: Automatically resolves the path from clangd settings, CMake settings, and CMakePresets
- **Favorites**: Pin frequently accessed files and folders for quick access

## compile_commands.json Detection Order

The extension auto-detects `compile_commands.json` in the following priority order:

1. `--compile-commands-dir` in `clangd.arguments`
2. `CompileFlags.CompilationDatabase` in the `.clangd` file
3. `cmake.buildDirectory` setting (with variable expansion support)
4. `binaryDir` of the active preset in `CMakePresets.json` / `CMakeUserPresets.json`
5. `${workspaceFolder}/build`
6. `${workspaceFolder}` (workspace root)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `compileTargetsExplorer.excludePatterns` | `[]` | Glob patterns for files to exclude from the tree (e.g., `**/compiler/**`) |

## Favorites

Files and folders can be pinned to the **Favorites** section at the top of the tree for quick access.

- **Add**: Right-click a file or folder → **Add to Favorites**
- **Remove**: Right-click an item in the Favorites section → **Remove from Favorites**
- **Open file**: Click a favorite file to open it in the editor
- **Jump to folder**: Click a favorite folder to reveal it in the tree

Favorites are saved per workspace and persist across sessions.

## Usage

1. Generate `compile_commands.json` in your project:
   ```bash
   cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
   ```
2. The "**Compile Targets**" view will appear in the Explorer sidebar
