# Values, types and layout

Rust's basic types look like C's, and they compile to the same machine
representation. The differences are in the rules around them: no implicit
conversions, defined overflow behavior, immutability by default, and a
compiler that is free to reorder struct fields unless you ask it not to. This
chapter walks through the types you will use in every program and how they
are laid out in memory.

## Variables: immutable by default

```rust
fn main() {
    let width = 1920;          // immutable: like `const auto width = 1920;`
    let mut frame = 0u64;      // mutable
    frame += 1;

    let height: u32 = 1080;    // explicit type
    let aspect = width as f32 / height as f32;
    println!("frame {frame}: {width}x{height}, aspect {aspect:.3}");
}
```

`let` is the only way to declare a local variable, and the type is inferred
unless you write it. Variables are immutable unless declared `mut`. That
reverses C++'s default, where you add `const` to opt out of mutability. In
practice most locals in Rust code are immutable, and `mut` flags the few that
change.

**Shadowing** lets you reuse a name for a new variable, often to change its type
while keeping the meaning:

```rust
fn main() {
    let input = "  42 ";
    let input = input.trim();              // &str, trimmed
    let input: i32 = input.parse().unwrap(); // now an integer
    println!("{}", input + 1);
}
```

Each `let` creates a new variable; the old one still exists until the end of
scope but is hidden. This is legal and idiomatic, unlike C++ where it is a
warning at best.

## Scalar types

| Rust | C/C++ | Notes |
|---|---|---|
| `i8` `i16` `i32` `i64` `i128` | `int8_t` … `int64_t`, `__int128` | Fixed size, two's complement |
| `u8` `u16` `u32` `u64` `u128` | `uint8_t` … `uint64_t` | |
| `isize` `usize` | `ptrdiff_t`, `size_t` | Pointer-sized; `usize` indexes everything |
| `f32` `f64` | `float`, `double` | IEEE 754 |
| `bool` | `bool` | 1 byte, always 0 or 1 |
| `char` | `char32_t` | A Unicode scalar value, 4 bytes. **Not** a byte |
| `()` | `void` | The "unit" type: an empty tuple, zero bytes |

There is no `int`, `long` or `unsigned` whose size depends on the platform.
Integer literals default to `i32` and float literals to `f64` when nothing
else constrains them. Literals can carry a suffix (`255u8`, `1.0f32`) and
underscores (`1_000_000`, `0xFF_FF_FF`).

## No implicit conversions

C++ silently converts between arithmetic types: `int` to `double`, `double` to
`float`, `size_t` to `int` (with a warning, if you are lucky), and it promotes
small integers to `int` before arithmetic. Rust does none of this. Mixing types
is a compile error, and every conversion is spelled out:

```rust,compile_fail
fn main() {
    let count: u32 = 10;
    let len: usize = 4;
    let total = count + len;  // error[E0308]: mismatched types
}
```

The tools for converting:

```rust
use std::convert::TryFrom;

fn main() {
    let index: usize = 300;

    // `as`: always succeeds, truncates or wraps like a C cast. Use with care.
    let byte = index as u8;           // 300 -> 44
    let f = index as f32;              // 300.0
    let back = -1.7f32 as i32;         // -1: truncates toward zero
    let sat = 1e10f32 as i32;          // i32::MAX: float->int casts saturate

    // `From`/`Into`: only lossless conversions are provided.
    let wide: u64 = u64::from(42u32);
    let also_wide: f64 = 3.5f32.into();

    // `TryFrom`: checked conversion that can fail.
    let checked = u8::try_from(index);  // Err(..): 300 does not fit
    let ok = u8::try_from(200usize);    // Ok(200)

    println!("{byte} {f} {back} {sat} {wide} {also_wide} {checked:?} {ok:?}");
}
```

Use `From`/`Into` for widening, `TryFrom` when a value might not fit, and `as`
when you really want C-cast semantics (often in hot numeric code, after
checking ranges yourself).

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

In C++, `float x = 1 / 2;` is `0` because the division is done in `int`. In
Rust, `let x: f32 = 1 / 2;` does not compile: `1 / 2` is an integer expression
and you cannot store it in an `f32`. You must write `1.0 / 2.0`. The error is
annoying for a week and then saves you a bug a month.

</div>

## Integer overflow

In C++, signed overflow is undefined behavior and unsigned overflow wraps. In
Rust, overflow is never undefined:

- In **debug** builds, arithmetic overflow **panics** (stops the program with
  a message).
