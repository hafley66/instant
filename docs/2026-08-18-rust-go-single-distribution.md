# Rust + Go Single-Distribution Capability Reference

## Research Metadata

- Research date: 2026-08-18
- Focus: retaining a Go CLI implementation behind a Rust API while distributing one user-facing artifact where possible
- Go: 1.26.5, released 2026-07-07 ([downloads](https://go.dev/dl/), [release history](https://go.dev/doc/devel/release))
- Primary Go build reference: [`go build` modes](https://go.dev/cmd/go/?m=old)
- Candidate Go program: [`sotarok/gw`](https://github.com/sotarok/gw), MIT, automatic npm/yarn/pnpm/Cargo/Go/Python/Ruby/Composer setup detection

## Executive Index

1. **Embedded extracted subprocess**: compile a target-specific Go executable, embed its bytes in Rust, materialize it by content hash, then spawn it. One distributed file, two runtime processes, one temporary/cache executable.
2. **Packaged sidecar**: ship Rust and Go executables together in an app/archive. Two distributed files, direct execution, native signing and updater behavior.
3. **Go `c-archive`**: compile Go into a C archive and link it into Rust. One file on disk and one process, with a C ABI and the Go runtime linked into the Rust executable.
4. **Linux `memfd` execution**: embed an ELF and execute it from an anonymous memory-backed file descriptor. One distributed file and two processes, Linux only.
5. **Go/WASI embedded runtime**: compile Go to WASI and host it inside Rust. One file and one process, but WASI preview 1 lacks process-spawn and complete socket facilities needed by a worktree/package-manager CLI.
6. **Download-on-first-use**: Rust installs a target binary into a versioned cache. Small Rust artifact, network and supply-chain dependency at first use.

## Two-Pass Result

### Pass 1: Technique enumeration

The first pass searched Go build modes, Rust asset embedding, Rust process supervision, Tauri sidecars, Rust-to-Go build tooling, executable-from-memory crates, WASI, and release packaging.

| Technique | Distribution files | Runtime processes | Go CLI preserved | Portable | Writes executable at runtime |
|---|---:|---:|---:|---:|---:|
| Embed bytes, extract, spawn | 1 | 2 | Yes | macOS/Linux/Windows | Yes |
| App/archive sidecar | 2+ inside bundle | 2 | Yes | macOS/Linux/Windows | No |
| Go `c-archive` | 1 | 1 | No, needs callable ABI | Supported target matrix | No |
| Go `c-shared` | 2 | 1 | No, needs callable ABI | Supported target matrix | No |
| Linux `memfd` | 1 | 2 | Yes | Linux only | No persistent write |
| Go/WASI + embedded runtime | 1 | 1 | Only WASI-compatible behavior | Runtime-dependent | No |
| Download/cache | 1 initial | 2 | Yes | Release matrix-dependent | Yes |

### Pass 2: Boop viability verification

Boop needs the child to run Git and package-manager processes in arbitrary worktrees, inherit or capture stdio, return an exit status, receive cancellation, and work on macOS and Linux. This removes WASI from the current candidate set because Go's WASI port documents missing host facilities, including incomplete networking, and WASI preview 1 does not provide the ordinary host process model used by `git`, `pnpm`, `npm`, and `cargo` ([Go WASI overview and limitations](https://go.dev/blog/wasi)). Linux `memfd` remains an optional backend rather than the portable contract ([`memfd_exec` 0.2.1](https://docs.rs/memfd-exec/latest/memfd_exec/)).

The three viable deployment modes are:

| Boop feature | Build result | Runtime boundary | Intended use |
|---|---|---|---|
| `embedded-gw` | Go executable bytes linked as Rust data | Extract and spawn | One downloadable Boop CLI |
| `sidecar-gw` | Rust and signed Go executables | Spawn installed sibling | Tauri/macOS application bundle |
| `linked-gw` | Go C archive linked into Rust | C ABI call | Small stable detection library, after removing CLI/process assumptions |

## Capability Matrix

| Requirement | Embedded extracted | Tauri sidecar | `c-archive` | Linux `memfd` | WASI |
|---|---:|---:|---:|---:|---:|
| Preserve upstream `gw` CLI unchanged | Yes | Yes | No | Yes | Usually no |
| Single downloaded CLI file | Yes | No | Yes | Yes | Yes |
| Single runtime process | No | No | Yes | No | Yes |
| macOS | Yes | Yes | Yes when Go supports target | No | Host-dependent |
| Linux | Yes | Yes | Yes when Go supports target | Yes | Host-dependent |
| Windows | Yes | Yes | Yes when Go supports target | No | Host-dependent |
| Ordinary stdin/stdout/exit code | Yes | Yes | Adapter required | Yes | Host adapter |
| Child-tree cancellation | Yes | Yes | In-process | Separate implementation | In-process |
| Native code signing path | Extracted code policy | Yes | Main binary only | N/A | Main binary only |
| Upstream binary replaceable independently | Rebuild Rust artifact | Replace sidecar | Rebuild Rust artifact | Rebuild Rust artifact | Rebuild Rust artifact |

## Technique 1: Embedded Extracted Subprocess

### Build

`build.rs` invokes target-specific `go build`, writes the Go executable into Cargo's `OUT_DIR`, and Rust embeds it with `include_bytes!`. `include_dir` 0.7.4 and `rust-embed` 8.12.0 generalize this to asset trees; a single executable only needs `include_bytes!`. [`include_dir` documents compile-time and binary-size costs](https://docs.rs/include_dir/latest/include_dir/); [`rust-embed` supports compression and deterministic timestamps](https://docs.rs/rust-embed/latest/rust_embed/).

```rust
// build.rs
let target = std::env::var("TARGET")?;
let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
    .join(if target.contains("windows") { "gw.exe" } else { "gw" });

let status = std::process::Command::new("go")
    .env("GOOS", go_os(&target))
    .env("GOARCH", go_arch(&target))
    .args(["build", "-trimpath", "-buildvcs=false", "-o"])
    .arg(&output)
    .arg("./vendor/gw")
    .status()?;
assert!(status.success());
```

### Materialization contract

```rust
pub struct EmbeddedTool {
    pub name: &'static str,
    pub version: &'static str,
    pub sha256: [u8; 32],
    pub bytes: &'static [u8],
}

impl EmbeddedTool {
    pub fn materialize(&self) -> Result<PathBuf>;
    pub fn command(&self) -> Result<processkit::Command>;
}
```

The runtime algorithm is:

1. Compute or use the compiled-in digest.
2. Resolve a user cache path containing tool name, version, target, and digest.
3. Acquire a per-target lock.
4. If an existing file hashes correctly, reuse it.
5. Write to a new file in the same directory.
6. Flush, set executable permissions, and atomically rename.
7. Spawn with explicit cwd, environment policy, stdio policy, and timeout.
8. Keep the last known versions until no process uses them; prune separately.

### Process supervision

[`processkit` 3.3.1](https://docs.rs/processkit/latest/processkit/) supplies Tokio execution, whole-process-tree containment, kill-on-drop, streaming, timeouts, cancellation, and mock runners. [`command-group` 5.0.1](https://docs.rs/command-group/latest/command_group/) is a smaller process-group layer. [`duct`](https://docs.rs/duct/latest/duct/) and [`xshell` 0.2.7](https://docs.rs/xshell/latest/xshell/) improve command composition but do not provide the same cross-platform child-tree supervision.

### Limits

- A filesystem-backed executable exists after first use.
- Read-only homes, `noexec` mounts, sandbox policies, antivirus, and cleanup races need typed errors.
- Each Rust target needs matching Go executable bytes.
- The embedded payload increases Rust binary size approximately by the compressed or raw Go executable size.
- A temporary-file-per-run design increases races and scanning. A content-addressed durable cache avoids repeated extraction.

## Technique 2: Signed Packaged Sidecar

Tauri 2 has a supported `externalBin` mechanism. It selects binaries by Rust target-triple suffix and exposes a managed spawn API with streamed output ([official sidecar documentation](https://v2.tauri.app/develop/sidecar/)).

```json
{
  "bundle": {
    "externalBin": ["binaries/gw"]
  }
}
```

Expected files include:

```text
src-tauri/binaries/gw-aarch64-apple-darwin
src-tauri/binaries/gw-x86_64-apple-darwin
src-tauri/binaries/gw-x86_64-unknown-linux-gnu
```

Apple requires executable code in a distributed product to carry a valid signature, and nested code must be signed before the containing application ([Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/), [nested-code guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)). This path gives the Go helper an ordinary signed location inside the application bundle.

For the standalone `boop` CLI, archive packaging can place `boop` and `gw` beside each other. That produces one archive download but two installed executables.

## Technique 3: Go `c-archive`

Go defines `-buildmode=c-archive` as compiling one `main` package and its imports into a C archive. Only functions marked with cgo `//export` are callable ([official build-mode reference](https://go.dev/cmd/go/?m=old)). The Rust [`cgo` crate](https://docs.rs/cgo/latest/cgo/) is a `build.rs` helper that compiles a Go package and emits Cargo link instructions.

```rust
// build.rs
cgo::Build::new()
    .package("go/worktree/main.go")
    .build("go_worktree");
```

This boundary requires converting `gw` from a command-oriented program into exported functions. A narrow payload ABI can use caller-owned input bytes and an explicit Go-owned output/free pair.

```c
GoBuffer gw_detect(const uint8_t *input, size_t input_len);
void gw_free(GoBuffer output);
```

[`bindgen`](https://github.com/rust-lang/rust-bindgen) can generate the Rust declarations from Go's generated C header.

### Limits

- Go runtime initialization and scheduling live inside the Rust process.
- Panics, global state, environment mutation, current-directory assumptions, and process exit calls cross a shared failure boundary.
- `os.Exit` cannot remain in callable library paths.
- Cross-compiling CGO requires a compatible target C toolchain.
- The upstream CLI cannot be consumed unchanged.

## Technique 4: Linux In-Memory Execution

[`memfd_exec` 0.2.1](https://docs.rs/memfd-exec/latest/memfd_exec/) and [`memfd_runner` 0.2.3](https://docs.rs/memfd-runner/latest/memfd_runner/fn.run.html) write embedded ELF bytes to a Linux anonymous memory file and execute through its descriptor. This avoids a persistent extracted executable. It has no macOS or Windows equivalent with the same ordinary `exec` contract. Newer Linux kernels can also apply executable or non-executable memfd seals, so host policy remains observable ([rustix memfd flags](https://docs.rs/rustix/latest/rustix/fs/struct.MemfdFlags.html)).

A portable abstraction could select:

```text
Linux + allowed memfd → anonymous execution
macOS/Windows         → content-addressed extraction
```

The behavioral test suite must run against both backends because path visibility differs. Programs that locate resources relative to their own executable may behave differently through `/proc/self/fd/...`.

## Technique 5: Go/WASI

Go supports `GOOS=wasip1 GOARCH=wasm`; Go 1.24 also added `//go:wasmexport` for exported callable functions ([Go WASI](https://go.dev/blog/wasi), [Go Wasm exports](https://go.dev/blog/wasmexport)). A Rust executable could embed the Wasm bytes and a runtime such as Wasmtime.

This fits pure detection over supplied bytes or a preopened filesystem. A worktree bootstrapper calls host programs and expects native Git/package-manager behavior, which does not map to WASI preview 1 without designing host imports for those effects. Embedding a Wasm runtime also adds a runtime dependency substantially larger than a small subprocess wrapper.

## Build and Release Patterns

### Cargo feature layout

```toml
[features]
default = ["embedded-gw"]
embedded-gw = []
system-gw = []
linked-gw = ["dep:go-worktree-sys"]
linux-memfd = ["embedded-gw", "dep:memfd-exec"]
```

Exactly one backend should be selected:

```rust
#[cfg(not(any(feature = "embedded-gw", feature = "system-gw", feature = "linked-gw")))]
compile_error!("select a gw backend");
```

### Build provenance

Embed a manifest alongside the executable bytes:

```rust
pub struct EmbeddedToolManifest {
    pub upstream_repository: &'static str,
    pub upstream_revision: &'static str,
    pub go_version: &'static str,
    pub target: &'static str,
    pub sha256: &'static str,
    pub license_spdx: &'static str,
}
```

Run `go version -m` against every produced helper in CI, record the module graph, and keep the MIT license notice from `gw` in the distributed notices.

### Cross-target matrix

Build Go once per Rust release target. Do not infer Go target names mechanically from every Rust triple; keep a reviewed mapping.

```text
aarch64-apple-darwin          → darwin/arm64
x86_64-apple-darwin           → darwin/amd64
x86_64-unknown-linux-gnu      → linux/amd64
aarch64-unknown-linux-gnu     → linux/arm64
x86_64-pc-windows-msvc        → windows/amd64
```

[`cargo-dist` supports extra build steps and artifacts](https://docs.rs/cargo-dist/latest/cargo_dist/tasks/index.html), so release CI can build the Go matrix before Cargo packaging. Tauri uses its documented target-suffixed sidecar naming.

## Candidate Reusable Rust API

```rust
pub enum ToolBackend {
    EmbeddedExtracted,
    InstalledSibling,
    SystemPath,
    #[cfg(target_os = "linux")]
    EmbeddedMemfd,
}

pub struct ToolInvocation {
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub env: BTreeMap<OsString, OsString>,
    pub stdin: StdioMode,
    pub stdout: StdioMode,
    pub stderr: StdioMode,
    pub timeout: Duration,
}

pub trait EmbeddedCommand {
    fn manifest(&self) -> &EmbeddedToolManifest;
    fn resolve(&self, backend: ToolBackend) -> Result<ResolvedTool>;
    async fn run(&self, invocation: ToolInvocation) -> Result<ProcessResult>;
}
```

This API keeps build/materialization separate from process supervision and allows deterministic tests with a scripted process runner.

## Boop Application

The smallest integration retaining `gw` unchanged is:

```text
boop feature `embedded-gw`
  build.rs builds vendored gw at pinned revision
  bytes and provenance manifest enter the boop binary
  first worktree preparation resolves content-addressed helper
  processkit runs `gw` detection/setup under timeout and cancellation
  boop records command, helper digest, duration, exit, and stderr summary
  repository `boop-start` remains the explicit override
```

Precedence:

```text
--no-start
  → skip all preparation

boop-start recipe exists
  → execute repository contract

embedded detector available
  → detect and propose or execute policy-selected setup

no recognized project
  → warn with observed manifests
```

The automatic detector must not start `dev`, `serve`, or other resident commands. It may report them as capabilities. Installation remains a bounded setup action.

## Issues and Discussion Signals

- `gw` documents a trust model for repository-local hooks because checked-out hook content can differ by branch. Boop's existing `boop-start` recipe has the same branch-content property and should retain explicit policy around execution ([gw hook warning](https://github.com/sotarok/gw)).
- Go's official WASI documentation records missing networking and runtime-host differences, so tutorials presenting WASI as a transparent native CLI replacement are stale for process-heavy tools ([Go WASI limitations](https://go.dev/blog/wasi)).
- Apple documents signing nested tools from the inside out. Runtime extraction does not use the ordinary pre-signed nested-tool layout, which should be tested against the exact Boop distribution and Gatekeeper path ([Apple signing order](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)).
- `include_dir` documents compilation-memory and binary-size growth for large embedded trees. A single compressed executable avoids its directory-expansion overhead ([include_dir compile-time considerations](https://docs.rs/include_dir/latest/include_dir/)).
- Linux `memfd` execution has kernel and sandbox policy variation and cannot become the cross-platform public contract.

## Recent Timeline

| Date | Change |
|---|---|
| 2023-09-13 | Go 1.21 WASI preview 1 support documented |
| 2025 | Go 1.24 `//go:wasmexport` made callable Wasm exports available |
| 2026-02-10 | Go 1.26 released; cgo baseline overhead reduced according to the release announcement |
| 2026-07-07 | Go 1.26.5 released |
| 2026-08-18 | `processkit` docs report 3.3.1; `rust-embed` docs report 8.12.0; `include_dir` reports 0.7.4 |

## Test Matrix

```text
build
  each Rust target embeds the matching Go target
  missing Go toolchain yields a build-time diagnostic naming feature/fallback
  embedded digest and upstream revision match CI manifest

materialize
  first extraction
  concurrent extraction
  existing valid cache hit
  corrupt cache replacement
  read-only cache root
  noexec cache root
  stale-version pruning while current child runs

process
  argv with spaces and non-UTF-8 paths
  cwd propagation
  environment allow-list
  stdin/stdout/stderr streaming
  nonzero exit
  timeout and cancellation kill descendants

behavior
  embedded gw output matches standalone gw golden fixtures
  package-manager precedence fixtures
  monorepo and standalone fixtures
  absent setup/dev command warnings
```

## Source Inventory

### Engineering writeups

- [Radu Matei, From (C)Go to Rust](https://radu-matei.com/blog/from-go-to-rust-static-linking-ffi/) demonstrates both `c-shared` and `c-archive`, generated headers, Rust `extern "C"` declarations, Cargo linker directives, and additional macOS framework links. Its static-library result is a single distributed Rust executable, but the integration surface becomes a C ABI rather than the original Go CLI.
- [Amir Malik, Embedding Go in a Rust Program](https://amirmalik.net/2023/02/15/embedding-go-in-rust) independently exercises `go build -buildmode=c-archive`, cgo-exported primitive signatures, generated headers, and Rust calls into the archive. This corroborates the FFI mechanics and the need to redesign Go values at the boundary.
- [Yubico Authenticator macOS packaging notes](https://developers.yubico.com/yubioath-flutter/MacOS_Packaging.html) provide a deployed helper-binary packaging example: sign the helper, build the containing GUI, then sign and notarize the containing application. This supports the signed-sidecar path for an Instant application bundle.
- [Apple Technical Note TN2206](https://developer.apple.com/library/archive/technotes/tn2206/) explains nested-code sealing, recursive bundle signing, Gatekeeper verification, and the rule that modifying signed executable content invalidates its signature. It is documentation in article form and supplies the operational constraint missing from generic embedding examples.

The blog pass found repeatable Go-to-Rust FFI examples and one production helper-signing recipe. It did not find a maintained engineering writeup that fully covers the other candidate: embedding an arbitrary executable as Rust bytes, atomically extracting it into a content-addressed cache, supervising its process tree, and shipping that arrangement through macOS notarization. That path is assembled from Rust embedding APIs, process libraries, platform signing documentation, and the test matrix above.

### Primary and package references

- [Go downloads and current stable release](https://go.dev/dl/)
- [Go build modes](https://go.dev/cmd/go/?m=old)
- [Go WASI support and limits](https://go.dev/blog/wasi)
- [Go Wasm exports](https://go.dev/blog/wasmexport)
- [`gw` repository, behavior, detection list, hooks, and MIT license](https://github.com/sotarok/gw)
- [`cgo` Rust build helper](https://docs.rs/cgo/latest/cgo/)
- [`bindgen`](https://github.com/rust-lang/rust-bindgen)
- [`rust-embed` 8.12.0](https://docs.rs/rust-embed/latest/rust_embed/)
- [`include_dir` 0.7.4](https://docs.rs/include_dir/latest/include_dir/)
- [`processkit` 3.3.1](https://docs.rs/processkit/latest/processkit/)
- [`command-group` 5.0.1](https://docs.rs/command-group/latest/command_group/)
- [`memfd_exec` 0.2.1](https://docs.rs/memfd-exec/latest/memfd_exec/)
- [`memfd_runner` 0.2.3](https://docs.rs/memfd-runner/latest/memfd_runner/fn.run.html)
- [Tauri 2 external binaries](https://v2.tauri.app/develop/sidecar/)
- [Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)
- [`cargo-dist` extra build artifacts](https://docs.rs/cargo-dist/latest/cargo_dist/tasks/index.html)

## Research Gaps

- The exact Gatekeeper behavior of a signed Boop CLI extracting its embedded signed or unsigned helper requires an executable test on the intended `.pkg`, Homebrew, or direct-download distribution path.
- `gw` does not expose a documented JSON-only detection subcommand in its current README; preserving it unchanged means consuming command output or contributing a machine-readable command upstream.
- Windows extraction, file replacement, and antivirus behavior require a Windows CI runner.
- The current Boop release-target matrix and installer format were not specified, so the build matrix above covers the common macOS, Linux, and Windows targets rather than an asserted release contract.
