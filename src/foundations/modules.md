# Modules and files

C++ organizes code with three unrelated mechanisms: files and `#include` for
compilation, namespaces for names, and access specifiers for visibility
(plus static libraries, `static` linkage and anonymous namespaces for "private
to this file"). C++20 modules try to unify them, slowly. Rust has one system:
**modules** give you files, namespaces and visibility at once, and **crates**
group modules into units of compilation.

This chapter covers:

- declaring modules and mapping them to files,
- `pub` and the visibility levels,
- `use` paths and re-exports.

Where methods can be defined, how to lay out a larger project and how crates
affect compile times need `impl` blocks and traits, so they come later, in
[Project organization](project-organization.md).

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

<a id="where-methods-live"></a><a id="方法写在哪里"></a>

## Later: methods and larger projects

Modules also decide where a type's methods can be defined and which traits a
caller has to import. That depends on `impl` blocks and traits, so it is
covered in [Project organization](project-organization.md#where-methods-live),
together with workspace layout and compile times.

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
2. Make `Vec2`'s fields private. What can code outside `math` no longer do?
3. In a workspace with two crates, mark a function `pub(crate)` and try to call
   it from the other crate. Read the error.