- In **release** builds, it **wraps** (two's complement), unless you enable
  `overflow-checks = true` in the profile.

When wrapping or saturating is what you mean, say so explicitly. The methods
make intent visible and behave the same in every build:

```rust
fn main() {
    let hp: u8 = 250;
    println!("{}", hp.wrapping_add(10));     // 4
    println!("{}", hp.saturating_add(10));   // 255
    println!("{:?}", hp.checked_add(10));    // None
    println!("{:?}", hp.overflowing_add(10)); // (4, true)

    // Hash functions and RNGs usually want wrapping arithmetic everywhere:
    use std::num::Wrapping;
    let mut h = Wrapping(2166136261u32);
    for b in b"hello" {
        h ^= *b as u32;
        h *= 16777619;
    }
    println!("fnv1a = {:#x}", h.0);
}
```

## Floats

`f32` and `f64` are IEEE 754, exactly as in C++. Two differences matter:

- Floats implement `PartialEq` and `PartialOrd`, but not `Eq` and `Ord`,
  because `NaN != NaN`. So you cannot sort a `Vec<f32>` with `.sort()` or use
  `f32` as a `HashMap` key without saying how to handle NaN. Use
  `v.sort_by(|a, b| a.total_cmp(b))`. The [operators
  chapter](operators-and-conversions.md) explains these traits.
- There is no `-ffast-math`. The compiler will not reassociate float
  operations, so it does not auto-vectorize float reductions such as sums. The
  [SIMD chapter](../engine/math-and-simd.md) shows how to vectorize them
  yourself.

## Tuples and arrays

```rust
fn min_max(xs: &[f32]) -> (f32, f32) {
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for &x in xs {
        lo = lo.min(x);
        hi = hi.max(x);
    }
    (lo, hi)                       // a tuple: like std::pair / std::tuple
}

fn main() {
    let (lo, hi) = min_max(&[3.0, -1.0, 7.5]);  // destructuring
    println!("{lo} {hi}");

    let identity: [[f32; 4]; 4] = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let zeros = [0u8; 256];        // 256 zero bytes: [value; count]
    println!("{} {}", identity[3][3], zeros.len());
}
```

An **array** `[T; N]` has a fixed length known at compile time and lives
inline, like a C array or `std::array<T, N>`. Unlike a C array it never decays
to a pointer, it can be passed and returned by value, and indexing is
bounds-checked: `identity[4]` with a constant index is a compile error, and
with a runtime index it panics instead of reading out of bounds. Arrays of
`Copy` types are themselves `Copy`.

## Structs

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

impl Vec3 {
    const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };

    // An associated function: no `self`. The usual "constructor".
    fn new(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3 { x, y, z }   // field init shorthand
    }

    // Methods take `self` explicitly.
    fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    fn length(self) -> f32 {
        self.dot(self).sqrt()
    }
}

// A tuple struct: fields are .0, .1, ... Great for type-safe wrappers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct EntityId(u32);

// A unit struct: no fields, zero size.
struct Player;

fn main() {
    let v = Vec3::new(3.0, 4.0, 0.0);
    let up = Vec3 { y: 1.0, ..Vec3::ZERO };   // struct update syntax
    println!("{v:?} length={} dot={}", v.length(), v.dot(up));
    let id = EntityId(7);
    println!("{id:?} {}", std::mem::size_of::<Player>());
}
```

Things that are different from C++ classes:

- **No constructors.** A struct literal must set every field, so there is no
  such thing as an uninitialized member. By convention a function called `new`
  builds the value, and `Default` (`#[derive(Default)]`) provides a zero-ish
  default.
- **No inheritance**, no `virtual`, no `protected`. Behavior is shared through
  traits ([Traits and generics](traits-and-generics.md)).
- **Methods live in `impl` blocks**, separate from the data. A type can have
  several `impl` blocks, even in different files of the same crate.
- **`#[derive(...)]`** generates common trait implementations: `Debug`
  (printing), `Clone`, `Copy`, `PartialEq`, `Hash`, `Default`, and more. It is
  the replacement for writing boilerplate operators by hand.

**Newtypes** like `EntityId(u32)` cost nothing at run time, and the compiler
will refuse to pass an `EntityId` where a `TextureId(u32)` is expected. Use
them generously for IDs, handles and units.

## Memory layout

Rust gives you exactly the layout control you have in C, but the **default** is
different:

- Without an attribute (`repr(Rust)`), the compiler may **reorder fields** to
  minimize padding. Field order in the source does not determine order in
  memory, and the layout is not stable between compiler versions.
- `#[repr(C)]` lays fields out in declaration order with C's padding rules,
  exactly like the equivalent C struct. Use it for anything that crosses a
  boundary: GPU buffers, files, network packets, FFI.
