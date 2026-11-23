# Project organization

The [Modules and files](modules.md) chapter covered how modules map to files
and how `use` and `pub` work. Now that `impl` blocks and traits are familiar,
this chapter covers the questions that come up once a project grows past a few
files:

- where methods can be defined, and what callers have to import,
- laying out a workspace of crates,
- how crate boundaries affect compile times.

## Where methods live

In C++, a member function is visible where its declaration has been
`#include`d. Rust has no textual inclusion, so the question becomes: if one
file defines a type and another file adds methods to it, what do callers have
to import?

**For your own types: nothing extra.** An `impl` block can sit in any module of
the crate that defines the type. Its methods belong to the type, not to the
file they were written in, so anyone who can reach a value of the type can call
them (subject to `pub`). There is nothing to import for the second file:

```rust
mod mesh {
    pub struct Mesh { pub verts: Vec<f32> }
}

mod mesh_ops {                         // could be src/mesh_ops.rs
    use crate::mesh::Mesh;
    impl Mesh {
        pub fn vertex_count(&self) -> usize { self.verts.len() / 3 }
    }
}

mod game {
    use crate::mesh::Mesh;             // only the type; no `use crate::mesh_ops`
    pub fn run() {
        let m = Mesh { verts: vec![0.0; 9] };
        println!("{} vertices", m.vertex_count());
    }
}

fn main() { game::run(); }
```

`use` only creates a short name. You need `use crate::mesh::Mesh` to *write*
`Mesh` (to construct one or name it in a signature), not to call methods on a
value you already have.

**For other crates' types: an extension trait, which you do import.** You
cannot write `impl Vec<f32> { ... }` outside the standard library. Instead you
define a trait and implement it for the foreign type. Trait methods are only
callable where the trait is in scope, so callers must `use` the trait:

```rust
mod ext {
    pub trait Describe {
        fn describe(&self) -> String;
    }
    impl Describe for Vec<f32> {
        fn describe(&self) -> String { format!("{} floats", self.len()) }
    }
}

fn main() {
    use crate::ext::Describe;          // remove this line: "no method named `describe`"
    let v = vec![1.0_f32, 2.0, 3.0];
    println!("{}", v.describe());
}
```

This is the one place where Rust resembles "include it to see it", and it is
deliberate: two crates can add a method with the same name to the same type,
and only the traits you import take part in method lookup. The compiler's
error message names the trait to import when you forget.

## Organizing a larger project

A pattern that scales well:

```text
my-engine/                  (a workspace, see the Cargo chapter)
├── Cargo.toml
├── crates/
│   ├── engine-core/        math, handles, logging. Depends on almost nothing.
│   ├── engine-ecs/         entities, components, scheduling
│   ├── engine-render/      GPU abstraction; depends on core
│   ├── engine-assets/      loading, caching, hot reload
│   └── engine/             the public facade: re-exports the others
└── games/
    └── demo/               a binary crate using `engine`
```

Inside each crate:

- `lib.rs` declares modules and re-exports the public API. Keep it short.
- One module per concept (`texture.rs`, `pipeline.rs`), not per type. Rust
  files are routinely several hundred lines.
- Put unit tests at the bottom of each file in a `#[cfg(test)] mod tests`
  ([Testing chapter](../systems/testing-and-tooling.md)).
- Keep `pub` surfaces small and use `pub(crate)` for helpers shared inside the
  crate.

## Compile times and crate boundaries

The crate is the unit of compilation:

- **Within a crate**, the compiler splits work into "codegen units" for
  parallel LLVM optimization, but type checking and borrow checking run over
  the whole crate. A change anywhere in a crate recompiles that crate
  (incrementally, reusing what it can).
- **Across crates**, a change to crate A rebuilds every crate that depends on
  A. Crates that do not depend on each other build in parallel.

So the guidance mirrors what you would do with C++ libraries, with the
emphasis shifted:

1. Split along stable interfaces. A math crate that rarely changes can be
   depended on by everything at no cost.
2. Keep the dependency graph wide, not deep: `render`, `audio` and `physics`
   depending only on `core` build in parallel.
3. Generic code is compiled in the crate that *uses* it, like templates.
   Heavy generic code in a low-level crate makes every dependent crate slower
   to build. Where possible, have generic functions do minimal work and call
   a non-generic inner function.
4. Measure with `cargo build --timings`, which produces an HTML report of
   which crates took how long and what ran in parallel.

## Summary

| C++ | Rust |
|---|---|
| Member functions are visible where the class header is included | Inherent methods are callable wherever the type is reachable |
| Free functions that extend a type, found by ADL | Extension traits, which callers must `use` |
| Libraries split along stable interfaces | Crates in a workspace, with a wide dependency graph |
| Templates compiled at each point of use | Generics compiled in the crate that uses them |

## Exercises

1. Move the `impl Mesh` block above into its own file `src/mesh_ops.rs`. Which
   `mod` line do you need, and does the code in `game` change?
2. Remove `use crate::ext::Describe;` from the extension trait example and read
   the compiler's suggestion.
3. Run `cargo build --timings` on a workspace and find the crate on the
   critical path. Could it be split?
