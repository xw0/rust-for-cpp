# Modules and project organization

C++ organizes code with three unrelated mechanisms: files and `#include` for
compilation, namespaces for names, and access specifiers for visibility
(plus static libraries, `static` linkage and anonymous namespaces for "private
to this file"). C++20 modules try to unify them, slowly. Rust has one system:
**modules** give you files, namespaces and visibility at once, and **crates**
group modules into units of compilation.

This chapter covers:

- declaring modules and mapping them to files,
- `pub` and the visibility levels,
- `use` paths and re-exports,
- laying out a larger project,
- how crate boundaries affect compile times.

## Modules are namespaces with visibility

```rust
mod math {
    pub struct Vec2 {
        pub x: f32,
        pub y: f32,
    }

    pub fn length(v: &Vec2) -> f32 {
        sqrt_approx(v.x * v.x + v.y * v.y)
    }

    // Private: visible only inside `math` and its children.
    fn sqrt_approx(x: f32) -> f32 {
        x.sqrt()
    }

    pub mod consts {
        pub const TAU: f32 = std::f32::consts::TAU;
    }
}

use math::{Vec2, consts::TAU};

fn main() {
    let v = Vec2 { x: 3.0, y: 4.0 };
    println!("{} {}", math::length(&v), TAU);
    // math::sqrt_approx(2.0);   // error[E0603]: function `sqrt_approx` is private
}
```

Everything is **private by default**: to its module and the module's
descendants. `pub` makes an item visible to whoever can see the module. Struct
fields have their own visibility, so a struct can be public while its fields
stay private, which is how types enforce invariants (only the module's own
functions can construct or modify them).

| Visibility | Visible to |
|---|---|
| (nothing) | This module and its children |
| `pub(super)` | The parent module |
| `pub(crate)` | The whole crate, but not other crates |
| `pub` | Everyone who can reach the module |

`pub(crate)` covers what C++ projects do with "internal" headers and
`detail` namespaces, with the compiler enforcing it.

## Modules and files

`mod name { ... }` defines a module inline. `mod name;` (with a semicolon) tells
the compiler to load it from a file:

```text
src/
├── main.rs            // mod render; mod world;
├── render.rs          // mod pipeline; mod texture;   (render's own code here)
├── render/
│   ├── pipeline.rs
│   └── texture.rs
└── world.rs
```

```rust,ignore
// src/main.rs
mod render;            // loads src/render.rs
mod world;             // loads src/world.rs

fn main() {
    let mut r = render::Renderer::new();
    let w = world::World::default();
    r.draw(&w);
}
```

```rust,ignore
// src/render.rs
mod pipeline;          // loads src/render/pipeline.rs
mod texture;           // loads src/render/texture.rs

pub use texture::Texture;   // re-export: users write render::Texture

pub struct Renderer { /* ... */ }
```

The module tree is declared explicitly from the crate root (`main.rs` or
`lib.rs`), and files that are not declared are not compiled. There is no build
script listing sources and no include path. (An older layout, `render/mod.rs`
instead of `render.rs`, also works and you will see it in existing code.)

## `use` paths

`use` brings names into scope, like `using` declarations. Paths start from:

| Path start | Meaning |
|---|---|
| `crate::` | The root of the current crate |
| `self::` | The current module |
| `super::` | The parent module |
| `some_crate::` | An external crate (a dependency) |
| `std::`, `core::` | The standard library |

```rust,ignore
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::render::{Renderer, Texture};
use super::world::World as GameWorld;    // rename on import
use glam::*;                             // glob import: use sparingly
```

Re-exporting with `pub use` lets a crate present a clean public API that does
not mirror its internal file layout. Large crates typically have a `prelude`
module that re-exports the most common items, so users can write
`use bevy::prelude::*;`.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">What you no longer need</span>

- **Include guards and `#pragma once`**: modules are declared once in the tree.
- **Forward declarations**: items can be used before or after their
  definition, in any module.
- **The ODR**: every item has one definition, in one module.
- **Header/source pairs**: a module's public items *are* its interface.
- **Pimpl for compile firewalls**: private fields of a struct are already hidden
  from other crates' code. (Changing them still triggers recompilation of
  dependents; see below.)

</div>

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
| `namespace` | `mod` |
| `#include` + header file | `mod name;` declares a file as a module; `use` imports names |
| `using std::vector;` | `use std::vec::Vec;` |
| `public` / `private` (classes) | `pub` / private by default (modules and fields) |
| Anonymous namespace, `static` functions | Private items |
| `detail` namespace, internal headers | `pub(crate)` |
| Static library | Library crate |
| Umbrella header | `pub use` re-exports, `prelude` module |

## Exercises

1. Turn the inline `math` module above into a file `src/math.rs` with a
   submodule `src/math/consts.rs`. Which `mod` lines do you need, and where?
2. Make `Vec2`'s fields private and add `Vec2::new` and getters. What can code
   outside `math` no longer do?
3. In a workspace with two crates, mark a function `pub(crate)` and try to call
   it from the other crate. Read the error.
