# Auto CodeTutor

**See the architecture. Trace the data. Understand the firmware.**

[![Latest Release](https://img.shields.io/github/v/release/bigbangten/auto-codetutor?style=flat-square&label=release)](https://github.com/bigbangten/auto-codetutor/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square)
![Focus](https://img.shields.io/badge/focus-Embedded%20C-2EA043?style=flat-square)
![Desktop](https://img.shields.io/badge/desktop-Electron-47848F?style=flat-square)

Auto CodeTutor is an AI-native Windows workspace that turns unfamiliar embedded C projects into an explorable map of execution, data, and intent. It combines deterministic local code analysis with evidence-grounded AI explanations, helping you understand what the code does, where it came from, and what may change when you edit it.

The core experience is designed for folder-based embedded C projects and is not tied to a single IDE. S32 Design Studio and NXP projects receive additional, purpose-built support for MEX-generated code, RTD/SDK provenance, and generated-code traceability.

> Auto CodeTutor is built to help you learn and understand code—not to silently rewrite it.

## Download

Download the latest portable build from [GitHub Releases](https://github.com/bigbangten/auto-codetutor/releases/latest).

- Windows x64
- No installer required
- No API key required
- Static analysis works even without an AI CLI

## Why Auto CodeTutor?

Traditional code browsers show symbols. AI chat tools explain snippets. Embedded IDEs expose low-level project details. Auto CodeTutor brings these perspectives together in one learning-focused workspace:

- Navigate from a symbol to its definition, callers, callees, reads, writes, type, and members.
- Understand assignments at field level, including what value is copied or computed.
- See a purpose-oriented execution overview instead of an overwhelming raw call graph.
- Connect AI explanations back to verified project-relative source locations.
- Distinguish user code, generated code, and vendor SDK code.
- Keep project analysis, conversations, references, and notes available across sessions.

## Highlights

### Understand the codebase

- Incremental indexing for `.c`, `.h`, and `.mex` files
- A collapsed-by-default project explorer for functions, variables, parameters, typedefs, structs, unions, enums, macros, and fields
- Immediate symbol inspection for project code and referenced SDK symbols
- Type, declaration, definition, scope, references, reads, writes, and assignment semantics
- Clean struct and union member views with per-field meaning
- Built-in explanations for primitive integers, pointers, qualifiers, SDK types, function parameters, actual return expressions, and call-site arguments
- `Ctrl+Click` and `F12` definition navigation
- A built-in C glossary for `#include`, `#define`, `volatile`, primitive types, control flow, and operators—without an AI request

### Follow execution and data flow

- A high-level execution overview organized around the project's practical purpose
- Visual separation between user-focused `src` code and generated, RTD, or SDK infrastructure
- Current-flow highlighting when a symbol is selected in the editor
- Callers, callees, input parameters, return behavior, and call-site values
- Field-level write tracking such as `entry.flDomain = floodDomain`
- Read and write locations with project-relative paths

### Learn with grounded AI

- Project-wide, symbol-level, and selection-based explanations and chat
- Clear queued, running, completed, and failed response states
- Read-only integration with locally installed Codex and Claude subscription CLIs
- No API key entry or storage
- Lightweight background analysis that batches and reuses explanations for `src` symbols
- Immediate object-like macro values and recursive macro expansion at variable write sites
- Clickable explanation paragraphs, lists, and code examples that jump to the nearest verified `[[relative/path.c:line]]` evidence
- Reference-folder support for datasheets, manuals, notes, and page-level PDF citations
- Persistent, project-specific chat history and learning notes
- Three-question comprehension checks for active learning
- Korean-first explanations, comments, and learning content

### Built for real embedded projects

- Evidence-based provenance labels for user-managed code, MEX-generated code, RTD/SDK code, and unresolved authorship
- Deep S32DS/NXP support without making the core application IDE-dependent
- Multiple imported projects with quick switching and project closing
- Automatic restoration of the last workspace
- Persistent analysis caches and reference folders per project
- Change detection that lets you keep existing analysis or refresh only changed and newly discovered symbols
- Resizable panels, a read-only Monaco editor, accessible keyboard focus, and VS Code-inspired contrast

### Safer AI-assisted commenting

- Preview comments before touching source files
- Preserve existing comments, replace them, generate from a custom request, or remove comments
- Choose the AI provider, model, and reasoning effort used for generation
- Create a backup before applying changes
- Automatically block the operation if non-comment code tokens would change

## Getting Started

1. Download and run the portable executable.
2. Import an embedded C project folder.
3. Let Auto CodeTutor build the local symbol index.
4. Click a function, variable, type, macro, field, or C language token to inspect it.
5. Open **Execution Overview** for the project-level story, or use **AI Question** for a deeper explanation.
6. Optionally assign a reference folder containing datasheets and manuals.

To use AI features, install and sign in to either the Codex CLI or Claude CLI with your existing subscription. Static navigation and code analysis remain available without either CLI.

## Build from Source

```powershell
npm install
npm start
```

Run the full verification suite:

```powershell
npm run verify
```

Build the portable Windows executable:

```powershell
npm run dist
```

The current build is generated at:

```text
release-0.9.5/Auto-CodeTutor-0.9.5-portable.exe
```

## Data, Privacy, and Safety

- The code editor is read-only during normal use.
- Source files are written only after explicit confirmation in the comment workflow.
- A backup is created before comment changes are applied.
- Changes are rejected if the application detects modifications to non-comment code tokens.
- Indexes, chats, notes, quizzes, background symbol analysis, and UI state are stored in the project's `.codetutor-next/` directory for backward compatibility.
- Stored source locations use project-relative paths.
- Codex runs with a read-only, ephemeral sandbox; Claude is restricted to safe/plan behavior and read-oriented tools.
- AI-generated source anchors are checked against real files and line numbers before becoming clickable.

## Analysis Boundaries

Auto CodeTutor analyzes C source with the Tree-sitter C++ WASM grammar, which is a practical superset for the supported C syntax and allows the portable application to work without a separate Clang installation.

This source-level approach does not fully reproduce the compiler's preprocessed translation units. Calls created through function pointers, callbacks, complex macros, or conditional compilation may therefore be incomplete or may show multiple possible branches. Auto CodeTutor surfaces these limitations in its symbol and flow views instead of presenting uncertain results as facts.

Authorship is never inferred from finished code alone. MEX and RTD classifications require evidence such as generated-file paths or generator comments, while AI authorship is confirmed only when a trusted activity record exists.

## Author

**Youngmin Kim (김영민)** · [bigbangten95@gmail.com](mailto:bigbangten95@gmail.com)

---

If Auto CodeTutor helps you make sense of a difficult firmware project, consider starring the repository and sharing your feedback through [GitHub Issues](https://github.com/bigbangten/auto-codetutor/issues).
