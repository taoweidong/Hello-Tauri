# AGENTS.md

## Project status

No source code exists yet. This repo currently contains only `design.md` (Chinese) — a complete architecture spec for a cross-platform log parsing tool.

## Planned stack

- **Frontend**: Vue 3 + TypeScript + Vite, Composition API with `<script setup>`
- **Desktop**: Tauri (Rust backend, WebView2)
- **Architecture**: Micro-kernel + plugin system; core logic in TS, Rust only for system-level bridging
- **Dual-target builds**: `vite build --mode web` (static site) vs `tauri build` (single .exe)
- **Platform switching**: Vite env var `VITE_PLATFORM=web|tauri` controls conditional imports of `WebAdapter` (WASM) vs `TauriAdapter` (Rust IPC)

## Key architecture decisions (from design.md)

- Plugin interfaces defined in TS: `ICompressionPlugin` and `IFileParserPlugin`
- Adding a new archive format or file parser = new plugin module + registration; zero core changes
- `VirtualFileSystem` abstracts file access across Web/EXE via adapter pattern
- `TaskScheduler` manages decompression queue with concurrency control
- File preview uses paged loading (max 500 lines per page); search runs in Web Worker / Rust thread
- EXE side uses `mmap` for zero-copy reads; Web side uses WASM + `TransformStream`
