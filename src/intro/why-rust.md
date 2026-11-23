# Why Rust, and when not to

Rust is not a better C++ in every respect, and this book does not pretend it
is. It makes one trade very clearly: you accept more rules at compile time, and
in exchange a whole class of bugs that C++ leaves to code review, sanitizers
and luck becomes impossible in safe code. Whether the trade is worth it
depends on what you are building. This chapter sets out the benefits, the
costs and the situations where each wins.

## What you gain over C++

- **Memory safety without a garbage collector.** Use-after-free, dangling
  references, iterator invalidation, double frees and buffer overruns are
  compile errors or checked panics in safe Rust, not undefined behavior
  ([Ownership](../foundations/ownership.md),
  [Borrowing](../foundations/borrowing.md)). There is no GC and no runtime to
  speak of, so the performance model is the one you know from C++: values on
  the stack, explicit heap allocation, zero-cost abstractions, and no pauses.
- **Thread safety checked by the compiler.** Sharing data between threads
  without synchronization does not compile. `Send` and `Sync` make "this type
  must stay on the render thread" a rule the compiler enforces rather than a
  comment ([Threads, locks and Send/Sync](../systems/concurrency.md)).
- **`unsafe` is explicit and local.** When you need raw pointers, FFI or
  hand-written SIMD, you still have them, inside `unsafe` blocks that mark
  exactly which lines need careful review ([Unsafe Rust](../systems/unsafe.md)).
- **One toolchain.** Building, dependencies, tests, benchmarks, formatting,
  linting and documentation are standard and the same in every project
  ([Tools and the ecosystem](../systems/testing-and-tooling.md)). There is no
  CMake dialect to learn per project.
- **Package management that works.** Adding a library is one line, built from
  source with your compiler and flags, with versions pinned in a lock file
  ([crates.io and the ecosystem](../systems/crates-io.md)).
- **Errors and absence in the type system.** `Result` and `Option` replace
  error codes, exceptions and null pointers, and the compiler makes you handle
  them ([Error handling](../foundations/errors.md)).

## What it costs

- **The learning curve is real.** The borrow checker rejects some designs
  that are correct, and some C++ habits, such as object graphs of mutual
  pointers and long-lived mutable references into containers, have to be
  replaced with other patterns (indices, handles, arenas). Expect a few weeks
  of friction before it feels natural. Most of this book exists to shorten
  that period.
- **Compile times.** A clean build of a large Rust project is comparable to a
  large C++ project with heavy templates. Incremental builds and `cargo check`
  help; the [Project organization](../foundations/project-organization.md)
  chapter covers how to structure crates so builds stay fast.
- **A younger game and graphics ecosystem.** There is no Unreal or Unity.
  Rust engines such as Bevy and Fyrox are capable but young, console SDKs and
  platform middleware are C and C++ first, and most GPU compute (CUDA kernels,
  vendor libraries) is still written in C++. You can call all of it through
  FFI, but someone has to write and maintain the bindings.
- **Interop with existing C++ has a cost.** Rust talks to C easily and to C++
  through a C layer or generated bindings. Templates, exceptions and C++
  classes do not cross the boundary directly
  ([FFI with C and C++](../systems/ffi.md)).
- **No stable ABI between Rust crates.** You cannot ship a closed-source Rust
  library for other Rust code to link; you ship source, or a C ABI.
- **Smaller hiring pool.** Fewer engineers have shipped Rust in production
  than C++, especially in games.

## Rust and AI-assisted development

More and more code is written with an AI assistant or by an agent, and
reviewed by a person. Rust's strictness, which feels like a cost when you
write every line yourself, becomes useful when you are reviewing code you did
not write:

- **The compiler checks what you would otherwise have to review.** Code
  generated in C++ can compile cleanly and still contain a lifetime bug that
  shows up weeks later as a crash. The same mistake in Rust is a compile
  error, before anyone reads the code:

  ```rust,compile_fail
  fn first_enemy_name(enemies: &mut Vec<String>) -> &str {
      let first = &enemies[0];
      enemies.push("boss".to_string()); // may reallocate: `first` would dangle
      first                             // error[E0502]: cannot borrow `*enemies` as mutable
  }
  ```

- **Error messages an agent can act on.** Rust's compiler errors name the
  problem, point at the exact span and usually suggest a fix. An agent that
  builds, reads the error and edits in a loop converges much faster than one
  that has to interpret a page of template instantiation errors, or a crash at
  run time.
- **One way to build, test and lint.** `cargo build`, `cargo test`,
  `cargo clippy` and `cargo fmt` work the same in every repository, so an
  agent does not need project-specific instructions to verify its own work.
- **Explicit contracts are easier to review.** Function signatures say who
  owns what, which errors can occur and what may be absent. An exhaustive
  `match` means a new enum variant cannot be silently ignored. A reviewer can
  check intent from the signature instead of tracing the whole body.
- **Rust is part of the AI stack itself.** Hugging Face's `tokenizers`,
  inference frameworks such as `candle`, and many fast Python extensions (built
  with PyO3, like Polars) are written in Rust. Systems work around models,
  such as inference servers, data pipelines and tools that run next to Python,
  is a common place for Rust today.

The honest caveat: models still produce Rust that does not compile,
especially around lifetimes and async code, and there is less Rust than C++
or Python in their training data. The benefit is not that generated Rust is
correct the first time. It is that many of its mistakes are caught by the
compiler instead of by your users.

## When to choose it

| Situation | Choice |
|---|---|
| A new tool, service or pipeline: asset processing, build tools, servers, editors | **Rust.** Safety and tooling pay off immediately, and there is no legacy code to bind to |
| Code that parses untrusted input: network protocols, file formats, mods, save files | **Rust.** The classic source of security bugs in C++ |
| Heavily multithreaded systems: job systems, streaming, networking | **Rust.** Data races are compile errors |
| A new subsystem inside an existing C++ engine | **Rust behind a C API** can work well for self-contained parts (a physics step, an audio mixer, a parser). Budget for the FFI layer |
| A large existing C++ engine and codebase | **C++.** Rewriting is rarely worth it. Add Rust at the edges, if at all |
| A console-first title, or one built on Unreal or Unity | **C++ (or C#).** The platform tools and middleware assume them |
| CUDA kernels and GPU compute libraries | **C++** for the kernels. Rust can drive them through FFI or use wgpu compute for portable cases |
| A tight deadline with a team that knows only C++ | **C++.** Learn Rust on a tool or side project first |

A common path for engine teams is to start with tools and services, where Rust's
disadvantages matter least, and move closer to the runtime as experience and
bindings accumulate. The rest of this book follows the same order: the
language first, then tools and systems programming, then graphics and engine
code.
