# Reading Rust syntax

Rust borrows most of its punctuation from C and C++, but many symbols mean
something slightly different, and a few are new. `vec![1, 2]` is not a
function call, `&mut x` is not a C++ reference, `'a` is not a character and
`x?` is not half a ternary. This chapter is a decoder: read it once before
Part I, then come back whenever a symbol stops you. Each entry links to the
chapter that explains the idea properly.

This chapter covers:

- one short program that uses most of the symbols, annotated,
- the symbols grouped by job: references, paths and generics, macros and
  attributes, expressions, patterns, lifetimes and literals,
- the "false friends": symbols that look like C++ but behave differently.

## One program, most of the symbols

Read the comments from top to bottom. Every line runs; press **Run** to check.

```rust
#[derive(Debug, Clone, Copy)]          // #[...]: an attribute, here generating trait impls
struct Vec2 { x: f32, y: f32 }

// 'a: a lifetime. The returned reference lives as long as the input slice.
fn longest<'a>(names: &'a [String]) -> Option<&'a String> {
    names.iter().max_by_key(|s| s.len())   // |s| ...: a closure (lambda)
}

fn parse_level(text: &str) -> Result<u32, std::num::ParseIntError> {
    let n = text.trim().parse::<u32>()?;   // ::<u32>: explicit type argument
                                           // ?: return the error early if parsing failed
    Ok(n)
}

fn main() {
    let mut scores = vec![10, 20, 30];     // vec!: a macro (the ! marks every macro call)
    let first = &scores[0];                // &: a shared borrow, read-only
    println!("first = {first}");           // println!: also a macro

    let total = &mut scores;               // &mut: an exclusive borrow, read-write
    total.push(40);                        // method call auto-dereferences: no -> in Rust
    (*total)[0] = 5;                       // *: explicit dereference

    for i in 0..scores.len() {             // 0..n: a range, n excluded (0..=n includes n)
        print!("{} ", scores[i]);
    }
    println!();

    let v = Vec2 { x: 1.0, ..Vec2 { x: 0.0, y: 2.0 } }; // ..base: copy the remaining fields
    let Vec2 { x, .. } = v;                // destructuring; .. ignores the other fields
    println!("{v:?} x={x} y={}", v.y);     // {:?}: Debug formatting

    let names = vec![String::from("ann"), String::from("bartholomew")];
    match longest(&names) {
        Some(n) if n.len() > 5 => println!("long name: {n}"), // =>: match arm, `if` is a guard
        Some(n) => println!("name: {n}"),
        None => println!("no names"),
    }

    let _unused = parse_level(" 7 ");      // _name: a deliberately unused binding
    match parse_level("x") {
        Ok(level) => println!("level {level}"),
        Err(e) => println!("error: {e}"),
    }
}
```

## References and pointers

| Symbol | C++ meaning | Rust meaning | Chapter |
|---|---|---|---|
| `&x` | Address of `x` | A shared borrow of `x`: a non-null, read-only reference. Written at the call site, `f(&x)`, so borrowing is always visible | [Borrowing](../foundations/borrowing.md) |
| `&mut x` | (none) | An exclusive borrow: read-write, and no other reference to `x` may be used while it lives | [Borrowing](../foundations/borrowing.md) |
| `&T`, `&mut T` | `const T&`, `T&` | Reference types. Unlike C++ references they are values: they can be reassigned, stored and compared as pointers are | [Borrowing](../foundations/borrowing.md) |
| `*r` | Dereference | Dereference. Often implicit: method calls and comparisons auto-dereference, so you write `r.len()`, never `r->len()` | [Smart pointers](../foundations/smart-pointers.md) |
| `*const T`, `*mut T` | `const T*`, `T*` | Raw pointers, only dereferenced in `unsafe` | [Unsafe](../systems/unsafe.md) |
| `ref x` | (none) | In a pattern: bind by reference instead of moving | [Enums and match](../foundations/enums-and-match.md) |
| `&&` / `\|\|` | Logical and / or | The same. (`&&x` can also be a reference to a reference) | |

## Paths and generics

