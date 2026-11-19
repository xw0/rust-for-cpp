# Toolchain setup

A C++ toolchain is something you assemble: a compiler (or three), a build
system, a package manager, a debugger, a formatter, a linter and a test
framework, each from a different vendor. Rust ships almost all of that as one
install. This chapter gets it onto your machine and maps each piece to what you
already use.

## Installing with rustup

Install Rust with [rustup](https://rustup.rs), the official toolchain manager.
On Linux and macOS:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On Windows, download and run `rustup-init.exe` from the same site. Rust on
Windows uses the MSVC linker and Windows SDK by default, so install the
"Desktop development with C++" workload of Visual Studio (or the Build Tools)
first. You almost certainly have it already.

rustup installs into your home directory (`~/.cargo` and `~/.rustup`) and puts
these on your `PATH`:

| Tool | What it is | C++ equivalent |
|---|---|---|
| `rustc` | The compiler | `clang++`, `g++`, `cl.exe` |
| `cargo` | Build system, package manager, test runner | CMake + vcpkg/Conan + CTest |
| `rustup` | Installs and switches toolchains and targets | Installing several compilers side by side |
| `rustfmt` / `cargo fmt` | Formatter | clang-format |
| `clippy` / `cargo clippy` | Linter | clang-tidy |
| `rustdoc` / `cargo doc` | Documentation generator | Doxygen |
| `rust-analyzer` | Language server for editors | clangd |

## Toolchains and targets

Rust releases a new stable compiler every six weeks, and new releases are
backward compatible: code that compiles today keeps compiling. There is no
reason to stay on an old compiler the way C++ projects often must.

```sh
rustup update                 # move to the newest stable compiler
rustup toolchain install nightly
rustup default stable
rustc --version
```

A project can pin a toolchain by committing a `rust-toolchain.toml` file, the
equivalent of pinning a compiler version in your CI images:

```toml
[toolchain]
channel = "1.91"
components = ["rustfmt", "clippy"]
```

Cross-compilation is built in. A **target triple** names the platform, like
the triples you pass to Clang:

```sh
rustup target add aarch64-linux-android wasm32-unknown-unknown x86_64-pc-windows-msvc
cargo build --target wasm32-unknown-unknown
```

The standard library for each target is downloaded prebuilt. You still need a
linker for the target platform (the Android NDK, for example), just as in C++.

## Editors

Install **rust-analyzer**. It provides completion, go-to-definition, inline
type hints and the compiler's errors as you type.

- **VS Code**: install the *rust-analyzer* extension. For debugging, add
  *CodeLLDB* (Linux/macOS) or use the C/C++ extension's debugger (Windows).
- **JetBrains**: *RustRover*, or the Rust plugin for CLion.
- **Visual Studio**: no first-class support; most Windows developers use VS
  Code or RustRover for Rust and keep Visual Studio for debugging mixed C++
  and Rust.
- **Vim, Emacs, Helix, Zed**: all speak the language server protocol.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Inline type hints</span>

rust-analyzer shows the inferred type of every `let` binding in grey. Leave
this on while you learn. Rust infers more than C++ `auto` does (types flow
backward from later uses too), and the hints show you what the compiler
decided.

</div>

## Debuggers and profilers you already know

Rust compiles to native code with standard debug info (DWARF on Linux and
macOS, PDB on Windows), so your existing tools work:

- **GDB and LLDB** work directly. `rust-gdb` and `rust-lldb` are wrappers that
  add pretty-printers for `Vec`, `String`, `Option` and friends.
- **Visual Studio's debugger** and **WinDbg** read the PDBs, with natvis
  visualizers for standard types.
- **RenderDoc, Nsight Graphics, PIX** and **Radeon GPU Profiler** do not care
  what language issued the API calls.
- **perf, VTune, Superluminal, Tracy, Instruments** all work. Tracy has a Rust
  client (the `tracy-client` crate).

## Your first project

```sh
cargo new hello
cd hello
cargo run
```

`cargo new` creates:

```text
hello/
├── Cargo.toml      # project manifest: name, version, dependencies
├── .gitignore
└── src/
    └── main.rs     # the binary's entry point
```

`src/main.rs`:

```rust
fn main() {
    println!("Hello, world!");
}
```

`cargo run` compiles in debug mode into `target/debug/hello` and runs it. The
commands you will use every day:

| Command | What it does |
|---|---|
| `cargo build` | Debug build into `target/debug/` |
| `cargo build --release` | Optimized build into `target/release/` |
| `cargo run` / `cargo run --release` | Build and run |
| `cargo check` | Type-check only, no code generation (much faster) |
| `cargo test` | Build and run all tests |
| `cargo fmt` | Format the whole project |
| `cargo clippy` | Lint |
| `cargo doc --open` | Build API docs for your crate and all dependencies |

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

Do not benchmark debug builds. Rust's debug builds are much slower than C++
`-O0` builds in relative terms, because so much of Rust (iterators, `Option`,
small methods) relies on inlining. For games, set `opt-level = 1` for your own
code in debug and `opt-level = 3` for dependencies. The [Cargo
chapter](../foundations/cargo.md) shows how.

</div>

## The Playground

For quick experiments you do not need a project at all. The [Rust
Playground](https://play.rust-lang.org) compiles and runs code in the browser,
can show assembly, LLVM IR and MIR, and has the 100 most popular crates
available. Every runnable example in this book uses it.

## Exercises

1. Install Rust, create a project with `cargo new`, and run it in debug and
   release mode. Find both binaries under `target/`.
2. Set a breakpoint on the `println!` line in your debugger of choice and step
   into it. What do you see?
3. Run `cargo build -v` and read the `rustc` command line Cargo runs. Compare it
   with what CMake passes to your C++ compiler.
