# Math libraries and SIMD

Every engine has a vector math library, and in C++ it is usually GLM,
DirectXMath, Eigen or something written in-house. Rust has a few mature ones,
and they look familiar: small `Copy` structs with overloaded operators. This
chapter shows how to use them, how to lay out math types for the GPU, and how
to go from auto-vectorized loops down to explicit SIMD intrinsics.

This chapter covers:

- glam and nalgebra, and how they compare with GLM and Eigen,
- `#[repr(C)]` math types and `bytemuck` for GPU uploads,
- checking auto-vectorization,
- `core::arch` intrinsics and runtime CPU feature detection,
- portable SIMD (`std::simd`) and the stable alternatives.

## Choosing a math library

| Crate | Like | Notes |
|---|---|---|
| [glam](https://docs.rs/glam) | GLM, DirectXMath | `Vec3`, `Vec4`, `Mat4`, `Quat` for `f32` (and `f64`/integer variants). SIMD inside on x86 and ARM. Used by Bevy and most Rust renderers. |
| [nalgebra](https://docs.rs/nalgebra) | Eigen | Generic over scalar type and dimension, including dynamic matrices, decompositions. Used by physics (Rapier). |
| [ultraviolet](https://docs.rs/ultraviolet) | ISPC-style math | "Wide" types (`Vec3x8`) that process 8 vectors at once, SoA style. |
| [mint](https://docs.rs/mint) | (interop) | Plain `#[repr(C)]` types that other math crates convert to and from, so libraries can agree on an exchange type. |

For a game or renderer, start with **glam**. It is small, fast and
graphics-oriented (right-handed and left-handed projection helpers, quaternions,
affine transforms):

```rust,ignore
use glam::{Mat4, Quat, Vec3};

let model = Mat4::from_scale_rotation_translation(
    Vec3::splat(2.0),
    Quat::from_rotation_y(std::f32::consts::FRAC_PI_4),
    Vec3::new(0.0, 1.0, -5.0),
);
let view = Mat4::look_at_rh(Vec3::new(0.0, 2.0, 5.0), Vec3::ZERO, Vec3::Y);
let proj = Mat4::perspective_rh(60f32.to_radians(), 16.0 / 9.0, 0.1, 100.0);
let mvp = proj * view * model;                 // operator overloading, as in GLM
let clip = mvp * Vec3::new(1.0, 0.0, 0.0).extend(1.0);
let n = (Vec3::X + Vec3::Y).normalize();
let d = n.dot(Vec3::Z);
```

Two differences from GLM matter in practice:

- **No implicit conversions.** There is no `vec4(v3, 1.0)` constructor
  overload that silently picks a meaning; you write `v3.extend(1.0)` or
  `Vec4::from((v3, 1.0))`. `f32` to `f64` is never implicit either.
- **Projection conventions are explicit in the name**: `perspective_rh`
  produces a 0-to-1 depth range (Vulkan, D3D, WebGPU), `perspective_rh_gl`
  produces -1-to-1 (OpenGL). GLM picks one with a `#define`.

## What a vector type looks like

You will often write a few small math types yourself (in shaders' uniform
structs, in a physics prototype). Here is a minimal `Vec3`, with the
operator traits from [Operators and
conversions](../foundations/operators-and-conversions.md):

```rust
use std::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Vec3 { pub x: f32, pub y: f32, pub z: f32 }

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self { Vec3 { x, y, z } }
    pub fn dot(self, o: Self) -> f32 { self.x * o.x + self.y * o.y + self.z * o.z }
    pub fn cross(self, o: Self) -> Self {
        Vec3::new(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
    pub fn length(self) -> f32 { self.dot(self).sqrt() }
    pub fn normalize_or_zero(self) -> Self {
        let len = self.length();
        if len > 0.0 { self * (1.0 / len) } else { Vec3::default() }
    }
}

impl Add for Vec3 { type Output = Vec3; fn add(self, o: Vec3) -> Vec3 { Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z) } }
impl Sub for Vec3 { type Output = Vec3; fn sub(self, o: Vec3) -> Vec3 { Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z) } }
impl Mul<f32> for Vec3 { type Output = Vec3; fn mul(self, s: f32) -> Vec3 { Vec3::new(self.x * s, self.y * s, self.z * s) } }
impl Mul<Vec3> for f32 { type Output = Vec3; fn mul(self, v: Vec3) -> Vec3 { v * self } }
impl Neg for Vec3 { type Output = Vec3; fn neg(self) -> Vec3 { Vec3::new(-self.x, -self.y, -self.z) } }

fn main() {
    let a = Vec3::new(1.0, 0.0, 0.0);
    let b = Vec3::new(0.0, 1.0, 0.0);
    let n = a.cross(b);
    println!("{n:?} {} {:?}", n.length(), (2.0 * a - b).normalize_or_zero());
}
```

The types are `Copy` and passed by value. For 12 or 16 bytes that is what you
want: they travel in registers, and there is no `const Vec3&` to write.

## Laying out data for the GPU

Uniform and vertex buffers are bytes with a layout the shader expects. In C++
you `memcpy` a struct and hope the padding matches. In Rust, the
[bytemuck](https://docs.rs/bytemuck) crate lets you turn a struct or slice into
`&[u8]` **without `unsafe`**, but only for types that implement `Pod` ("plain
old data": `#[repr(C)]`, no padding, no pointers, every bit pattern valid).
`#[derive(Pod)]` checks those conditions at compile time:

```rust,ignore
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CameraUniform {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 3],
    _pad: f32,              // std140: vec3 occupies 16 bytes. Without this field,
}                           // derive(Pod) fails: the struct would have tail padding.

let vertices: Vec<Vertex> = load_mesh();
let bytes: &[u8] = bytemuck::cast_slice(&vertices);   // zero-copy, safe
queue.write_buffer(&vertex_buffer, 0, bytes);
```

If you forget `_pad`, the `#[derive(Pod)]` fails to compile because the struct
has padding bytes (reading them would be reading uninitialized memory). This
turns a class of "my uniform is shifted by 4 bytes" bugs into compile errors.
For checking that a Rust struct matches a WGSL or GLSL layout exactly, the
[encase](https://docs.rs/encase) and
[crevice](https://docs.rs/crevice) crates generate std140/std430 layouts for
you.

You can add your own static checks with `const` assertions, the Rust
`static_assert`:

```rust
#[repr(C)]
#[derive(Clone, Copy)]
struct Light {
    position: [f32; 3],
    radius: f32,
    color: [f32; 3],
    intensity: f32,
}

const _: () = assert!(std::mem::size_of::<Light>() == 32);
const _: () = assert!(std::mem::offset_of!(Light, color) == 16);

fn main() {
    println!("Light is {} bytes", std::mem::size_of::<Light>());
}
```

## Auto-vectorization

Before writing intrinsics, check what the compiler already does. LLVM
vectorizes loops over slices well when it can prove there is no aliasing and no
out-of-bounds access, and Rust gives it both more often than C++ does
(`&mut` slices are `noalias`; iterators have no bounds checks):

```rust
pub fn saxpy(a: f32, x: &[f32], y: &mut [f32]) {
    for (yi, xi) in y.iter_mut().zip(x) {
        *yi += a * xi;
    }
}

pub fn sum(values: &[f32]) -> f32 {
    // Floating-point addition is not associative, so LLVM will not reorder a
    // plain `.sum()` into SIMD lanes. Accumulating into 8 lanes yourself lets it.
    let mut acc = [0.0f32; 8];
    let chunks = values.chunks_exact(8);
    let tail: f32 = chunks.remainder().iter().sum();
    for c in chunks {
        for i in 0..8 {
            acc[i] += c[i];
        }
    }
    acc.iter().sum::<f32>() + tail
}

fn main() {
    let x = vec![1.0f32; 1003];
    let mut y = vec![2.0f32; 1003];
    saxpy(3.0, &x, &mut y);
    println!("{} {}", y[0], sum(&y));
}
```

To see whether a loop vectorized:

- Open the example in the Playground, choose **Release**, then **Show
  Assembly**, and look for packed instructions (`mulps`, `addps`, `vfmadd...ps`
  on x86; `fmla v0.4s` on ARM).
- Locally, `cargo asm --release mycrate::saxpy` (from `cargo-show-asm`), or
  Compiler Explorer with `-C opt-level=3`.
- Enable wider instructions with `-C target-cpu=native` or
  `-C target-feature=+avx2,+fma` in `.cargo/config.toml`. Without it, x86-64
  code only assumes SSE2, exactly like a default C++ compiler.

`chunks_exact(8)` is the idiom that makes the trip count a multiple of the
vector width: inside the loop, `c` is known to have length 8, so the inner
`c[i]` needs no bounds check.

## Intrinsics: `core::arch`

When you need a specific instruction, the intrinsics are in `std::arch`
(alias `core::arch`), under the same names as in Intel's and ARM's headers:
`_mm_add_ps`, `_mm256_fmadd_ps`, `vaddq_f32`. They are `unsafe` because
calling an AVX2 instruction on a CPU without AVX2 is undefined behavior.

The safe pattern has three parts: a function compiled for the feature with
`#[target_feature]`, a runtime check with `is_x86_feature_detected!`, and a
scalar fallback.

```rust
#[cfg(target_arch = "x86_64")]
mod simd {
    use std::arch::x86_64::*;

    /// out[i] = a[i] + b[i], 8 lanes at a time, using AVX.
    #[target_feature(enable = "avx")]
    pub fn add_arrays_avx(a: &[f32], b: &[f32], out: &mut [f32]) {
        assert!(a.len() == b.len() && b.len() == out.len());
        let n = a.len() / 8 * 8;
        for i in (0..n).step_by(8) {
            // SAFETY: i + 8 <= n <= len for all three slices (checked above),
            // and loadu/storeu have no alignment requirement.
            unsafe {
                let va = _mm256_loadu_ps(a.as_ptr().add(i));
                let vb = _mm256_loadu_ps(b.as_ptr().add(i));
                _mm256_storeu_ps(out.as_mut_ptr().add(i), _mm256_add_ps(va, vb));
            }
        }
        for i in n..a.len() {
            out[i] = a[i] + b[i];
        }
    }
}

fn add_arrays(a: &[f32], b: &[f32], out: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if is_x86_feature_detected!("avx") {
        // SAFETY: we just checked that the CPU supports AVX.
        return unsafe { simd::add_arrays_avx(a, b, out) };
    }
    for ((o, x), y) in out.iter_mut().zip(a).zip(b) {
        *o = x + y;
    }
}

fn main() {
    let a: Vec<f32> = (0..20).map(|i| i as f32).collect();
    let b = vec![0.5f32; 20];
    let mut out = vec![0.0f32; 20];
    add_arrays(&a, &b, &mut out);
    println!("{:?}", &out[..10]);
}
```

Notes for C++ intrinsics users:

- `#[target_feature(enable = "avx")]` is `__attribute__((target("avx")))`.
  Calling such a function is `unsafe` from code not compiled with that
  feature, which is what forces the runtime check.
- `is_x86_feature_detected!` caches the CPUID result; the check costs a load
  and a branch. On ARM, use `std::arch::is_aarch64_feature_detected!`. NEON is
  always present on AArch64, so most NEON code needs no check.
- Inside a `#[target_feature]` function, intrinsics that do not touch memory
  (`_mm256_add_ps`) are safe to call in recent Rust. Loads and stores through
  raw pointers still need `unsafe`, with a `SAFETY` comment.
- To compile everything for a known baseline instead, set
  `-C target-cpu=x86-64-v3` (AVX2, FMA) and drop the runtime checks.

## Portable SIMD

`std::simd` provides `f32x4`, `f32x8`, `u8x16` and friends with operators and
lane-wise methods, compiled to whatever the target supports. It is the Rust
equivalent of `std::experimental::simd` and, like it, is **not yet stable**:
it requires a nightly compiler.

```rust,ignore
#![feature(portable_simd)]
use std::simd::prelude::*;

fn sum(values: &[f32]) -> f32 {
    let (head, body, tail) = values.as_simd::<8>();   // aligned middle part
    let mut acc = f32x8::splat(0.0);
    for v in body {
        acc += *v;
    }
    acc.reduce_sum() + head.iter().sum::<f32>() + tail.iter().sum::<f32>()
}
```

On stable Rust, the [wide](https://docs.rs/wide) crate offers similar types
(`f32x8`) today, and glam already uses SIMD internally for `Vec4`, `Mat4` and
`Quat`. For most engine code, the order of preference is:

1. Write slice loops the compiler can vectorize, and check the assembly.
2. Use SIMD-backed types from a library (glam, wide, ultraviolet).
3. Write `core::arch` intrinsics in a small module with runtime detection and
   `SAFETY` comments.

## Floating-point behavior

Rust follows IEEE 754 by default and never enables fast-math globally: no
reassociation, no flush-to-zero, NaNs and infinities preserved. Some things to
know:

- `f32::mul_add` is a fused multiply-add (one rounding). It compiles to an
  FMA instruction when the target has one, and to a slow software routine
  when it does not, so enable `+fma` if you use it in hot code.
- `f32::min` and `f32::max` ignore NaN (they return the other operand), unlike
  `std::min` which depends on argument order. `clamp` panics if `min > max`.
- `total_cmp` gives a total order (for sorting floats); `f32` does not
  implement `Ord`, so `sort()` on a `Vec<f32>` does not compile. Use
  `v.sort_by(f32::total_cmp)`.
- Float to integer casts with `as` **saturate**: `300.7f32 as u8 == 255`,
  `f32::NAN as i32 == 0`. In C++, out-of-range conversion is undefined behavior.

```rust
fn main() {
    let mut depths = vec![3.5f32, -1.0, f32::NAN, 0.25];
    depths.sort_by(f32::total_cmp);
    println!("{depths:?}");
    println!("{} {} {}", 300.7f32 as u8, f32::NAN as i32, (-5.0f32) as u32);
    println!("{}", f32::NAN.max(1.0));
}
```

## Summary

| C++ | Rust |
|---|---|
| GLM, DirectXMath | glam |
| Eigen | nalgebra |
| `memcpy` struct into a buffer | `bytemuck::cast_slice` on `#[derive(Pod)]` types |
| `static_assert(sizeof(T) == 32)` | `const _: () = assert!(size_of::<T>() == 32);` |
| `<immintrin.h>`, `<arm_neon.h>` | `std::arch::x86_64`, `std::arch::aarch64` |
| `__attribute__((target("avx2")))` | `#[target_feature(enable = "avx2")]` |
| `__builtin_cpu_supports` | `is_x86_feature_detected!` |
| `std::experimental::simd` | `std::simd` (nightly), `wide` (stable) |
| `-march=native` | `-C target-cpu=native` |
| UB on out-of-range float → int | Saturating `as` casts |

## Exercises

1. Add `Mul<Vec3> for Vec3` (component-wise) and a `lerp` method to the
   `Vec3` example. Check the Playground assembly for `lerp` in release mode.
2. Remove `_pad` from a `#[derive(Pod)]` struct in a local project with
   bytemuck. Read the error. Then write a `const` assertion that catches the
   same mistake without bytemuck.
3. Write an SSE2 version of `add_arrays` with `_mm_add_ps` (4 lanes). SSE2 is
   part of the x86-64 baseline: does it need runtime detection?
