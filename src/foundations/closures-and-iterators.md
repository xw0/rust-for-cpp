# Closures and iterators

Rust code uses closures and iterator chains where C++ uses raw loops,
`<algorithm>` and (in C++20) ranges. Engine programmers are rightly suspicious
of this style in C++, where it can hide allocations and defeat the optimizer in
debug builds. In Rust it is the idiomatic style, and in optimized builds it
compiles to the same loop you would write by hand. This chapter shows how
closures capture, how iterators work, and how to confirm the cost yourself.

## Closures

A closure is an anonymous function that can capture variables from its
environment, like a C++ lambda:

<div class="rfc-compare">
<div class="rfc-cpp">

C++

```cpp
float scale = 2.0f;
auto f = [scale](float x) { return x * scale; };
auto g = [&count](int) { ++count; };
auto h = [v = std::move(v)]() { use(v); };
```

</div>
<div class="rfc-rust">

Rust

```rust
fn main() {
    let scale = 2.0f32;
    let f = |x: f32| x * scale;        // borrows `scale`
    let mut count = 0;
    let mut g = |_: i32| count += 1;   // mutably borrows `count`
    g(1);
    let v = vec![1, 2, 3];
    let h = move || v.len();           // takes ownership of `v`
    println!("{} {} {}", f(1.5), h(), count);
}
```

</div>
</div>

The big difference: **you do not write a capture list**. The compiler looks at
what the body does with each variable and captures it the least powerful way
that works: by shared reference if it only reads, by mutable reference if it
mutates, by value if it moves the variable. The `move` keyword forces capture
by value for everything, which you need when the closure outlives the current
scope (threads, callbacks stored in structs).

Dangling captures, the classic `[&]` bug, are impossible: a closure that
borrows a local is subject to the borrow checker like any other reference.

### Fn, FnMut, FnOnce

Every closure has a unique, unnameable type (like a C++ lambda), which
implements one or more of three traits depending on what it does with its
captures:

| Trait | The closure… | Can be called |
|---|---|---|
| `Fn` | only reads its captures | Any number of times, even concurrently |
| `FnMut` | mutates its captures | Any number of times, but needs `&mut` access |
| `FnOnce` | consumes (moves out) its captures | Once |

Functions that accept closures state which they need:

```rust
fn apply_twice(f: impl Fn(f32) -> f32, x: f32) -> f32 {
    f(f(x))
}

fn repeat(n: usize, mut f: impl FnMut(usize)) {
    for i in 0..n {
        f(i);
    }
}

fn on_shutdown(f: impl FnOnce() -> String) -> String {
    f()
}

fn main() {
    let gain = 1.5;
    println!("{}", apply_twice(|x| x * gain, 2.0));

    let mut log = Vec::new();
    repeat(3, |i| log.push(i * 10));
    println!("{log:?}");

    let name = String::from("renderer");
    println!("{}", on_shutdown(move || name + " stopped")); // consumes `name`
}
```

`impl Fn(...)` is a generic parameter, so each call is monomorphized and the
closure is inlined, just like passing a lambda to a template. To store
closures of different types in one place (a list of callbacks), box them:
`Vec<Box<dyn Fn(&Event)>>`, the equivalent of `std::function`.

```rust
struct EventBus {
    listeners: Vec<Box<dyn Fn(&str)>>,
}

impl EventBus {
    fn subscribe(&mut self, f: impl Fn(&str) + 'static) {
        self.listeners.push(Box::new(f));
    }
    fn emit(&self, event: &str) {
        for l in &self.listeners {
            l(event);
        }
    }
}

fn main() {
    let mut bus = EventBus { listeners: Vec::new() };
    let prefix = String::from("[audio]");
    bus.subscribe(move |e| println!("{prefix} {e}"));
    bus.subscribe(|e| println!("[ui] {e}"));
    bus.emit("level_loaded");
}
```

## Iterators

An iterator is any type implementing the `Iterator` trait, which has a single
required method:

```rust
trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
    // ...plus about 75 provided methods: map, filter, sum, zip, ...
}
# fn main() {}
```

That is the whole protocol: call `next` until it returns `None`. Compare with
C++, where an iterator is a pair of positions (`begin`, `end`) that must come
from the same container and stay valid.

Collections give you three iterators:

| Call | Yields | Like |
|---|---|---|
| `v.iter()` / `for x in &v` | `&T` | `for (const auto& x : v)` |
| `v.iter_mut()` / `for x in &mut v` | `&mut T` | `for (auto& x : v)` |
| `v.into_iter()` / `for x in v` | `T`, consuming `v` | moving out of each element |

A `for` loop is sugar for calling `into_iter()` and then `next()` until `None`.

### Adapters and consumers

Adapters (`map`, `filter`, `zip`, `enumerate`, `take`, `skip`, `chain`,
`flat_map`, `rev`, `step_by`, `windows`…) wrap an iterator in another
iterator. They are **lazy**: nothing happens until a consumer (`sum`, `count`,
`collect`, `fold`, `for_each`, `min_by`, `any`, `position`…) pulls values
through.

