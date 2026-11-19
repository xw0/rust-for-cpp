# Borrowing and references

Moving ownership every time a function needs to look at a value would be
unworkable. Most of the time you want what C++ gives you with `const T&` and
`T&`: access without ownership. Rust calls this **borrowing**, and its
references look like C++ references with one big addition: the compiler checks
that a reference can never outlive what it points to, and that nobody modifies
data while someone else is reading it.

This chapter covers:

- the two kinds of reference and the one rule that governs them,
- why that rule rules out iterator and reference invalidation,
- how long a borrow lasts,
- slices, the safe `std::span`,
- what the rule buys the optimizer,
- the borrow-checker fights you will have in engine code, and their fixes.

## Two kinds of reference

<div class="rfc-compare">
<div class="rfc-cpp">

C++

```cpp
float average(const std::vector<float>& v);
void normalize(std::vector<float>& v);

std::vector<float> samples = load();
float a = average(samples);
normalize(samples);   // nothing at the call site says it mutates
```

</div>
<div class="rfc-rust">

Rust

```rust
fn average(v: &Vec<f32>) -> f32 {
    v.iter().sum::<f32>() / v.len() as f32
}
fn normalize(v: &mut Vec<f32>) {
    let a = average(v);
    for x in v.iter_mut() { *x -= a; }
}
fn main() {
    let mut samples = vec![1.0, 2.0, 6.0];
    let a = average(&samples);
    normalize(&mut samples); // mutation is visible here
    println!("{a} {samples:?}");
}
```

</div>
</div>

- `&T` is a **shared reference**: read-only access, like `const T&`. You can
  have as many as you like at the same time.
- `&mut T` is a **mutable reference**: read-write access, like `T&`. While it
  exists, it is the *only* way to reach the value.

Both are plain pointers at run time, never null, and always point to a valid,
initialized value. Unlike C++ references they are first-class values: you can
reassign a `let` binding holding a reference, store references in structs, and
put them in containers.

You also borrow explicitly at the call site: `average(&samples)`,
`normalize(&mut samples)`. Reading a call tells you whether it can modify its
argument, which C++ hides behind the function signature.

## The rule: shared XOR mutable

At any point in the program, a value can have **either** any number of `&T`
**or** exactly one `&mut T`, never both. Step through it:

<div class="rfc-memviz" data-diagram="borrow-basics"></div>

While a shared borrow is in use, the owner is also frozen against writes:
`scores` itself cannot be modified until `a` and `b` are done. While a mutable
borrow is in use, the owner cannot even be *read* except through it.

This is a reader-writer lock, enforced at compile time, with zero runtime cost.

## The bug this rule removes

Every C++ engineer has hit this, usually with `std::vector<Entity>` and a cached
`Entity*` or iterator. Compare the two tabs:

<div class="rfc-memviz" data-diagram="invalidation"></div>

The C++ program is undefined behavior that usually *appears* to work. The Rust
program does not compile, and the error points at all three lines involved:
where the borrow starts, where the conflicting mutation is, and where the
borrow is used later.

The same rule covers modifying a container while iterating over it, holding a
`string_view` into a `std::string` that gets reassigned, and a `std::span` over
a vector that grows. These are all the same mistake: a reader holds a pointer
into memory that a writer is about to move or free.

## How long does a borrow last?

A borrow is alive from where it is created to its **last use**, not to the end
of the enclosing block. The compiler computes this ("non-lexical lifetimes"),
and most of the time you never think about it. When you do get an error,
picture the live range of each reference. Hover the bars below to see which
lines each borrow covers, and switch between the rejected program and two
fixes:

<div class="rfc-widget" data-widget="timeline" data-name="vec-push"></div>

## Borrowing in methods

Methods choose how they access `self`, which is how the standard library
encodes "this method mutates" or "this method consumes":

