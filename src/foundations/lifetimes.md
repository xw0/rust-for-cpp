# Lifetimes

The previous chapter showed that the compiler tracks how long each borrow is
used. This chapter is about the other half of the proof: making sure the
*owner* lives at least that long. In C++ this is the dangling pointer problem:
returning a pointer to a local, keeping a `string_view` to a temporary,
storing a reference to an object that gets destroyed. Rust rules all of these
out at compile time, and **lifetimes** are the notation for how it does so
across function boundaries.

The most important fact first: **lifetimes do not exist at run time.** They do
not change what code is generated, they do not extend how long anything lives,
and they cost nothing. A lifetime annotation is a statement to the compiler
about which references are related, so it can check your program.

This chapter covers:

- what a lifetime is, and watching a borrow outlive its owner,
- lifetime annotations on functions, and the elision rules that make most of
  them unnecessary,
- structs that hold references,
- `'static`,
- reading the common error messages.

## A borrow must not outlive its owner

Step through this program. It is the Rust version of returning a pointer to a
local variable.

<div class="rfc-memviz" data-diagram="lifetime-dangling"></div>

The compiler gives every reference a **lifetime**: the region of code where it
must remain valid. Here, `r` is used on the last line, so the borrow `&s` must
be valid until then. But `s` is dropped at the inner closing brace. The
lifetime of the borrow is longer than the life of the value it points to, so
the program is rejected with error E0597, "`s` does not live long enough".

## Lifetimes in function signatures

Inside one function the compiler can see everything and needs no help. Across
function calls it only sees signatures. Consider:

```rust,compile_fail
fn longest(a: &str, b: &str) -> &str {   // error[E0106]: missing lifetime specifier
    if a.len() >= b.len() { a } else { b }
}
# fn main() {}
```

The caller needs to know: the returned reference points into *which*
argument? It decides how long the caller must keep each argument alive. You
answer with a **lifetime parameter**:

```rust
fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.len() >= b.len() { a } else { b }
}

fn main() {
    let name = String::from("Vulkan");
    let result;
    {
        let other = String::from("GL");
        result = longest(&name, &other);
        println!("{result}");   // fine: both strings are alive here
    }
    // println!("{result}");    // error: `other` does not live long enough
}
```

Read `<'a>` like a template parameter, but for regions of code instead of
types. The signature says: "there is some region `'a` during which both `a`
and `b` are valid, and the result is valid for that same region." At the call
site the compiler picks the largest region that satisfies both arguments,
which is the scope of `other`, and then checks every use of `result` against
it. Uncomment the last line to see the error.

Lifetimes are written `'a`, `'b`, `'src` and so on. The names mean nothing
beyond tying references together.

## Elision: why you rarely write them

Most functions need no annotations, because the compiler applies three
**elision rules** to fill them in:

1. Each reference parameter gets its own lifetime.
2. If there is exactly one input lifetime, it is used for all output
   references.
3. If there is a `&self` or `&mut self` parameter, its lifetime is used for all
   output references.

So these signatures are complete as written:

```rust
struct Texture {
    name: String,
    pixels: Vec<u8>,
}

impl Texture {
    // Rule 3: the result borrows from `self`.
    fn name(&self) -> &str {
        &self.name
    }
    // Rule 3 again.
    fn row(&self, y: usize, width: usize) -> &[u8] {
        &self.pixels[y * width * 4..(y + 1) * width * 4]
    }
}

// Rule 2: one input reference, so the output borrows from it.
fn file_stem(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path).split('.').next().unwrap_or(path)
}

fn main() {
    let t = Texture { name: "brick".into(), pixels: vec![0; 4 * 4 * 2] };
    println!("{} {} {}", t.name(), t.row(1, 2).len(), file_stem("assets/brick.png"));
}
```

You need explicit lifetimes only when the rules are ambiguous: several input
references and a returned reference (like `longest`), or structs that hold
references.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

Lifetimes are checked by the **borrow checker**, which runs on MIR, a
simplified control-flow graph of each function. It computes, for every
reference, the set of program points where it is live, and checks that the
borrowed value is not moved, dropped or mutated in a conflicting way at any of
them. Then the lifetimes are erased. The machine code is identical to what you
would get from the same program with raw pointers.

</div>

## Structs that hold references

A struct can hold references if it declares the lifetime they borrow for. The
annotation says "a value of this type cannot outlive the data it borrows":