| Symbol | C++ meaning | Rust meaning | Chapter |
|---|---|---|---|
| `a::b` | Scope resolution | The same, for modules, types and associated functions: `Vec::new()`, `std::mem::swap` | [Modules](../foundations/modules.md) |
| `a.b()` | Member call | Method call; works through references and smart pointers too | [Traits and generics](../foundations/traits-and-generics.md) |
| `<T>` | Template parameters | Generic parameters, checked against trait bounds when the generic is defined | [Traits and generics](../foundations/traits-and-generics.md) |
| `f::<T>()` | `f<T>()` | The "turbofish": explicit type arguments in an expression, needed because `<` alone would parse as less-than | [Traits and generics](../foundations/traits-and-generics.md) |
| `T: Trait` | `requires Concept<T>` | A trait bound | [Traits and generics](../foundations/traits-and-generics.md) |
| `impl Trait` | (none) | "Some type implementing `Trait`": static dispatch without naming the type | [Traits and generics](../foundations/traits-and-generics.md) |
| `dyn Trait` | Pointer to abstract base | A trait object: dynamic dispatch through a fat pointer | [Traits and generics](../foundations/traits-and-generics.md) |
| `Self`, `self` | (none), `*this` | The implementing type; the receiver | [Traits and generics](../foundations/traits-and-generics.md) |
| `->` | Member access through pointer; trailing return type | Only the return type: `fn f() -> i32` | [Values and types](../foundations/values-and-types.md) |

## Macros and attributes

