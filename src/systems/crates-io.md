# crates.io and the ecosystem

In C++, reusing someone else's library is a project of its own: find it, pick
vcpkg, Conan or a git submodule, make its build system cooperate with yours,
and match compiler flags. In Rust, one line in `Cargo.toml` does all of that
([Cargo, crates and the build](../foundations/cargo.md)), and the line points
to [crates.io](https://crates.io) by default. That makes adding a dependency
so cheap that the hard questions move elsewhere: which crate to choose, and
whether to trust it.

This chapter covers:

- how crates.io is organized, and where to find good crates,
- judging whether a crate is trustworthy, and the tools that help,
- using crates well: features, the lock file, forks and vendoring,
- contributing to other people's crates,
- publishing your own crate on crates.io, or only on GitHub.

## How crates.io is organized

crates.io is the Rust community's package registry, run by the crates.io team
under the Rust project. A few rules shape everything else:

- **Packages are source code.** A published version is a `.crate` file, a
  gzipped tarball of the source and its `Cargo.toml`. There are no binaries:
  Cargo builds every dependency on your machine with your compiler and flags.
- **The namespace is flat.** Names are first come, first served, and there
  are no organization prefixes like `@company/name`. Related crates use naming
  conventions instead: `foo`, `foo-sys` (raw FFI bindings to a C library),
  `foo-derive` or `foo-macros` (procedural macros), `foo-core`.
- **Versions are immutable.** You cannot change or replace a published
  version. You can **yank** it: new projects will not select it, but projects
  whose `Cargo.lock` already uses it keep building. Deleting a crate entirely
  is only possible under narrow conditions (shortly after publishing, or with
  few downloads and no dependents), so a build that works today keeps working.
- **Every crate has owners.** Owners are users or GitHub teams, and only they
  can publish new versions. Accounts are GitHub logins.
- **Metadata comes from `Cargo.toml`.** Description, license, repository,
  keywords and categories are shown on the crate page, along with the README,
  every version, download counts and the list of crates that depend on it.

Two services sit next to crates.io and work for every crate automatically:

- [docs.rs](https://docs.rs) builds the API documentation of every published
  version. A link like `docs.rs/glam/0.30` is the reference for that version,
  so you never read docs for the wrong release.
- The **index** is the metadata Cargo downloads to resolve versions. Cargo
  fetches only the entries it needs (the "sparse" protocol), which is why
  resolving is fast even though the registry has hundreds of thousands of
  crates.

### Finding crates

| Where | What it is |
|---|---|
| [crates.io](https://crates.io) search, categories and keywords | The registry itself. Sort by recent downloads, not all-time downloads |
| [lib.rs](https://lib.rs) | An independent index of the same crates, with better ranking and categories |
| [blessed.rs](https://blessed.rs) | A short curated list of the de facto standard crate for each job |
| [Are we game yet?](https://arewegameyet.rs) | Game development crates: engines, graphics, audio, physics, networking |
| A crate page's "Dependents" tab | Who already relies on it, and how much |

For common jobs there is usually one crate the community has settled on:
serde for serialization, tokio for async I/O, rayon for data parallelism,
anyhow and thiserror for errors, clap for command-line parsing, tracing for
logging. Start there before you compare alternatives.

## What Cargo does with a dependency

Package management is one of C++'s weak points: there is no standard package
format, no standard build description, and no stable ABI, so every library
has to be adapted to every build system, compiler and configuration. Rust
avoids most of that with a single design: **one tool, one package format, and
everything built from source by the same compiler.** This section follows one
line of `Cargo.toml` through the whole process.

### Resolving versions

```toml
[dependencies]
glam = { version = "0.30", features = ["serde"] }
serde_json = "1"
```

On the first build, Cargo downloads the index entries for these crates and
their dependencies, and picks one exact version for each:

1. A requirement like `"1"` or `"0.30"` is a caret range: `"1"` means
   `>=1.0.0, <2.0.0`, and `"0.30"` means `>=0.30.0, <0.31.0`. Use `"=1.2.3"`
   to pin, or `">=1.2, <1.5"` for a custom range, but rarely.
2. For each crate, Cargo picks the **newest version that satisfies every
   requirement** on it anywhere in the graph. In edition 2024 it also prefers
   versions whose declared `rust-version` your compiler supports.
3. It writes the result to `Cargo.lock`. Later builds use the lock file and do
   not resolve again until you run `cargo update` or change `Cargo.toml`.

```text
    Updating crates.io index
     Locking 12 packages to latest Rust 1.97.0 compatible versions
      Adding glam v0.30.10 (available: v0.34.3)
```

The last line is Cargo telling you that a newer, semver-incompatible glam
exists, which you would have to opt into by changing `"0.30"`.

### One version or two

If `render` asks for `log = "0.4.17"` and `audio` asks for `log = "0.4.20"`,
both requirements are in the same semver range, so Cargo **unifies** them: one
copy of `log`, at a version that satisfies both (0.4.20 or newer). This is the
diamond dependency, solved automatically.

If the requirements are incompatible (`rand = "0.8"` and `rand = "0.9"`),
Cargo builds **both versions** and links both into the binary. Their symbols
are mangled with a hash of the crate's identity, so they do not collide, and
their types are different types, so passing a `rand 0.8` value to code that
expects `rand 0.9` is a compile error rather than an ODR violation. The cost
is build time and binary size, which is why `cargo tree -d` and
`cargo deny`'s `multiple-versions` check are worth running.

The exception is native code. A crate that links a C library declares it with
`links = "z"` in its `Cargo.toml`, and Cargo refuses to put two crates that
link the same native library into one graph, because C symbols have no hash
to keep them apart. You get an error at resolve time, not a crash at run time.

### Features are unified

Features ([Cargo chapter](../foundations/cargo.md#features-conditional-compilation))
are resolved across the whole graph: if any crate enables a feature of a
dependency, every user of that dependency gets it. `cargo tree -e features`
shows why a feature is on:

```text
$ cargo tree -e features -i serde_core
serde_core v1.0.229
├── glam v0.30.10
│   ├── glam feature "serde"
│   │   └── dep v0.1.0
...
└── serde_core feature "std"
    └── serde_json feature "std"
```

Here `glam` asked only for `serde_core`, but `serde_json` enabled its `std`
feature, so `glam`'s copy has `std` too: there is only one `serde_core`. This
works because features are **additive** by convention: enabling a feature may
add API, never remove or change it. When you write a crate, never make a
feature that breaks code which does not use it, and never use two features
as mutually exclusive switches.

Unification has limits that avoid the obvious problems. Dependencies of
build scripts and procedural macros (which run on the host) are resolved
separately from the code you ship, dev-dependencies only affect test builds,
and target-specific dependencies only affect their target.

### Where things live

| Location | Contents |
|---|---|
| `~/.cargo/registry/index/` | Cached index entries |
| `~/.cargo/registry/cache/` | Downloaded `.crate` files, shared by all your projects |
| `~/.cargo/registry/src/` | Unpacked sources; open them to read a dependency's code |
| `~/.cargo/git/` | Git dependencies |
| `target/` in each project | Compiled artifacts for that project |

Each dependency is compiled once per combination of version, features,
profile and target, and the artifact's file name includes a hash of that
combination. Changing a feature or a flag rebuilds only what it affects, and
debug and release builds never mix. To share compiled dependencies between
projects, set one `CARGO_TARGET_DIR` for all of them or use `sccache`.

### Native libraries and `-sys` crates

A crate that wraps a C library is usually split in two: `foo-sys` declares the
raw `extern "C"` functions and finds or builds the library, and `foo` builds a
safe API on top ([FFI with C and C++](ffi.md)). The `-sys` crate's `build.rs`
does what `find_package` and `ExternalProject_Add` do in CMake, typically
choosing between two strategies with a feature:

```toml
[dependencies]
# Either use the system's SQLite, found with pkg-config (or vcpkg on Windows):
rusqlite = "0.43"
# or compile SQLite's C source into your binary with the `cc` crate:
# rusqlite = { version = "0.43", features = ["bundled"] }
```

The `bundled` style is common for game dependencies (SDL, Lua, zstd, mimalloc,
PhysX bindings): the C source ships inside the crate, is built with the `cc`
or `cmake` crate, and is statically linked, so users need only a C compiler.

### What this fixes, compared with C++

| C++ problem | What Cargo does |
|---|---|
| Each library has its own build system to integrate | Every crate has the same `Cargo.toml` and builds the same way |
| Prebuilt binaries must match compiler, standard library, `_ITERATOR_DEBUG_LEVEL`, runtime and flags | Everything is built from source with your compiler and your profile |
| Transitive dependencies are found and built by hand | The whole graph is resolved and built from one line |
| Diamond dependencies with conflicting versions break the ODR | Compatible versions are unified; incompatible ones coexist as distinct types |
| "Works on my machine" because a dependency changed | `Cargo.lock` pins every version |
| Header-only versus compiled libraries | No headers; every crate is compiled the same way |
| Optional parts of a library through CMake options | Features, declared in `Cargo.toml` and visible in `cargo tree` |
| Cross-compiling dependencies | `rustup target add` and `cargo build --target`, for pure-Rust crates |

### What it does not fix

- **Native dependencies are still native.** A `-sys` crate needs a C
  toolchain, and cross-compiling one needs a cross C toolchain. This is the
  same problem you have in C++, contained in one crate.
- **No binary distribution.** Building from source means the first build of a
  large graph takes minutes. `cargo check`, incremental builds, sccache and
  keeping heavy generic code out of low-level crates
  ([Project organization](../foundations/project-organization.md#compile-times-and-crate-boundaries))
  are the mitigations.
- **No stable ABI between Rust crates.** You cannot ship a closed-source Rust
  library as a `.rlib` for others to link. Closed-source code is shipped as a
  C ABI library, a binary, or source in a private registry.
- **Mixing with an existing C++ build.** Cargo does not build your C++ code.
  In a CMake project, Corrosion lets CMake drive Cargo
  ([FFI with C and C++](ffi.md#rust-inside-a-cmake-project)).

## Can I trust this crate?

crates.io does not review code. Anyone can publish anything, and each
dependency brings its own dependencies along. This is the same risk as
vendoring a library from GitHub in C++, except that it is so easy to add a
crate that you can end up with hundreds of them without noticing. Two facts
make it more serious than it first looks:

- **Building runs code.** A dependency's `build.rs` and its procedural macros
  run on your machine during `cargo build`, with your user's permissions, the
  way a CMake script does. Malicious crates have used this to steal
  credentials from developer machines.
- **Published source may differ from the repository.** crates.io stores what
  the owner uploaded. The GitHub link on the crate page is a claim, not a
  guarantee. A package published from a git checkout includes a
  `.cargo_vcs_info.json` file with the commit it was built from, which lets
  you, or a tool, compare the two.

### Signals to check before adding a dependency

| Question | Where to look |
|---|---|
| Is it widely used? | Recent downloads and the Dependents tab |
| Is it maintained? | Date of the last release, open issues and pull requests, a changelog |
| Who maintains it? | Owners on the crate page; one maintainer or a team or organization |
| How much does it pull in? | `cargo tree -p <crate>` after adding it, or the dependency list on the crate page |
| How much `unsafe` does it use? | Search the source; `cargo geiger` counts it per dependency |
| Does it run code at build time? | A `build.rs` file, or a dependency on `proc-macro2` and `syn` |
| Is the name right? | Typosquats such as `serde-json` for `serde_json` exist. Copy names from the docs |
| Is the license compatible? | The `license` field; most crates are `MIT OR Apache-2.0` |

A crate at version `0.x` is not necessarily immature. Many foundational
crates stayed at `0.x` for years. What matters is how it is maintained and
who depends on it.

### Tools that check for you

```sh
cargo install cargo-audit cargo-deny

cargo audit          # known vulnerabilities, from the RustSec advisory database
cargo deny check     # vulnerabilities, licenses, banned crates, duplicate versions, sources
cargo tree -d        # crates that appear in more than one version
cargo tree -i syn    # who depends on `syn`, and why
```

The [RustSec advisory database](https://rustsec.org) records vulnerabilities,
unmaintained crates and yanked versions, and `cargo audit` checks your
`Cargo.lock` against it. Run it in CI ([Testing chapter](testing-and-tooling.md#a-ci-setup)).

`cargo deny` is driven by a `deny.toml` in your repository. A small one for a
game project:

```toml
[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause", "Zlib", "Unicode-3.0"]

[bans]
multiple-versions = "warn"          # duplicate versions cost build time and binary size

[sources]
unknown-registry = "deny"           # only crates.io unless you list others
unknown-git = "deny"                # no surprise git dependencies
```

For a stricter policy, [cargo-vet](https://mozilla.github.io/cargo-vet/)
records which crate versions someone on your team (or an organization you
trust, such as Mozilla or Google) has actually reviewed, and fails the build
when a new, unreviewed version comes in. [diff.rs](https://diff.rs) shows what
changed between two published versions of a crate, which is the code you
would be trusting when you run `cargo update`.

## Using crates well

**Turn off what you do not use.** Many crates enable optional features by
default. Disabling them reduces build time and the amount of code you trust:

```toml
[dependencies]
image = { version = "0.25", default-features = false, features = ["png"] }
```

**Commit `Cargo.lock` and update on purpose.** The lock file pins every
transitive version, so an update is a diff you can review:

```sh
cargo update --dry-run              # what would change
cargo update -p image               # update one crate (and what it needs)
cargo update -p image --precise 0.25.6
```

**Declare the oldest compiler you support** with `rust-version` in
`Cargo.toml`. Cargo's resolver then prefers dependency versions that still
build with that compiler, and anyone with an older toolchain gets a clear
error instead of a confusing one.

**Use a fork while waiting for a fix.** When a dependency has a bug, fix it in
a fork and point the whole dependency graph at your fork with `[patch]`, even
where the crate is a dependency of a dependency:

```toml
[patch.crates-io]
winit = { git = "https://github.com/you/winit", branch = "fix-ime-crash" }
```

When the fix is released upstream, delete the patch. This is the clean version
of the "we carry a local patch to third_party/" workflow in C++ engines.

**Vendor for offline or audited builds.** `cargo vendor` copies the source of
every dependency into a directory and prints the configuration that makes
Cargo build from it, with no network. Console and studio build farms often
need this.

**Private registries** are supported for code that cannot be public: list
them under `[registries]` in `.cargo/config.toml` and add
`registry = "studio"` to a dependency. Several commercial and self-hosted
registry servers exist.

## Contributing to other people's crates

Most crates live on GitHub, and the workflow is the usual open-source one:

1. Read `CONTRIBUTING.md` if it exists, and look for an existing issue. For
   anything larger than a small fix, open an issue first and agree on the
   approach.
2. Fork and clone the repository, and check that the tests pass before you
   change anything: `cargo test`, often `cargo test --all-features` too.
3. Test your change in your own project with `[patch.crates-io]` pointing at
   your local clone (`path = "../winit"`). This is the quickest way to prove
   that the fix works.
4. Before opening the pull request, run `cargo fmt` and `cargo clippy`. Most
   projects check both in CI, and Rust reviewers expect formatted code.
5. Add a test that fails without your fix, and an entry in `CHANGELOG.md` if
   the project keeps one.

Contributions that are always welcome and often easier than code: a minimal
reproduction for an open bug, a documentation fix, an example, or
confirmation that a fix works on your platform. Console and XR platforms in
particular are rarely tested by maintainers.

crates.io itself is open source too, at
[rust-lang/crates.io](https://github.com/rust-lang/crates.io). Its issue
tracker is the place to report a problem with the registry, and malware or
abuse should go to the security contact on the [crates.io policies
page](https://crates.io/policies) rather than to a public issue.

## Publishing your own crate

### Prepare the package

crates.io requires a license and a description. Add the rest so people can
find the crate and trust it:

```toml
[package]
name = "frame-pacer"
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
description = "Frame pacing and fixed-timestep helpers for game loops"
license = "MIT OR Apache-2.0"
repository = "https://github.com/you/frame-pacer"
readme = "README.md"
keywords = ["gamedev", "game-loop", "timestep"]   # up to five
categories = ["game-development"]                  # from crates.io's fixed list
exclude = ["assets/", ".github/"]                  # keep the package small
```

`MIT OR Apache-2.0` is the Rust convention: users may pick either license, and
the combination is compatible with almost every project. Add both license
files to the repository.

Document the public API with `///` comments, because docs.rs will publish them
the moment the crate is released, and doc examples run as tests
([Testing chapter](testing-and-tooling.md#documentation-tests)). Two crate
attributes are a good default for a library:

```rust,ignore
// src/lib.rs
#![forbid(unsafe_code)]       // a promise users can check; drop it if you need unsafe
#![warn(missing_docs)]        // every public item gets documentation
```

### Publish

```sh
cargo package --list          # exactly which files will be uploaded
cargo publish --dry-run       # builds the package as a user would, without uploading
cargo login                   # once: paste an API token from crates.io settings
cargo publish
```

`cargo publish` builds the packaged tarball in isolation, so a file that is
missing from the package or a dependency given only by `path` fails here
rather than for your users. Path and git dependencies must also have a
`version` to be published; crates.io never depends on code outside the
registry. In a workspace, `cargo publish --workspace` publishes every member in
dependency order.

### Versioning

Your version number is a promise ([semver](https://semver.org)). Before 1.0,
Cargo treats the first non-zero component as the major version, so `0.3.x` to
`0.4.0` is a breaking change and `0.3.1` to `0.3.2` is not. Breaking changes
in Rust include more than in C++: making a public field private, adding a
variant to a public enum (unless it is `#[non_exhaustive]`), adding a required
method to a public trait, or removing a trait implementation.
[cargo-semver-checks](https://github.com/obi1kenobi/cargo-semver-checks)
compares your API with the last published version and reports changes that
need a major bump. Run it before each release.

If you publish a broken version, publish a fixed one and yank the broken one
with `cargo yank --version 0.1.1`.

### Release from CI

For a crate other people depend on, publish from CI rather than from your
laptop. With **trusted publishing**, crates.io accepts a short-lived token
from a specific GitHub Actions workflow, so there is no long-lived API token to
leak. Publish the first version by hand, enable trusted publishing for the
repository and workflow in the crate's settings on crates.io, and then:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release
    permissions:
      id-token: write           # lets the job request the short-lived token
    steps:
      - uses: actions/checkout@v4
      - uses: rust-lang/crates-io-auth-action@v1
        id: auth
      - run: cargo publish
        env:
          CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}
```

Tools such as `cargo-release` and `release-plz` automate the rest: bumping
versions, updating the changelog, tagging and publishing.

### Publishing only on GitHub

You do not have to use crates.io. Code on GitHub (or any git host) is already
usable as a dependency:

```toml
[dependencies]
frame-pacer = { git = "https://github.com/you/frame-pacer", tag = "v0.1.0" }
```

| | crates.io | Git only |
|---|---|---|
| Version resolution | Semver ranges; duplicates unified | One pinned commit per dependency |
| Documentation | Built on docs.rs automatically | `cargo doc`, hosted yourself (GitHub Pages) |
| Usable by crates on crates.io | Yes | No: published crates cannot depend on git |
| Discoverable | Search, categories, lib.rs | Only through your own links |
| Takes back a release | Yank only | You control the repository |

Git-only fits internal tools, experiments and crates that are not ready for a
stable name. For anything you want other people to build on, publish to
crates.io, and keep the GitHub repository as the home for issues and pull
requests. Command-line tools can be installed either way: `cargo install
frame-pacer-cli` from crates.io, or `cargo install --git <url>`.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Studios usually combine all of the above: a vetted allowlist of public crates
enforced with `cargo deny`, `cargo vendor` or a registry mirror for build
farms without internet access, a private registry for internal crates shared
between teams, and `[patch]` for the few public crates the studio has forked.
Console SDK bindings are under NDA and cannot be published at all, so they
live in the private registry or as path dependencies.

</div>

## Summary

| C++ | Rust |
|---|---|
| vcpkg, Conan, git submodules | crates.io and Cargo |
| Prebuilt binaries per compiler and configuration | Source packages built with your flags |
| `third_party/` with local patches | `[patch.crates-io]` pointing at a fork |
| Checked-in third-party sources | `cargo vendor` |
| Manual CVE tracking | `cargo audit` with the RustSec database |
| License review spreadsheet | `cargo deny check licenses` |
| Doxygen output hosted by each project | docs.rs for every published version |
| Internal package server | A private registry |

## Exercises

1. Pick a crate you might use in an engine (for example `image` or `gltf`).
   Add it to a new project, run `cargo tree`, and count the crates it brings
   in. Then disable its default features and count again.
2. Run `cargo audit` and `cargo deny init && cargo deny check` on one of your
   projects. Which licenses appear?
3. Find a crate whose GitHub repository has a bug you have hit, fix it in a
   fork, and use `[patch.crates-io]` to build your project against the fix.
4. Create a small library crate with documented public items, run
   `cargo package --list` and `cargo publish --dry-run`, and fix every warning.
   Publish it if you have something worth sharing.