```rust
/// A zero-copy tokenizer over a shader source string.
struct Tokens<'src> {
    rest: &'src str,
}

impl<'src> Tokens<'src> {
    fn new(source: &'src str) -> Self {
        Tokens { rest: source }
    }
}

impl<'src> Iterator for Tokens<'src> {
    type Item = &'src str;   // tokens borrow from the source, not from the tokenizer

    fn next(&mut self) -> Option<&'src str> {
        let s = self.rest.trim_start();
        if s.is_empty() {
            return None;
        }
        let end = s.find(|c: char| c.is_whitespace() || c == ';').unwrap_or(s.len()).max(1);
        let (tok, rest) = s.split_at(end);
        self.rest = rest;
        Some(tok)
    }
}

fn main() {
    let source = String::from("uniform mat4 mvp; in vec3 pos;");
    let tokens: Vec<&str> = Tokens::new(&source).collect();
    println!("{tokens:?}");
    // drop(source); // error: `tokens` still borrows from `source`
}
```

This is the safe version of the C++ "view" types: `std::string_view`,
`std::span`, iterators. A `Tokens` cannot outlive `source`, and neither can the
tokens it produced. Note the `Item = &'src str`: the tokens borrow from the
original string, not from the tokenizer, so the tokenizer can be dropped while
the tokens are still in use.

Use reference-holding structs for short-lived views, parsers and iterators.
For long-lived objects like game entities, store owned data or handles
([Handles and arenas](../engine/handles-and-arenas.md)). A lifetime parameter
spreads to every type that contains it, which is a good signal that you are
borrowing for too long.

## `'static`

`'static` is the lifetime of the whole program. Two different things carry it:

- **References** `&'static T` point to data that lives forever: string
  literals (stored in the binary), `static` items, and leaked allocations
  (`Box::leak`).
- **Type bounds** `T: 'static` mean "`T` contains no non-static references":
  it owns all its data. `String`, `Vec<u8>` and `i32` all satisfy `T: 'static`.
  It does **not** mean the value lives forever.

The second meaning is common in APIs. `std::thread::spawn` requires
`F: 'static` because the new thread may outlive the caller, so the closure must
not borrow the caller's locals:

```rust
use std::thread;

fn main() {
    let level_name = String::from("e1m1");
    let handle = thread::spawn(move || {
        // `move` transfers ownership of `level_name` into the thread,
        // making the closure 'static.
        format!("loaded {level_name}")
    });
    println!("{}", handle.join().unwrap());
}
```

Remove `move` and you get an error explaining that the closure may outlive the
function that borrows `level_name`. The [concurrency
chapter](../systems/concurrency.md) shows scoped threads, which *can* borrow.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

When the compiler says a value "does not live long enough", the C++ reflex is
to make it live longer: allocate it on the heap, make it static. Usually the
better fix is to make the *borrow* shorter (use the reference earlier, copy the
small value you need, or return owned data such as `String` instead of `&str`).
Returning owned data costs an allocation, and in exchange removes a lifetime
from every caller.

</div>

## Decoding the common errors

| Error | Meaning | Usual fix |
|---|---|---|
| E0106 missing lifetime specifier | A signature is ambiguous about what a returned reference borrows from | Add a lifetime parameter, or return owned data |
| E0499 cannot borrow as mutable more than once | Two `&mut` to the same value are alive at once | End the first borrow earlier; split the borrow (`split_at_mut`, separate fields) |
| E0502 cannot borrow as mutable because it is also borrowed as immutable | A `&` and a `&mut` overlap | Reorder, copy the value out, or restructure |
| E0505 cannot move out because it is borrowed | Moving a value while a reference to it is alive | Use the reference first, or clone |
| E0597 does not live long enough | The owner is dropped while a borrow is still used | Move the owner to a longer-lived scope, or shorten the borrow |
| E0716 temporary value dropped while borrowed | Borrowing from a temporary that dies at the end of the statement, like `let s = String::from("x").as_str();` | Bind the temporary to a variable first |
| E0373 closure may outlive the current function | A closure that must be `'static` borrows a local | Add `move` |

Run `rustc --explain E0597` (or any code) for a full explanation with examples.

## Summary

| C++ | Rust |
|---|---|
| Dangling pointer / reference | Compile error (E0597, E0716) |
| "Don't keep this `string_view` past the string's life" (comment) | `struct View<'a>` (checked) |
| Iterator invalidation | Compile error (previous chapter) |
| No equivalent | Lifetime parameters: relate the regions where references are valid |
| `static` storage duration | `'static` references; `T: 'static` means "owns its data" |

## Exercises

1. Write `fn first_word(s: &str) -> &str` without annotations. Which elision
   rule applies? Then write `fn pick<'a, 'b>(a: &'a str, b: &'b str) -> &'a str`
   that always returns `a`, and explain why it is more flexible for callers
   than `longest`.
2. Make the `Tokens` example's `Item` type `&str` with no lifetime (elided to
   the `&mut self` borrow) and read the error. Why can't `next` return a
   reference tied to `&mut self` here?
3. Write a struct `Config` that owns a `String`, and a method
   `fn get(&self, key: &str) -> Option<&str>` that returns a slice of it. Which
   lifetime does the return value get?
