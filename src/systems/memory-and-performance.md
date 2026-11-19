# Memory layout and performance

Rust compiles through LLVM, the same back end as Clang, so for equivalent code
you get equivalent machine code. Performance work in Rust is the performance
work you already do: control the layout, keep data contiguous, avoid
allocations in the hot path, measure. This chapter shows the Rust spelling of
each technique, and the few places where Rust's defaults differ from C++.

This chapter covers:

- inspecting size and alignment, and controlling layout,
- array-of-structs versus struct-of-arrays,
- where the hidden costs are: bounds checks, overflow checks, allocations,
  dynamic dispatch,
- allocators: global, arena and bump,
- profiling and reading assembly.

## Size, alignment and layout

`std::mem::size_of::<T>()` and `align_of::<T>()` are `sizeof` and `alignof`.
`std::mem::offset_of!(Type, field)` is `offsetof`. The layout attributes were
introduced in [Values, types and layout](../foundations/values-and-types.md);
the rules again in one place:

| Attribute | Effect |
|---|---|
| (default) | Compiler may reorder fields to reduce padding; layout unspecified |
| `#[repr(C)]` | Declaration order, C padding rules; stable and FFI-safe |
| `#[repr(align(N))]` | Minimum alignment `N` (cache-line alignment, SIMD) |
| `#[repr(transparent)]` | Same layout and ABI as the single non-zero-sized field |
| `#[repr(u8)]` etc. on enums | Explicit discriminant type |
| `#[repr(packed)]` | No padding; references to fields are not allowed |

```rust
use std::mem::{align_of, offset_of, size_of};

#[repr(C)]
struct InstanceData {
    model: [[f32; 4]; 4], // 64 bytes
    color: [f32; 4],      // 16
    material: u32,        // 4
    flags: u32,           // 4  -> 88 bytes; std140 would need padding to 96
}

#[repr(C, align(16))]
struct Aligned([f32; 3]);

fn main() {
    println!("InstanceData: {} bytes, align {}", size_of::<InstanceData>(), align_of::<InstanceData>());
    println!("material at offset {}", offset_of!(InstanceData, material));
    println!("Aligned: {} bytes", size_of::<Aligned>());   // 16: padded to its alignment
}
```

Rust's default of reordering fields means a struct written in "logical" order
is already compact. You only need to think about order for `#[repr(C)]`
structs, which are the ones shared with GPUs, files and C.

## AoS versus SoA

Everything you know about data-oriented design applies unchanged. An array of
structs:

```rust
#[derive(Clone, Copy, Default)]
struct Particle {
    position: [f32; 3],
    velocity: [f32; 3],
    color: [u8; 4],
    age: f32,
}
# fn main() {}
```

wastes bandwidth when the hot loop touches only `position` and `velocity`. A
struct of arrays keeps each field contiguous:

```rust
#[derive(Default)]
struct Particles {
    px: Vec<f32>, py: Vec<f32>, pz: Vec<f32>,
    vx: Vec<f32>, vy: Vec<f32>, vz: Vec<f32>,
    age: Vec<f32>,
}

impl Particles {
    fn integrate(&mut self, dt: f32) {
        let n = self.px.len();
        // Re-slicing to the same length lets the compiler drop bounds checks.
        let (px, vx) = (&mut self.px[..n], &self.vx[..n]);
        for i in 0..n {
            px[i] += vx[i] * dt;
        }
        // Or zip, which never had checks:
        for (py, vy) in self.py.iter_mut().zip(&self.vy) {
            *py += vy * dt;
        }
        for (pz, vz) in self.pz.iter_mut().zip(&self.vz) {
            *pz += vz * dt;
        }
        for a in &mut self.age {
            *a += dt;
        }
    }
}

fn main() {
    let mut p = Particles::default();
    for i in 0..8 {
        p.px.push(0.0); p.py.push(0.0); p.pz.push(0.0);
        p.vx.push(i as f32); p.vy.push(1.0); p.vz.push(0.0);
        p.age.push(0.0);
    }
    p.integrate(0.5);
    println!("{:?}", p.px);
}
```

These loops auto-vectorize. The borrow checker helps here in a way C++ does
not: because `self.px` and `self.vx` are distinct fields borrowed as `&mut` and
`&`, the compiler knows they do not alias, which is exactly what the
vectorizer needs.

## The hidden costs, and how to see them

Rust adds very few costs C++ does not have, and each is visible in the source:

| Cost | When | How to avoid |
|---|---|---|
| Bounds checks | `slice[i]` where the compiler cannot prove `i` in range | Iterators, `zip`, `chunks_exact`, re-slicing to a known length, `assert!(i < len)` before a loop; `get_unchecked` (unsafe) as a last resort |
| Overflow checks | Debug builds only (by default) | Use `wrapping_*` where wrapping is intended |
| Drop flags | Values moved on only some paths | Rarely matters |
| Dynamic dispatch | `dyn Trait` calls | Generics; enums |
| Allocation | `Box::new`, `Vec::push` beyond capacity, `String` building, `format!`, `collect()` | Reuse buffers (`clear()` keeps capacity), `with_capacity`, arenas |
| Reference counting | `Rc`/`Arc::clone` | Pass `&T` instead of cloning the `Arc` |
| `RefCell` borrow checks | Every `borrow()` / `borrow_mut()` | Restructure ownership |