- `#[repr(align(N))]` raises the alignment, like `alignas(N)`.
- `#[repr(transparent)]` guarantees a single-field wrapper has the same layout
  and ABI as its field, so a newtype can be passed to C as the inner type.
- `#[repr(packed)]` removes padding (reading fields then needs care, since
  references to unaligned fields are not allowed).

```rust
use std::mem::{align_of, size_of};

struct Loose {     // default repr: the compiler may reorder
    a: u8,
    b: u32,
    c: u8,
}

#[repr(C)]
struct LooseC {    // C layout: a, pad 3, b, c, pad 3
    a: u8,
    b: u32,
    c: u8,
}

/// A vertex uploaded to the GPU: layout must match the shader.
#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

#[repr(C, align(64))]
struct PerThreadCounter {   // one cache line each, to avoid false sharing
    value: u64,
}

fn main() {
    println!("Loose   {} bytes", size_of::<Loose>());   // 8: reordered
    println!("LooseC  {} bytes", size_of::<LooseC>());  // 12
    println!("Vertex  {} bytes", size_of::<Vertex>());  // 32
    println!("Counter {} bytes, align {}", size_of::<PerThreadCounter>(), align_of::<PerThreadCounter>());
    println!("Option<&u8> {} bytes", size_of::<Option<&u8>>()); // 8: no extra tag
}
```

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Anything you `memcpy` into a GPU buffer must be `#[repr(C)]`, and should contain
no padding you have not accounted for. The `bytemuck` crate checks this at
compile time: `#[derive(Pod, Zeroable)]` refuses to compile a struct with
padding or pointers, and `bytemuck::cast_slice(&vertices)` then gives you the
`&[u8]` to upload, with no `unsafe` in your code. The [OpenGL
chapter](../engine/opengl.md) uses it.

</div>

## Everything is an expression

Blocks, `if` and `match` produce values, so the ternary operator is just `if`:

```rust
fn main() {
    let health = 35;
    let color = if health > 50 { "green" } else { "red" };

    let lod = {
        let distance = 120.0f32;
        let bias = 0.5;
        (distance.log2() - bias) as u32   // no semicolon: this is the block's value
    };

    let label = match lod {
        0 => "full",
        1..=3 => "reduced",
        _ => "impostor",
    };
    println!("{color} {lod} {label}");
}
```

A semicolon turns an expression into a statement whose value is `()`. That is
why a function's last line has no semicolon: it is the return value. `return`
exists for early returns.

## Constants and statics

```rust
const MAX_LIGHTS: usize = 16;                  // inlined at each use, like constexpr
static GREETING: &str = "hello";               // one address in the binary
static FRAME_TIME: f64 = 1.0 / 60.0;

const fn kib(n: usize) -> usize { n * 1024 }   // evaluable at compile time
const STAGING_SIZE: usize = kib(64);

fn main() {
    let lights = [0u8; MAX_LIGHTS];            // constants work as array lengths
    println!("{} {GREETING} {FRAME_TIME} {STAGING_SIZE}", lights.len());
}
```

`const` is the closest match to `constexpr` variables. `const fn` is a
function the compiler can run at compile time, like a `constexpr` function.
`static` has a fixed address. Mutable globals (`static mut`) exist but every
access is `unsafe`; the [game loop chapter](../engine/game-loop.md) shows what
to use instead.

## Summary

| C++ | Rust |
|---|---|
| `auto x = 1;` / `const auto x = 1;` | `let mut x = 1;` / `let x = 1;` |
| `int`, `long`, `size_t` | `i32`, `i64`, `usize` |
| Implicit conversions and promotions | None; use `as`, `From`, `TryFrom` |
| Signed overflow is UB | Panics in debug, wraps in release; `wrapping_*`, `checked_*` |
| `std::array<T, N>` | `[T; N]` |
| `std::pair`, `std::tuple` | `(A, B)` |
| Class with constructor | Struct + `new` function |
| Default C layout | Compiler-chosen layout; `#[repr(C)]` for C layout |
| `alignas(64)` | `#[repr(align(64))]` |
| `constexpr` | `const`, `const fn` |
| `cond ? a : b` | `if cond { a } else { b }` |

## Exercises

1. Write `fn lerp(a: f32, b: f32, t: f32) -> f32` and call it with an integer
   `t`. Read the error, then fix the call.
2. Define a `#[repr(C)]` struct with fields `u8, u64, u8, u32` and predict its
   size before printing `size_of`. Reorder the fields to make it as small as
   possible. Then remove `repr(C)` and see what the compiler does on its own.
3. Write a function that adds two `u8` values and returns `None` on overflow,
   using `checked_add`. Then make one that clamps to 255 instead.