```rust
#[derive(Debug, Clone, Copy)]
struct Light {
    position: [f32; 3],
    intensity: f32,
}

fn main() {
    let lights = vec![
        Light { position: [0.0, 5.0, 0.0], intensity: 10.0 },
        Light { position: [50.0, 5.0, 0.0], intensity: 3.0 },
        Light { position: [2.0, 1.0, 1.0], intensity: 0.0 },
        Light { position: [-4.0, 2.0, 3.0], intensity: 8.0 },
    ];
    let eye = [0.0f32, 1.0, 0.0];
    let dist2 = |p: [f32; 3]| (0..3).map(|i| (p[i] - eye[i]).powi(2)).sum::<f32>();

    // The 2 nearest lights that are switched on, with their original indices.
    let mut active: Vec<(usize, f32)> = lights
        .iter()
        .enumerate()
        .filter(|(_, l)| l.intensity > 0.0)
        .map(|(i, l)| (i, dist2(l.position)))
        .collect();
    active.sort_by(|a, b| a.1.total_cmp(&b.1));
    let nearest: Vec<usize> = active.iter().take(2).map(|&(i, _)| i).collect();
    println!("nearest lights: {nearest:?}");

    let total: f32 = lights.iter().map(|l| l.intensity).sum();
    let brightest = lights.iter().max_by(|a, b| a.intensity.total_cmp(&b.intensity));
    let any_off = lights.iter().any(|l| l.intensity == 0.0);
    println!("{total} {:?} {any_off}", brightest.map(|l| l.position));

    // Pairwise operations without index arithmetic:
    let path = [[0.0f32, 0.0], [3.0, 4.0], [3.0, 8.0]];
    let length: f32 = path
        .windows(2)
        .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
        .sum();
    println!("path length {length}");
}
```

`collect()` builds any collection that implements `FromIterator`: `Vec`,
`HashMap` (from pairs), `String` (from chars), even `Result<Vec<T>, E>` (from
an iterator of `Result`s, stopping at the first error).

## Zero cost: check the assembly

The claim "iterators are as fast as loops" is checkable. Open both of these on
the Playground (link under the example), set **Release**, and choose **Show
Assembly** from the menu next to *Run*:

```rust
pub fn sum_of_squares_loop(xs: &[i32]) -> i32 {
    let mut total = 0;
    for i in 0..xs.len() {
        total += xs[i] * xs[i];     // bounds check here...
    }
    total
}

pub fn sum_of_squares_iter(xs: &[i32]) -> i32 {
    xs.iter().map(|x| x * x).sum()  // ...and none here
}
# fn main() {
#     let v: Vec<i32> = (1..=10).collect();
#     assert_eq!(sum_of_squares_loop(&v), sum_of_squares_iter(&v));
#     println!("{}", sum_of_squares_iter(&v));
# }
```

Both produce the same vectorized loop. In the indexed version, the compiler
proves `i < xs.len()` from the loop bounds and removes the bounds check; in the
iterator version there was never a check to remove. When the compiler *cannot*
prove an index is in range (say, `xs[i + offset]`), the indexed version keeps
its check and the iterator version (`xs.iter().skip(offset)`, `zip`,
`chunks_exact`) is faster.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">Debug builds</span>

In a debug build (`opt-level = 0`), iterator chains are not inlined and are
much slower than raw loops, often by 10 to 50 times. This is the main reason to
set `opt-level = 1` for your own code in the dev profile, as shown in the
[Cargo chapter](cargo.md).

</div>

## Writing your own iterator

Implement `next`, and every adapter is available for free:

```rust
/// Iterates the cells of a w x h grid in Morton (Z-order) curve order.
struct Morton {
    i: u32,
    w: u32,
    h: u32,
}

fn deinterleave(mut x: u32) -> u32 {
    x &= 0x5555_5555;
    x = (x | (x >> 1)) & 0x3333_3333;
    x = (x | (x >> 2)) & 0x0f0f_0f0f;
    x = (x | (x >> 4)) & 0x00ff_00ff;
    (x | (x >> 8)) & 0x0000_ffff
}

impl Iterator for Morton {
    type Item = (u32, u32);
    fn next(&mut self) -> Option<(u32, u32)> {
        let side = self.w.max(self.h).next_power_of_two();
        while self.i < side * side {
            let (x, y) = (deinterleave(self.i), deinterleave(self.i >> 1));
            self.i += 1;
            if x < self.w && y < self.h {
                return Some((x, y));
            }
        }
        None
    }
}

fn main() {
    let cells: Vec<_> = Morton { i: 0, w: 4, h: 2 }.collect();
    println!("{cells:?}");
    let diagonal = Morton { i: 0, w: 8, h: 8 }.filter(|(x, y)| x == y).count();
    println!("{diagonal}");
}
```

For simple cases, `std::iter::from_fn(|| ...)` and `std::iter::successors`
build an iterator from a closure without defining a type.

## Summary

| C++ | Rust |
|---|---|
| Lambda with capture list | Closure; captures inferred, `move` for by-value |
| `std::function<R(A)>` | `Box<dyn Fn(A) -> R>` |
| Template parameter for a callable | `impl Fn(A) -> R` / `F: FnMut(A) -> R` |
| Iterator pair `begin`/`end` | One iterator object with `next()` |
| `<algorithm>`, ranges | Iterator adapters and consumers |
| `std::transform` + `back_inserter` | `.map(...).collect()` |
| `std::accumulate` | `.fold(...)` / `.sum()` |

## Exercises

1. Rewrite the "nearest lights" example with a single `fold` (no sorting) to
   find the one nearest active light.
2. Write a function that takes `impl FnMut() -> f32` (a random generator) and
   returns a `Vec<[f32; 2]>` of `n` points in the unit circle using rejection
   sampling. Use `std::iter::repeat_with` and `filter`.
3. In the Playground, compare the assembly of `sum_of_squares_loop` with a
   version that indexes `xs[i + 1]` for `i in 0..xs.len() - 1`. Find the bounds
   check, then remove it with `windows(2)`.
