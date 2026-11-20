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
