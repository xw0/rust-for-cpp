# Testing, benchmarks and tooling

In C++ you choose a test framework (GoogleTest, Catch2, doctest), a benchmark
library, a formatter, a linter and a documentation generator, then wire them
into CMake. Rust ships with all of them, and every Rust project uses the same
ones, so `cargo test` works in any repository you clone.

This chapter covers:

- unit tests, integration tests and documentation tests,
- testing things that should panic, and tests that return `Result`,
- benchmarks with criterion,
- property-based testing and fuzzing,
- rustfmt, Clippy and rustdoc,
- a CI setup.

## Unit tests

Unit tests live in the same file as the code, in a module compiled only for
tests:

```rust
pub fn aabb_overlap(a: ([f32; 2], [f32; 2]), b: ([f32; 2], [f32; 2])) -> bool {
    a.0[0] < b.1[0] && b.0[0] < a.1[0] && a.0[1] < b.1[1] && b.0[1] < a.1[1]
}

fn clamp01(x: f32) -> f32 {          // private functions are testable too
    x.max(0.0).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;                     // everything from the parent module, private items included

    #[test]
    fn overlapping_boxes() {
        assert!(aabb_overlap(([0.0, 0.0], [2.0, 2.0]), ([1.0, 1.0], [3.0, 3.0])));
    }

    #[test]
    fn touching_edges_do_not_overlap() {
        assert!(!aabb_overlap(([0.0, 0.0], [1.0, 1.0]), ([1.0, 0.0], [2.0, 1.0])));
    }

    #[test]
    fn clamps() {
        assert_eq!(clamp01(-1.0), 0.0);
        assert_eq!(clamp01(0.25), 0.25);
        assert_eq!(clamp01(7.0), 1.0, "values above 1 must clamp");
    }

    #[test]
    #[should_panic(expected = "index out of bounds")]
    fn out_of_range_panics() {
        let v = vec![1, 2, 3];
        let i = v.len();
        let _ = v[i];
    }

    #[test]
    fn parse_or_fail() -> Result<(), std::num::ParseIntError> {
        let n: i32 = "42".parse()?;   // tests may return Result and use ?
        assert_eq!(n, 42);
        Ok(())
    }

    #[test]
    #[ignore = "slow: run with cargo test -- --ignored"]
    fn bake_lightmap() {}
}
# fn main() {}
```

`cargo test` builds the crate in test mode, runs every `#[test]` function on a
thread pool in parallel, and reports results. Useful variations:

```sh
cargo test                     # everything
cargo test overlap             # only tests whose name contains "overlap"
cargo test -- --nocapture      # show println! output from passing tests
cargo test -- --test-threads=1 # run serially (tests sharing a GPU, say)
cargo test --release           # optimized build
```

Because unit tests are inside the module, they can test private functions
without the `#define private public` tricks or friend declarations C++ tests
sometimes resort to.

## Integration tests

Files in a top-level `tests/` directory are compiled as separate crates that
use your library through its public API only, like an external user:

```text
my-engine/
├── src/lib.rs
└── tests/
    ├── load_scene.rs
    └── common/mod.rs     # shared helpers (not a test file itself)
```

```rust,ignore
// tests/load_scene.rs
use my_engine::scene::Scene;

#[test]
fn loads_sample_scene() {
    let scene = Scene::load("tests/data/sample.ron").unwrap();
    assert_eq!(scene.entities().count(), 12);
}
```

## Documentation tests

Code examples in documentation comments are compiled and run by `cargo test`,
so documentation cannot rot:

```rust
/// Linearly interpolates between `a` and `b`.
///
/// ```
/// # use mylib::lerp;   // hidden line: not shown in the docs
/// assert_eq!(lerp(0.0, 10.0, 0.25), 2.5);
/// ```
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
# fn main() { assert_eq!(lerp(0.0, 10.0, 0.25), 2.5); }
```

Every example in this book is tested the same way: the build runs `mdbook
test`, which compiles and runs each one as a doc test.

## Benchmarks

The standard benchmark harness is still unstable, so the community standard is
**criterion**, which runs each benchmark enough times for statistically sound
results and reports changes against the previous run:

```rust,ignore
// benches/culling.rs   (with [[bench]] name = "culling", harness = false in Cargo.toml)
use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn bench_frustum(c: &mut Criterion) {
    let boxes = make_random_aabbs(10_000);
    let frustum = Frustum::from_view_proj(&camera_matrix());
    c.bench_function("cull 10k aabbs", |b| {
        b.iter(|| frustum.cull(black_box(&boxes)))
    });
}

criterion_group!(benches, bench_frustum);
criterion_main!(benches);
```

`cargo bench` runs them. `std::hint::black_box` stops the optimizer from
deleting the work, like `benchmark::DoNotOptimize`.

## Property tests and fuzzing

- **proptest** and **quickcheck** generate random inputs and shrink failures to
  a minimal case: "for all vectors `v`, `normalize(v).length()` is 1 or `v` is
  zero".
- **cargo-fuzz** runs libFuzzer against a function that takes `&[u8]`. Point it
  at every parser of untrusted data: asset formats, network packets, save
  files. Fuzzing safe Rust finds panics and logic bugs; fuzzing unsafe Rust,
  combined with sanitizers, finds memory bugs.

## Formatting, linting and docs

| Tool | Command | C++ analogue |
|---|---|---|
| rustfmt | `cargo fmt` (`--check` in CI) | clang-format |
| Clippy | `cargo clippy` (`-- -D warnings` in CI) | clang-tidy |
| rustdoc | `cargo doc --open` | Doxygen |
| cargo-deny / cargo-audit | `cargo deny check` | License and vulnerability scanners |

**rustfmt** has one standard style with few options, and almost every Rust
project uses it, so all Rust code looks alike. Format on save and stop
discussing style.

**Clippy** has hundreds of lints, from correctness (`clippy::eq_op`: `x == x`)
to performance (`clippy::large_enum_variant`) and style. It is quite good at
teaching idiomatic Rust: when it suggests a rewrite, read why. Configure lints
in `Cargo.toml`:

```toml
[lints.clippy]
undocumented_unsafe_blocks = "warn"
too_many_arguments = "allow"
```

**rustdoc** builds HTML documentation from `///` comments, including your
dependencies' documentation, all cross-linked. Every crate on crates.io has its
documentation on [docs.rs](https://docs.rs).

## A CI setup

A typical GitHub Actions job for a Rust project:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test --all-targets
```

## Summary

| C++ | Rust |
|---|---|
| GoogleTest / Catch2 | Built-in `#[test]`, `cargo test` |
| `EXPECT_EQ`, `ASSERT_TRUE` | `assert_eq!`, `assert!` (with optional messages) |
| `EXPECT_DEATH` | `#[should_panic]` |
| Test executables registered in CMake | `tests/` directory, discovered automatically |
| Google Benchmark | criterion |
| libFuzzer | cargo-fuzz |
| clang-format / clang-tidy | rustfmt / Clippy |
| Doxygen | rustdoc; examples are tested |

## Exercises

1. Add tests for `aabb_overlap` covering boxes that contain each other and
   boxes with zero area. Do your tests pass? Should they?
2. Write a doc test for a `fn smoothstep(e0: f32, e1: f32, x: f32) -> f32`
   showing three example values, and run it with `cargo test --doc`.
3. Run `cargo clippy` on a project from an earlier chapter and fix every
   warning. Which lint taught you something?