```rust
struct Mesh {
    positions: Vec<[f32; 3]>,
}

impl Mesh {
    fn vertex_count(&self) -> usize {          // like a const member function
        self.positions.len()
    }
    fn translate(&mut self, d: [f32; 3]) {     // non-const member function
        for p in &mut self.positions {
            p[0] += d[0];
            p[1] += d[1];
            p[2] += d[2];
        }
    }
    fn into_positions(self) -> Vec<[f32; 3]> { // consumes the mesh
        self.positions
    }
}

fn main() {
    let mut m = Mesh { positions: vec![[0.0; 3]; 3] };
    m.translate([1.0, 0.0, 0.0]);   // auto-borrows: (&mut m).translate(...)
    println!("{}", m.vertex_count());
    let raw = m.into_positions();    // `m` is moved; it cannot be used after this
    println!("{raw:?}");
}
```

The `.` operator borrows and dereferences automatically, so you write
`m.translate(...)` rather than `(&mut m).translate(...)`. Method calls are one
of the very few places where Rust inserts a borrow for you.

## Slices: the safe span

A **slice** `&[T]` is a pointer plus a length, a borrowed view of contiguous
elements. It is `std::span<const T>`, and `&mut [T]` is `std::span<T>`, except
that the borrow checker guarantees the underlying storage outlives the view and
does not reallocate under it. `&str` is the same for UTF-8 text, the safe
`std::string_view`.

Write functions that take slices rather than `&Vec<T>`. They then accept
vectors, arrays, and sub-ranges:

```rust
fn max_abs(xs: &[f32]) -> f32 {
    xs.iter().fold(0.0, |m, x| m.max(x.abs()))
}

fn main() {
    let v = vec![0.5, -3.0, 2.0, 7.5];
    let a = [1.0, -9.0];
    println!("{}", max_abs(&v));       // &Vec<f32> coerces to &[f32]
    println!("{}", max_abs(&a));       // so does &[f32; 2]
    println!("{}", max_abs(&v[1..3])); // a sub-range: bounds-checked once
}
```

Indexing a slice is bounds-checked. An out-of-range index panics instead of
reading past the end. In hot loops, iterating (`for x in xs`) avoids the checks
entirely, and the [iterators chapter](closures-and-iterators.md) shows how to
confirm that in the assembly.

## What the rule buys the optimizer

Because a `&mut T` is guaranteed to be the only path to its target, the
compiler can assume it does not alias anything else. In C++ terms, every
`&mut` is `__restrict`, and the compiler checks it for you.

<div class="rfc-compare">
<div class="rfc-cpp">

C++

```cpp
void add_twice(int& a, const int& b) {
    a += b;
    a += b;   // must reload b: a and b
              // might be the same int
}
```

</div>
<div class="rfc-rust">

Rust

```rust
pub fn add_twice(a: &mut i32, b: &i32) {
    *a += *b;
    *a += *b; // b cannot alias a: the
              // compiler folds this to
              // *a += 2 * *b
}
# fn main() { let (mut x, y) = (1, 2); add_twice(&mut x, &y); assert_eq!(x, 5); }
```

</div>
</div>

Open the Rust version in the Playground (link under the example), choose
**Show Assembly** in release mode, and compare with the C++ version in Compiler
Explorer. The Rust version loads `b` once. In SIMD-heavy code such as skinning,
particle updates or audio mixing, this is the difference between vectorizing
and not, without sprinkling `__restrict` around and hoping it is true.

## Fights you will have, and the fixes

The borrow checker reasons about whole values, plus individual fields of a
struct when it can see them directly. Most surprises in engine code come from
that boundary.

### Two mutable elements of one array

```rust,compile_fail
fn main() {
    let mut bodies = vec![[0.0f32; 3]; 4];
    let a = &mut bodies[0];
    let b = &mut bodies[1]; // error: `bodies` already borrowed mutably
    a[0] += b[0];
}
```

The checker does not know that indices 0 and 1 differ. The standard library
does the reasoning for you with `split_at_mut`, which hands out two
non-overlapping `&mut` slices:

```rust
fn main() {
    let mut bodies = vec![[0.0f32, 1.0, 0.0]; 4];
    let (left, right) = bodies.split_at_mut(1);
    let (a, b) = (&mut left[0], &mut right[0]); // bodies[0], bodies[1]
    a[1] += b[1];
    // Or, for any two distinct indices (Rust 1.86+):
    if let Ok([x, y]) = bodies.get_disjoint_mut([0, 3]) {
        x[0] = y[1];
    }
    println!("{bodies:?}");
}
```

### Borrowing two fields through a method

Borrowing two different fields directly is fine. Borrowing them through
methods is not, because a method signature `&mut self` claims the whole struct:

```rust
struct World {
    transforms: Vec<[f32; 3]>,
    velocities: Vec<[f32; 3]>,
}

impl World {
    fn integrate(&mut self, dt: f32) {
        // Fine: two disjoint fields, borrowed directly.
        for (p, v) in self.transforms.iter_mut().zip(&self.velocities) {
            for i in 0..3 {
                p[i] += v[i] * dt;
            }
        }
        // Would NOT compile: each call borrows all of `self`.
        // let t = self.transforms_mut();
        // let v = self.velocities();
    }
}

fn main() {
    let mut w = World { transforms: vec![[0.0; 3]], velocities: vec![[1.0, 2.0, 3.0]] };
    w.integrate(0.5);
    println!("{:?}", w.transforms);
}
```

The fixes, in order of preference: access the fields directly inside the
`impl`; write one method that returns both borrows at once
(`fn parts_mut(&mut self) -> (&mut A, &B)`); or split the struct so the parts
that change together live together. The last one is the road to an ECS, which
has [its own chapter](../engine/ecs.md).

### Long-lived pointers between objects

Storing `&Enemy` inside `Missile` to remember its target works for a few lines
of code and then fails, because the borrow would freeze the whole enemy list for
as long as the missile exists. References are for *temporary* access. For
long-lived relationships between objects, use [handles into an
arena](../engine/handles-and-arenas.md), or shared ownership with
[`Rc`/`Arc`](smart-pointers.md).

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

In C++ it is normal to keep a raw pointer to "the thing I'm working with" as a
member. In Rust, a struct that holds a reference needs a lifetime parameter and
borrows its target for its whole life. That is occasionally right (parsers,
views, iterators), but for game objects it almost never is. If you find
yourself adding `<'a>` to a struct to make the borrow checker happy, step back
and ask who should own the data.

</div>

## No null, no dangling

Two guarantees fall out of everything above:

- References are never null. "Maybe a reference" is `Option<&T>`, which the
  compiler stores as a plain nullable pointer, so it costs nothing, and
  `match`/`if let` forces you to handle the `None` case.
- References never dangle. Returning a reference to a local is rejected, and so
  is keeping one past the lifetime of its owner. The [next
  chapter](lifetimes.md) explains how the compiler proves this across function
  boundaries.

## Summary

| C++ | Rust |
|---|---|
| `const T&` | `&T`, many at once |
| `T&` | `&mut T`, exclusive |
| `const T*` / `T*` that may be null | `Option<&T>` / `Option<&mut T>` |
| `std::span<const T>`, `std::string_view` | `&[T]`, `&str` |
| `__restrict` (unchecked promise) | every `&mut T` (checked) |
| Invalidation is UB at run time | Invalidation is a compile error |
| `const` member function | `&self` method |

## Exercises

1. In the `invalidation` example above, make the Rust version compile in three
   different ways. Which one corresponds to what you would do in C++?
2. Write `fn largest<'a>(a: &'a [f32], b: &'a [f32]) -> &'a [f32]` that returns
   the slice with the larger sum. Then try removing the `'a` annotations and
   read the error. (The [lifetimes chapter](lifetimes.md) explains it.)
3. Implement `fn swap_ends(xs: &mut [i32])` that swaps the first and last
   element, using `split_at_mut` rather than `xs.swap`. Handle empty slices.