| Symbol | C++ meaning | Rust meaning | Chapter |
|---|---|---|---|
| `name!(...)` | `!` is logical not | A macro call. The `!` is part of the call syntax, so a macro is never mistaken for a function. `vec![...]`, `println!(...)`, `assert_eq!(...)` | [Macros](../systems/macros.md) |
| `!x` | Logical not | Logical not for `bool`, bitwise not for integers (C++'s `~`) | [Operators](../foundations/operators-and-conversions.md) |
| `#[attr]` | `[[attr]]` | An attribute on the next item: `#[derive(...)]`, `#[test]`, `#[inline]`, `#[repr(C)]` | [Macros](../systems/macros.md) |
| `#![attr]` | (none) | An attribute on the enclosing item, usually the whole crate | [Modules](../foundations/modules.md) |
| `$x` | (none) | A variable inside a `macro_rules!` definition | [Macros](../systems/macros.md) |
| `{x}`, `{:?}` in strings | `std::format` placeholders | The same idea, checked at compile time. `{:?}` uses `Debug` formatting | [Values and types](../foundations/values-and-types.md) |

### Where attributes come from

`#[...]` looks like C++'s `[[...]]`, and some attributes do the same job:
`#[must_use]` is `[[nodiscard]]`, and `#[deprecated]` is `[[deprecated]]`.
But Rust attributes come from three places, and only the first is built into
the language:

| Kind | Examples | Defined by | Imported? |
|---|---|---|---|
| Built-in | `#[repr(C)]`, `#[inline]`, `#[cfg(...)]`, `#[test]`, `#[derive(...)]`, `#[allow(...)]`, `#[must_use]`, `#[deprecated]`, `#[non_exhaustive]` | The compiler. The [Rust Reference](https://doc.rust-lang.org/reference/attributes.html) lists them all | Never |
| Macro | Derives such as `Debug` or `Serialize`; attribute macros such as `#[tokio::main]` | Ordinary Rust code in a crate: the standard library, or a procedural macro crate | Like any other item: std's derives are in the prelude, others come in with `use` or a path |
| Tool | `#[rustfmt::skip]`, `#[allow(clippy::too_many_arguments)]` | rustfmt and Clippy | Never; the compiler only checks the tool name |

**`derive` is a built-in attribute whose arguments are macros.** Each name in
`#[derive(...)]` is a derive macro that generates an `impl` of the trait with
the same name. `#[derive(Clone)]` on `struct Vec2 { x: f32, y: f32 }` writes
roughly `impl Clone for Vec2 { fn clone(&self) -> Self { Vec2 { x: self.x.clone(), y: self.y.clone() } } }`.
The standard derives (`Debug`, `Clone`, `Copy`, `PartialEq`, `Eq`,
`PartialOrd`, `Ord`, `Hash`, `Default`) are in the prelude, so they need no
import. A crate's derive usually has the same name as its trait, and one
`use serde::Serialize;` imports both.

**`repr` is built in** and controls memory layout: `#[repr(C)]` for C-compatible
structs, `#[repr(u8)]` for an enum's tag, `#[repr(align(64))]` for alignment
([Memory layout and performance](../systems/memory-and-performance.md)).

**Placement.** `#[attr]` applies to the item, field, statement or expression
that follows it. `#![attr]` applies to the item it is written inside, and must
come first there: at the top of `lib.rs` or `main.rs` it applies to the whole
crate.

```rust
#![allow(dead_code)]                // inner attribute: applies to the whole crate

#[repr(C)]                          // built in: C layout
#[derive(Debug, Clone, Copy, PartialEq, Default)] // derive macros from std's prelude
struct Vec2 { x: f32, y: f32 }

#[must_use]                         // like [[nodiscard]]
#[inline]                           // a hint, like `inline` in C++
fn length(v: Vec2) -> f32 { (v.x * v.x + v.y * v.y).sqrt() }

#[deprecated(note = "use `length`")] // like [[deprecated]]
fn len(v: Vec2) -> f32 { length(v) }

#[rustfmt::skip]                    // tool attribute: rustfmt keeps this layout
const IDENTITY: [f32; 4] = [
    1.0, 0.0,
    0.0, 1.0,
];

#[cfg(test)]                        // compiled only by `cargo test`
mod tests {
    #[test]
    fn unit_length() {
        assert_eq!(super::length(super::Vec2 { x: 1.0, y: 0.0 }), 1.0);
    }
}

fn main() {
    let a = Vec2 { x: 3.0, y: 4.0 };
    let b = a;                      // Copy: `a` is still usable
    println!("{:?} {} {}", a, a == b, length(b)); // Debug, PartialEq
    println!("{:?}", Vec2::default());            // Default
    #[allow(deprecated)]            // lint attributes work on single statements
    let _ = len(a);
}
```

Attributes from other crates work the same way, and a derive can define
**helper attributes** that are only valid on the item it is deriving:

```rust,ignore
use serde::{Deserialize, Serialize};   // the traits and the derive macros of the same name

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]     // helper attribute, read by serde's derive
struct Settings {
    window_width: u32,
    #[serde(default)]                  // helper attribute on a field
    vsync: bool,
}

#[cfg_attr(feature = "serde", derive(Serialize))] // apply an attribute only if a feature is on
struct EntityId(u32);
```

#### Declaring your own attributes

In C++ you can write `[[my_engine::hot]]` anywhere, and a compiler that does
not recognize it ignores it. Rust has no syntax for declaring an attribute and
does not ignore unknown ones: `#[hot]` with no definition in scope is a
compile error. A custom attribute is always a **procedural macro**, a function
that receives the code the attribute is attached to and returns the code that
replaces it. There are two ways to declare one:

| You want | Declare it with | It receives |
|---|---|---|
| `#[timed]` on a function, module or type | `#[proc_macro_attribute] pub fn timed(...)` | The attribute's arguments and the item; it returns a replacement item |
| `#[derive(Inspect)]` plus a helper `#[inspect(skip)]` on fields | `#[proc_macro_derive(Inspect, attributes(inspect))]` | The type definition; it returns extra items, such as an `impl`. The `attributes(...)` list declares the helper attributes |

Procedural macros must live in their own crate, marked as a `proc-macro`
crate, because the compiler builds and runs them before it compiles the code
that uses them. A minimal setup is a workspace with two crates:

```text
game/
├── Cargo.toml               [workspace] members = ["game", "game-macros"]
├── game-macros/
│   ├── Cargo.toml
│   └── src/lib.rs           the macros
└── game/
    ├── Cargo.toml           [dependencies] game-macros = { path = "../game-macros" }
    └── src/main.rs          uses them
```

```toml
# game-macros/Cargo.toml
[package]
name = "game-macros"
version = "0.1.0"
edition = "2024"

[lib]
proc-macro = true

[dependencies]
syn = { version = "2", features = ["full"] }   # parses Rust code into a syntax tree
quote = "1"                                     # turns Rust-like templates back into code
```

The macros crate defines one attribute macro and one derive with a helper
attribute:

```rust,ignore
// game-macros/src/lib.rs
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, Data, DeriveInput, Fields, ItemFn, LitStr};

/// `#[timed]` or `#[timed("label")]`: prints how long the function took.
#[proc_macro_attribute]
pub fn timed(args: TokenStream, item: TokenStream) -> TokenStream {
    let func = parse_macro_input!(item as ItemFn);    // the function it is attached to
    let label = if args.is_empty() {
        func.sig.ident.to_string()
    } else {
        parse_macro_input!(args as LitStr).value()     // "label" in #[timed("label")]
    };
    let ItemFn { attrs, vis, sig, block } = func;
    quote! {
        #(#attrs)* #vis #sig {
            let start = ::std::time::Instant::now();
            let result = (|| #block)();
            eprintln!("{} took {:?}", #label, start.elapsed());
            result
        }
    }
    .into()
}

/// `#[derive(Inspect)]`: lists a struct's fields, for an editor panel.
/// `attributes(inspect)` declares the helper attribute `#[inspect(...)]`.
#[proc_macro_derive(Inspect, attributes(inspect))]
pub fn derive_inspect(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    let Data::Struct(data) = &input.data else {
        return syn::Error::new_spanned(name, "Inspect only supports structs")
            .to_compile_error()
            .into();
    };
    let Fields::Named(fields) = &data.fields else {
        return syn::Error::new_spanned(name, "Inspect needs named fields")
            .to_compile_error()
            .into();
    };

    let mut rows = Vec::new();
    for field in &fields.named {
        let mut skip = false;
        for attr in field.attrs.iter().filter(|a| a.path().is_ident("inspect")) {
            let parsed = attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("skip") {
                    skip = true;
                    Ok(())
                } else {
                    Err(meta.error("expected `skip`"))   // becomes a compile error
                }
            });
            if let Err(e) = parsed {
                return e.to_compile_error().into();
            }
        }
        if !skip {
            let ident = field.ident.as_ref().unwrap();
            let label = ident.to_string();
            rows.push(quote! { (#label, format!("{:?}", self.#ident)) });
        }
    }

    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
    quote! {
        impl #impl_generics #name #ty_generics #where_clause {
            pub fn fields(&self) -> Vec<(&'static str, String)> {
                vec![#(#rows),*]
            }
        }
    }
    .into()
}
```

`quote!` is a template: `#name` inserts a value, and `#(#rows),*` repeats for
each element, like a parameter pack expansion. Errors are returned as
`compile_error!` tokens that point at the user's code, so a mistake reads like
any other compiler error.

The game uses them like any other attribute, after importing them:

```rust,ignore
// game/src/main.rs
use game_macros::{timed, Inspect};    // custom attributes are imported like any item

#[derive(Inspect)]
struct Light {
    color: [f32; 3],
    intensity: f32,
    #[inspect(skip)]                   // helper attribute declared by the derive
    shadow_map: Option<u32>,
}

#[timed]
fn bake_lightmap(size: usize) -> usize {
    (0..size * size).filter(|i| i % 7 == 0).count()
}

#[timed("load level")]
fn load_level() {}

fn main() {
    let light = Light { color: [1.0, 0.9, 0.8], intensity: 4.0, shadow_map: None };
    for (name, value) in light.fields() {
        println!("{name}: {value}");
    }
    assert!(light.shadow_map.is_none());
    println!("{} texels", bake_lightmap(512));
    load_level();
}
```

```text
color: [1.0, 0.9, 0.8]
intensity: 4.0
bake_lightmap took 6.47ms
37450 texels
load level took 84ns
```

Misspelling an attribute, or giving it an argument the macro does not accept,
fails at compile time:

```text
error: expected `skip`
 --> game/src/main.rs:7:15
  |
7 |     #[inspect(hidden)]
  |               ^^^^^^

error: cannot find attribute `inspekt` in this scope
 --> game/src/main.rs:7:7
  |
7 |     #[inspekt(skip)]
  |       ^^^^^^^
```

Unlike C++, an attribute macro can rewrite the item completely, so it can do
what would need a code generator in a C++ engine: register a component,
generate editor bindings, or wrap a system with profiling. To see what a macro
generated, install `cargo-expand` and run `cargo expand`: it prints your code
after macro expansion, the way `-E` shows preprocessor output. The
[Macros chapter](../systems/macros.md#procedural-macros) covers the third kind
of procedural macro (function-like, `name!(...)`) and when a macro is the
right tool at all.

## Expressions and control flow

| Symbol | C++ meaning | Rust meaning | Chapter |
|---|---|---|---|
| `x?` | (half of `a ? b : c`) | Early return: unwrap an `Ok`/`Some`, or return the `Err`/`None` from the current function. Rust has no ternary; use `if a { b } else { c }` | [Errors](../foundations/errors.md) |
| `\|a, b\| a + b` | `[](auto a, auto b) { return a + b; }` | A closure. `move \|\| ...` captures by value | [Closures and iterators](../foundations/closures-and-iterators.md) |
| `a..b`, `a..=b` | (none) | Ranges: half-open and inclusive. Used in `for`, slicing (`&v[1..3]`) and `match` | [Collections](../foundations/collections.md) |
| `=>` | (none) | Separates a `match` pattern from its result | [Enums and match](../foundations/enums-and-match.md) |
| `as` | `static_cast` | Primitive casts only, never fails, may truncate | [Operators](../foundations/operators-and-conversions.md) |
| `;` | Ends a statement | Also turns an expression into a statement. A block's last expression without `;` is its value, which is how functions usually return | [Values and types](../foundations/values-and-types.md) |
| `'label: loop` | `goto` label | A loop label for `break 'label` / `continue 'label` | |

## Patterns

Patterns appear in `let`, `match`, `if let`, function parameters and `for`.

| Symbol | Meaning | Chapter |
|---|---|---|
| `_` | Match anything, bind nothing. `_name` binds but silences the unused warning | [Enums and match](../foundations/enums-and-match.md) |
| `..` | Ignore the remaining fields or elements: `Point { x, .. }`, `[first, ..]` | [Enums and match](../foundations/enums-and-match.md) |
| `a \| b` | Either pattern | [Enums and match](../foundations/enums-and-match.md) |
| `x @ 1..=9` | Bind `x` and also test it against a pattern | [Enums and match](../foundations/enums-and-match.md) |
| `if cond` after a pattern | A match guard | [Enums and match](../foundations/enums-and-match.md) |

## Lifetimes

| Symbol | Meaning | Chapter |
|---|---|---|
| `'a` | A lifetime parameter: a name for "how long this borrow is valid". Not a character literal (those are `'x'`, with a closing quote) | [Lifetimes](../foundations/lifetimes.md) |
| `&'a T` | A reference valid for `'a` | [Lifetimes](../foundations/lifetimes.md) |
| `'static` | Valid for the whole program: string literals, or owned data with no borrows inside | [Lifetimes](../foundations/lifetimes.md) |
| `'_` | "Some lifetime, inferred": `Foo<'_>` | [Lifetimes](../foundations/lifetimes.md) |

## Literals

| Literal | Type | C++ equivalent |
|---|---|---|
| `"text"` | `&'static str` (UTF-8) | `u8"text"` as a `std::string_view` |
| `'c'` | `char`, a 4-byte Unicode scalar | `char32_t` |
| `b"bytes"`, `b'a'` | `&[u8; N]`, `u8` | `"bytes"` as raw bytes |
| `c"text"` | `&CStr`, null-terminated | `"text"` passed to a C API |
| `r"C:\path"`, `r#"say "hi""#` | Raw string, no escapes | `R"(...)"` |
| `1_000_000`, `0xFF_u8`, `2.5f32` | Underscores for readability; type suffixes | `1'000'000`, `uint8_t(0xFF)`, `2.5f` |

## False friends

The symbols most likely to trip a C++ programmer, because they look familiar:

- **`&` is visible at the call site.** C++ hides pass-by-reference in the
  callee's signature. In Rust, `update(&mut player)` tells the reader at the
  call that `player` may change.
- **There is no `->`** for member access. `.` works on values, references and
  smart pointers alike.
- **`!` after a name is a macro**, not negation. Macros can take any syntax
  inside their brackets, which is how `vec![0; 100]` and `println!("{x}")` work.
- **`?` is error propagation**, not a conditional.
- **`'` starts a lifetime** unless it closes again one character later.
- **`|` starts a closure** at the beginning of an expression, and means "or" in
  patterns and between two values.
- **`::<>` is only needed in expressions.** In a type position you write
  `Vec<u32>`, as in C++.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Inline type hints</span>

Your editor can fill in a lot of this for you. rust-analyzer shows inferred
types, parameter names and the lifetimes the compiler elided as inline hints,
and hovering a macro shows its expansion. While you learn, turn the hints on.

</div>

## Exercises

1. In the program at the top, remove the `?` from `parse_level` and read the
   compiler error. What type does `parse` return?
2. Change `0..scores.len()` to `0..=scores.len()`. What happens when you run
   it, and why does Rust stop instead of reading past the end?
3. Write `let n = "42".parse().unwrap();` without a type anywhere. Fix the
   error twice: once with a type on `n`, once with the turbofish.