A bounds check is a compare and a well-predicted branch. In most code it does
not show up in profiles. Where it does, it usually also blocks vectorization,
and the fixes above remove it without `unsafe`.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

Do not reach for `unsafe { get_unchecked() }` because "bounds checks are slow".
Look at the assembly first. In practice an iterator or a single
`assert!(idx.len() == data.len())` before the loop lets LLVM remove the checks,
and you keep the safety net.

</div>

## Allocation

Rust has no `new` operator and no hidden allocations in the language: every
heap allocation comes from a library type (`Box`, `Vec`, `String`, `Rc`,
`HashMap`…). The standard library's allocator is the system `malloc` by
default. You can replace it for the whole program, like replacing `operator
new`:

```rust,ignore
// Use mimalloc for every allocation in the program.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
```

Or implement `GlobalAlloc` yourself, for instance to count allocations per
frame:

```rust
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn frame(scratch: &mut Vec<u32>) {
    scratch.clear();                 // keeps capacity: no allocation after warm-up
    scratch.extend(0..1000);
}

fn main() {
    let mut scratch = Vec::new();
    for f in 0..3 {
        let before = ALLOCS.load(Ordering::Relaxed);
        frame(&mut scratch);
        println!("frame {f}: {} allocations", ALLOCS.load(Ordering::Relaxed) - before);
    }
}
```

Per-collection custom allocators (like `std::vector<T, Alloc>`) are still
unstable in the standard library. In practice engines use:

- **Reusable buffers**: keep a `Vec` across frames and `clear()` it.
- **Bump allocators** (`bumpalo`) for per-frame scratch data, with the borrow
  checker ensuring nothing outlives the reset
  ([Handles and arenas](../engine/handles-and-arenas.md)).
- **Pools and slot maps** for objects with individual lifetimes.

## Inlining and codegen

- Small functions are inlined within a crate automatically. Across crates,
  non-generic functions are inlined only with LTO or if marked `#[inline]`.
  Generic functions are always available for inlining, like templates.
- `#[inline(always)]` and `#[inline(never)]` are hints with the usual caveats.
  `#[cold]` marks unlikely paths, like `[[unlikely]]`.
- `opt-level = 3`, `lto = "fat"` or `"thin"`, `codegen-units = 1` and
  `-C target-cpu=native` in `.cargo/config.toml` are the main build knobs
  ([Cargo](../foundations/cargo.md)).
- `panic = "abort"` removes unwinding tables and landing pads.
- Profile-guided optimization works via `-C profile-generate` / `-C
  profile-use` (or the `cargo-pgo` helper).

## Profiling and reading assembly

Your profilers work unchanged; make sure symbols are present in optimized
builds:

```toml
[profile.release]
debug = "line-tables-only"   # or `true` for full debug info
```

- **Sampling profilers**: perf, VTune, Superluminal, Instruments, Windows
  Performance Analyzer. `cargo flamegraph` wraps perf/dtrace and produces an
  SVG flame graph.
- **Instrumented**: Tracy (via `tracy-client` or the `tracing-tracy` layer) and
  `puffin` for in-game frame profilers.
- **Assembly**: `cargo asm` (the `cargo-show-asm` tool) prints the assembly of a
  single function. The Playground and Compiler Explorer (godbolt.org) show
  assembly in the browser; every example in this book has a link to open it in
  the Playground.
- **Benchmarks**: `criterion` for statistically sound microbenchmarks
  ([Testing](testing-and-tooling.md)).

## Summary

| C++ | Rust |
|---|---|
| `sizeof`, `alignof`, `offsetof` | `size_of`, `align_of`, `offset_of!` |
| Declaration-order layout | Reordered by default; `#[repr(C)]` for declaration order |
| `alignas` | `#[repr(align(N))]` |
| `__restrict` | Implied by `&mut` |
| Replace `operator new` | `#[global_allocator]` |
| `std::pmr`, allocator template parameters | Mostly crates: `bumpalo`, slot maps; allocator API unstable |
| `[[likely]]` / `[[unlikely]]` | `#[cold]` on functions |
| `-fprofile-generate` | `-C profile-generate` |

## Exercises

1. Write the particle update in AoS form (`Vec<Particle>`) and SoA form, and
   compare their assembly in the Playground. Which one vectorizes?
2. Use the counting allocator to find every allocation in a small program that
   builds strings with `format!` in a loop. Remove them by reusing a `String`
   with `write!` (from `std::fmt::Write`).
3. Write a loop that sums `data[idx[i]]` for an index array. Look for the
   bounds check in the assembly. Can you remove it safely?
