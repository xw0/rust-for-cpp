# Macros

The C preprocessor is a text substitution engine that knows nothing about
C++: it ignores scopes, evaluates arguments more than once, and produces errors
in code you never wrote. C++ programmers learn to minimize it and move what
they can into templates and `constexpr`. Rust macros are different in kind.
They operate on the syntax tree, they are hygienic (they cannot accidentally
capture or shadow your variables), and they are used routinely: `println!`,
`vec!`, `format!` and `#[derive]` are all macros.

This chapter covers:

- declarative macros with `macro_rules!`,
- hygiene, and why the classic preprocessor bugs cannot happen,
- derive, attribute and function-like procedural macros,
- when to write a macro, and when a generic or `const fn` is better.

## `macro_rules!`

A declarative macro is a set of pattern-and-template rules matched against the
macro's input tokens:

```rust
/// Build a HashMap from `key => value` pairs.
macro_rules! hashmap {
    () => { std::collections::HashMap::new() };
    ( $( $key:expr => $value:expr ),+ $(,)? ) => {{
        let mut m = std::collections::HashMap::new();
        $( m.insert($key, $value); )+
        m
    }};
}

fn main() {
    let empty: std::collections::HashMap<u8, u8> = hashmap!();
    let formats = hashmap! {
        "png" => 4,
        "jpg" => 3,
        "exr" => 16,
    };
    println!("{} {:?}", empty.len(), formats.get("exr"));
}
```

The pieces:

- `$key:expr` captures a **fragment** of a specific syntactic kind. Common
  kinds: `expr`, `ident` (a name), `ty` (a type), `tt` (any single token tree),
  `literal`, `pat`, `block`, `item`.
- `$( ... ),+` repeats one or more times with a comma separator (`*` for zero
  or more, `?` for optional). The same `$( ... )+` in the template repeats the
  output once per match.
- Rules are tried in order, like `match` arms.

Because fragments are parsed syntax, not text, `$key` is always a complete
expression. Passing `a + b` to a macro that computes `$x * 2` gives
`(a + b) * 2`, never `a + b * 2`.

## Hygiene

```rust
macro_rules! square {
    ($x:expr) => {{
        let tmp = $x;      // evaluated once, into a local the caller cannot see
        tmp * tmp
    }};
}

fn main() {
    let tmp = 3;
    let mut calls = 0;
    let mut next = || { calls += 1; 4 };
    println!("{}", square!(tmp + 1));   // 16, not affected by the macro's own `tmp`
    println!("{}", square!(next()));     // 16, and next() runs once
    println!("calls = {calls}");
}
```

Both classic preprocessor bugs are gone. The macro's `tmp` and the caller's
`tmp` are different variables (hygiene), and the argument is evaluated once
because the macro binds it to a local, which it can do because it expands to a
block expression rather than raw text.

## A practical example: reducing boilerplate

Macros shine when you need to generate many similar items, the kind of code
C++ engines generate with X-macros or external scripts. For example,
implementing the same operators for several vector types:

```rust
use std::ops::{Add, Mul, Sub};

macro_rules! impl_vec_ops {
    ($name:ident { $($field:ident),+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Default)]
        pub struct $name { $(pub $field: f32),+ }

        impl Add for $name {
            type Output = $name;
            fn add(self, o: $name) -> $name { $name { $($field: self.$field + o.$field),+ } }
        }
        impl Sub for $name {
            type Output = $name;
            fn sub(self, o: $name) -> $name { $name { $($field: self.$field - o.$field),+ } }
        }
        impl Mul<f32> for $name {
            type Output = $name;
            fn mul(self, s: f32) -> $name { $name { $($field: self.$field * s),+ } }
        }
        impl $name {
            pub fn dot(self, o: $name) -> f32 { 0.0 $(+ self.$field * o.$field)+ }
        }
    };
}

impl_vec_ops!(Vec2 { x, y });
impl_vec_ops!(Vec3 { x, y, z });
impl_vec_ops!(Vec4 { x, y, z, w });

fn main() {
    let a = Vec3 { x: 1.0, y: 2.0, z: 3.0 };
    let b = Vec4 { x: 1.0, ..Default::default() };
    println!("{:?} {} {}", a + a * 2.0, a.dot(a), b.dot(b));
}
```

To see what a macro expands to, use `cargo expand` (the `cargo-expand` tool),
or **Tools → Expand macros** on the Playground. That is the equivalent of `-E`,
but the output is formatted Rust.

## Procedural macros

Procedural macros are Rust functions, compiled as a separate crate, that take a
token stream and return a token stream. They run inside the compiler and can do
arbitrary analysis. There are three kinds:

| Kind | Syntax | Example |
|---|---|---|
| Derive | `#[derive(Serialize)]` on a struct or enum | `serde`, `bytemuck::Pod`, `thiserror::Error` |
| Attribute | `#[my_attr(...)]` on an item | `#[tokio::main]`, `#[test]`-like frameworks, profiling instrumentation |
| Function-like | `my_macro!(...)` | `sqlx::query!` (checks SQL at compile time), `include_wgsl!` |

The most important use for an engine is **derive**, which replaces most of
what C++ engines do with reflection systems, code generators and `REFLECT()`
macros:

```rust,ignore
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
struct LightComponent {
    color: [f32; 3],
    intensity: f32,
    #[serde(default)]
    casts_shadows: bool,
    #[serde(skip)]
    shadow_map: Option<TextureHandle>,   // runtime-only, not saved
}

// Now LightComponent can be read and written as JSON, RON, TOML, bincode, ...
let light: LightComponent = ron::from_str("(color: (1, 0.9, 0.8), intensity: 4.0)")?;
```

The derive sees the struct definition (field names, types, attributes) at
compile time and generates the serialization code. No runtime type
information, no registration step, no separate code generator in the build.

Writing your own procedural macro uses the `syn` (parse Rust syntax) and
`quote` (generate Rust code) crates. It is worth it for engine-wide patterns,
such as deriving editor inspectors or component registration. A complete
example, an attribute macro and a derive with its own helper attribute, is in
[Declaring your own attributes](../intro/syntax.md#declaring-your-own-attributes).

## Macro, generic, or `const fn`?

- Use a **function** or **generic** when you can. They type-check, show up
  properly in documentation, and give better error messages.
- Use **`const fn`** for compile-time computation (lookup tables, hashing
  string IDs at compile time).
- Use **`macro_rules!`** when you need something functions cannot do: a
  variable number of arguments, generating items (structs, impls), or taking
  syntax that is not a value (field names, types).
- Use a **derive macro** to generate trait implementations from a type's
  structure: serialization, reflection, GPU layout checks.

## Summary

| C / C++ | Rust |
|---|---|
| `#define` text substitution | `macro_rules!` on syntax trees, hygienic |
| `#include` | `mod` / `use` (no textual inclusion) |
| `#ifdef` | `#[cfg(...)]` attributes |
| Variadic macros, X-macros | Repetitions `$( ... ),*` |
| Reflection macros / code generators | Derive macros (`serde`, `bytemuck`, custom) |
| `cpp -E` | `cargo expand` |
| `__FILE__`, `__LINE__` | `file!()`, `line!()`, `module_path!()` |
| `static_assert` | `const _: () = assert!(...);` |

## Exercises

1. Write `macro_rules! max!` that accepts one or more expressions and returns the
   largest, evaluating each argument exactly once.
2. Add a `length` method to `impl_vec_ops!` using `dot`.
3. Write a `const fn fnv1a(s: &str) -> u64` and use it to define
   `const PLAYER_TAG: u64 = fnv1a("player");`. Compare with doing it in a
   macro.
