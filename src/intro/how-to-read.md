# How to read this book

Read Part I in order. Ownership, borrowing and lifetimes build on each other,
and most of Rust's surprises for a C++ programmer are in those three chapters.
After that, Part II and Part III can be read in any order; each chapter links
back to what it relies on.

## Conventions

Side-by-side code shows the C++ you would write next to the Rust equivalent:

<div class="rfc-compare">
<div class="rfc-cpp">

C++

```cpp
int square(int x) { return x * x; }
```

</div>
<div class="rfc-rust">

Rust

```rust
fn square(x: i32) -> i32 { x * x }
# fn main() { assert_eq!(square(3), 9); }
```

</div>
</div>

Rust examples are live. Press ▶ to compile and run them on the Rust
Playground; edit them first if you like. The link under each example opens it
on the Playground, where the **⋯** menu next to *Run* shows the generated
assembly, LLVM IR or MIR. Some examples hide setup lines; click the eye icon to
show them.

Interactive diagrams have **Back** and **Next** buttons, a slider, and respond
to the ← and → keys when focused. Where a diagram has tabs, the C++ tab and the
Rust tab show the same program in both languages.

Callouts mark three kinds of aside:

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

Places where doing what you would do in C++ leads you astray.

</div>

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

What the compiler generates and what it costs.

</div>

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

How the topic plays out in graphics and engine code.

</div>
