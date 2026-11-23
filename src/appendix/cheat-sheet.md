# C++ to Rust cheat sheet

A quick reference: the C++ thing you reach for, its usual Rust spelling, and
the chapter that explains it. When the translation is not one-to-one, the
chapter is worth reading before you rely on the table. For what a single
symbol such as `!`, `&mut`, `'a` or `?` means, see [Reading Rust
syntax](../intro/syntax.md).

## Values and types

| C++ | Rust | Chapter |
|---|---|---|
| `const auto x = 1;` / `auto x = 1;` | `let x = 1;` / `let mut x = 1;` | [Values and types](../foundations/values-and-types.md) |
| `int`, `int64_t`, `size_t`, `uint8_t` | `i32`, `i64`, `usize`, `u8` | [Values and types](../foundations/values-and-types.md) |
| Implicit numeric conversions | None: `as`, `From`, `TryFrom` | [Values and types](../foundations/values-and-types.md) |
| Signed overflow is UB | Panic in debug, wrap in release; `wrapping_*`, `checked_*`, `saturating_*` | [Values and types](../foundations/values-and-types.md) |
| `std::array<T, N>` | `[T; N]` | [Values and types](../foundations/values-and-types.md) |
| `std::pair`, `std::tuple` | `(A, B)` | [Values and types](../foundations/values-and-types.md) |
| `struct` with constructor | `struct` + `fn new(...) -> Self` | [Values and types](../foundations/values-and-types.md) |
| `constexpr` value / function | `const` / `const fn` | [Values and types](../foundations/values-and-types.md) |
| `static_assert(cond)` | `const _: () = assert!(cond);` | [Macros](../systems/macros.md) |
| `cond ? a : b` | `if cond { a } else { b }` | [Values and types](../foundations/values-and-types.md) |
| `enum class` | `enum` | [Enums and match](../foundations/enums-and-match.md) |
| `std::variant` + `std::visit` | `enum` with data + `match` | [Enums and match](../foundations/enums-and-match.md) |
| `std::optional<T>`, nullable `T*` | `Option<T>`, `Option<&T>` | [Enums and match](../foundations/enums-and-match.md) |
| `switch` | `match` (exhaustive, no fall-through) | [Enums and match](../foundations/enums-and-match.md) |
| Structured bindings | Patterns: `let (a, b) = ...;`, `if let`, `let ... else` | [Enums and match](../foundations/enums-and-match.md) |

## Ownership and references

| C++ | Rust | Chapter |
|---|---|---|
| RAII, destructor | `Drop` | [Ownership](../foundations/ownership.md) |
| `auto y = std::move(x);` | `let y = x;` (and `x` is unusable) | [Ownership](../foundations/ownership.md) |
| Copy constructor | `.clone()` (`Clone`); implicit only for `Copy` types | [Ownership](../foundations/ownership.md) |
| Rule of five | Nothing to write; add `Drop` if needed | [Ownership](../foundations/ownership.md) |
| `const T&` | `&T` (many at once) | [Borrowing](../foundations/borrowing.md) |
| `T&` | `&mut T` (exclusive) | [Borrowing](../foundations/borrowing.md) |
| `std::span<T>`, `std::string_view` | `&[T]`, `&str` | [Borrowing](../foundations/borrowing.md) |
| `__restrict` | Every `&mut T` | [Borrowing](../foundations/borrowing.md) |
| Iterator invalidation (UB) | Compile error | [Borrowing](../foundations/borrowing.md) |
| Dangling reference (UB) | Compile error; lifetimes | [Lifetimes](../foundations/lifetimes.md) |
| Class holding a `string_view` | `struct View<'a> { s: &'a str }` | [Lifetimes](../foundations/lifetimes.md) |
| `std::unique_ptr<T>` | `Box<T>` | [Smart pointers](../foundations/smart-pointers.md) |
| `std::shared_ptr<T>` | `Rc<T>` (one thread), `Arc<T>` (atomic) | [Smart pointers](../foundations/smart-pointers.md) |
| `std::weak_ptr<T>` | `Weak<T>`, `.upgrade()` | [Smart pointers](../foundations/smart-pointers.md) |
| `mutable` member | `Cell<T>`, `RefCell<T>` | [Smart pointers](../foundations/smart-pointers.md) |
| Object pool + raw pointers | Arena + generational `Handle<T>` | [Handles and arenas](../engine/handles-and-arenas.md) |

## Classes, templates and operators

| C++ | Rust | Chapter |
|---|---|---|
| Member function / `const` member function | `fn f(&mut self)` / `fn f(&self)` | [Borrowing](../foundations/borrowing.md) |
| Abstract base class, virtual functions | Trait, `dyn Trait` | [Traits and generics](../foundations/traits-and-generics.md) |
| Template + concept | Generic with trait bounds | [Traits and generics](../foundations/traits-and-generics.md) |
| `auto f()` returning a hidden type | `fn f() -> impl Trait` | [Traits and generics](../foundations/traits-and-generics.md) |
| Nested `typedef` in a traits class | Associated type | [Traits and generics](../foundations/traits-and-generics.md) |
| Inheritance of data | Composition (+ traits for behavior) | [Traits and generics](../foundations/traits-and-generics.md) |
| `operator+`, `operator+=` | `impl Add`, `impl AddAssign` | [Operators](../foundations/operators-and-conversions.md) |
| `operator[]` | `Index`, `IndexMut` | [Operators](../foundations/operators-and-conversions.md) |
| `operator==`, `operator<=>` | `#[derive(PartialEq, Eq, PartialOrd, Ord)]` | [Operators](../foundations/operators-and-conversions.md) |
| Converting constructor | `From` / `Into` | [Operators](../foundations/operators-and-conversions.md) |
| `operator<<(ostream&, T)` | `impl Display`, `#[derive(Debug)]` | [Operators](../foundations/operators-and-conversions.md) |
| `operator->` on a smart pointer | `Deref` | [Operators](../foundations/operators-and-conversions.md) |
| Lambda | Closure (`move` for by-value capture) | [Closures and iterators](../foundations/closures-and-iterators.md) |
| `std::function<R(A)>` | `Box<dyn Fn(A) -> R>` | [Closures and iterators](../foundations/closures-and-iterators.md) |
| Callable template parameter | `impl Fn(A) -> R`, `F: FnMut(A) -> R` | [Closures and iterators](../foundations/closures-and-iterators.md) |

## Errors

| C++ | Rust | Chapter |
|---|---|---|
| Exceptions | `Result<T, E>` and `?` | [Errors](../foundations/errors.md) |
| `std::expected<T, E>` | `Result<T, E>` | [Errors](../foundations/errors.md) |
| `[[nodiscard]]` | `#[must_use]` (default on `Result`) | [Errors](../foundations/errors.md) |
| `assert`, `std::terminate` | `assert!`, `panic!`, `.expect("why")` | [Errors](../foundations/errors.md) |
| Exception class hierarchy | Error `enum` with `thiserror` | [Errors](../foundations/errors.md) |
| Catch-all handler at the top | `anyhow::Result` with `.context(...)` | [Errors](../foundations/errors.md) |
| `-fno-exceptions` | `panic = "abort"` | [Errors](../foundations/errors.md) |

## Standard library

| C++ | Rust | Chapter |
|---|---|---|
| `std::vector<T>` | `Vec<T>` | [Collections](../foundations/collections.md) |
| `v.at(i)` / `v[i]` | `v.get(i)` (`Option`) / `v[i]` (checked) | [Collections](../foundations/collections.md) |
| Erase-remove idiom | `v.retain(keep)` (keep is a closure) | [Collections](../foundations/collections.md) |
| `std::unordered_map`, `std::map` | `HashMap`, `BTreeMap` | [Collections](../foundations/collections.md) |
| `map[key]` (inserting) | `map.entry(key).or_default()` | [Collections](../foundations/collections.md) |
| `std::string` | `String` (always UTF-8) | [Collections](../foundations/collections.md) |
| `std::filesystem::path` | `PathBuf`, `&Path` | [Collections](../foundations/collections.md) |
| `<algorithm>`, ranges | Iterator adapters: `map`, `filter`, `zip`, `fold`, `collect` | [Closures and iterators](../foundations/closures-and-iterators.md) |
| `std::thread` | `std::thread::spawn`, `std::thread::scope` | [Concurrency](../systems/concurrency.md) |
| `std::mutex` next to the data | `Mutex<T>` containing the data | [Concurrency](../systems/concurrency.md) |
| BSD sockets, Winsock | `std::net::TcpStream`, `UdpSocket` | [Networking](../systems/networking.md) |
| Asio, C++20 coroutines | tokio, `async`/`.await` | [Networking](../systems/networking.md) |
| gRPC C++ | tonic | [Networking](../systems/networking.md) |
| `std::atomic<T>` | `AtomicU32` etc. with `Ordering` | [Concurrency](../systems/concurrency.md) |
| Thread pool / TBB `parallel_for` | `rayon`: `par_iter()` | [Concurrency](../systems/concurrency.md) |
| `std::chrono::steady_clock` | `std::time::Instant`, `Duration` | [Game loop](../engine/game-loop.md) |
| Function-local `static` | `OnceLock`, `LazyLock` | [Game loop](../engine/game-loop.md) |

## Build, modules and tooling

| C++ | Rust | Chapter |
|---|---|---|
| CMake + vcpkg/Conan | Cargo + crates.io | [Cargo](../foundations/cargo.md) |
| Debug / Release | `cargo build` / `cargo build --release` (profiles) | [Cargo](../foundations/cargo.md) |
| `add_subdirectory` | Workspace members | [Assets and build](../engine/assets-and-build.md) |
| `add_custom_command` | `build.rs` | [Assets and build](../engine/assets-and-build.md) |
| `namespace` | `mod` | [Modules](../foundations/modules.md) |
| `#include "x.h"` | `mod x;` + `use` | [Modules](../foundations/modules.md) |
| `public` / `private` | `pub` / private by default | [Modules](../foundations/modules.md) |
| `#ifdef` | `#[cfg(...)]`, Cargo features | [Macros](../systems/macros.md) |
| `#define` macros | `macro_rules!` | [Macros](../systems/macros.md) |
| Reflection macros, code generators | `#[derive(...)]` | [Macros](../systems/macros.md) |
| GoogleTest / Catch2 | `#[test]`, `cargo test` | [Testing](../systems/testing-and-tooling.md) |
| Google Benchmark | criterion | [Testing](../systems/testing-and-tooling.md) |
| clang-format / clang-tidy | `cargo fmt` / `cargo clippy` | [Testing](../systems/testing-and-tooling.md) |
| Doxygen | `cargo doc` (examples are tested) | [Testing](../systems/testing-and-tooling.md) |

## Low level

| C++ | Rust | Chapter |
|---|---|---|
| `sizeof`, `alignof`, `offsetof` | `size_of::<T>()`, `align_of::<T>()`, `offset_of!` | [Memory and performance](../systems/memory-and-performance.md) |
| Declaration-order layout | `#[repr(C)]` | [Memory and performance](../systems/memory-and-performance.md) |
| `alignas(64)` | `#[repr(align(64))]` | [Memory and performance](../systems/memory-and-performance.md) |
| Replace `operator new` | `#[global_allocator]` | [Memory and performance](../systems/memory-and-performance.md) |
| Arena / linear allocator | `bumpalo` | [Handles and arenas](../engine/handles-and-arenas.md) |
| `T*` | `*const T`, `*mut T` (deref in `unsafe`) | [Unsafe](../systems/unsafe.md) |
| Uninitialized storage | `MaybeUninit<T>` | [Unsafe](../systems/unsafe.md) |
| `reinterpret_cast` | Pointer `as` casts; `bytemuck` for safe byte views | [Unsafe](../systems/unsafe.md) |
| ASan / UBSan | Miri | [Unsafe](../systems/unsafe.md) |
| `extern "C"` declarations | `unsafe extern "C" { ... }` | [FFI](../systems/ffi.md) |
| Exporting a C API | `#[unsafe(no_mangle)] pub extern "C" fn` | [FFI](../systems/ffi.md) |
| `char*` strings | `CStr`, `CString`, `c"..."` | [FFI](../systems/ffi.md) |
| Headers → bindings | bindgen; cbindgen for the reverse | [FFI](../systems/ffi.md) |
| `<immintrin.h>` | `std::arch` + `#[target_feature]` | [Math and SIMD](../engine/math-and-simd.md) |
| `LoadLibrary` / `dlopen` | `libloading` | [Hot reloading](../engine/hot-reload-and-plugins.md) |

## Graphics and engine

| C++ | Rust | Chapter |
|---|---|---|
| GLM / DirectXMath | glam | [Math and SIMD](../engine/math-and-simd.md) |
| `memcpy` a struct into a GPU buffer | `bytemuck::cast_slice` on `#[derive(Pod)]` types | [Math and SIMD](../engine/math-and-simd.md) |
| GLFW / SDL | winit (`ApplicationHandler`) | [Game loop](../engine/game-loop.md) |
| glad / GLEW | `gl`, `glow` | [OpenGL](../engine/opengl.md) |
| `vulkan.h` / volk | ash | [Vulkan](../engine/vulkan.md) |
| VMA | gpu-allocator, vk-mem | [Vulkan](../engine/vulkan.md) |
| Dawn, bgfx, sokol_gfx | wgpu | [wgpu](../engine/wgpu.md) |
| `openxr.h`, OpenXR-Hpp | `openxr-sys`, `openxr` | [OpenXR](../engine/openxr.md) |
| glslc / dxc | naga, shaderc, from `build.rs` | [wgpu](../engine/wgpu.md) |
| EnTT, flecs | hecs, bevy_ecs | [ECS](../engine/ecs.md) |
| Singletons | Context passed as a parameter; ECS resources | [Game loop](../engine/game-loop.md) |
| Custom serialization / reflection | serde | [Assets and build](../engine/assets-and-build.md) |
| sol2 (Lua) | mlua | [Hot reloading](../engine/hot-reload-and-plugins.md) |

## When the borrow checker says no

| Symptom | Usual fix | Chapter |
|---|---|---|
| "cannot borrow as mutable because it is also borrowed as immutable" | Shorten the first borrow: copy the value out, or finish using it first | [Borrowing](../foundations/borrowing.md) |
| Pushing to a `Vec` while holding a reference into it | Hold an index instead of a reference | [Borrowing](../foundations/borrowing.md) |
| Two `&mut` into the same struct | Borrow separate fields (split borrows); destructure `let S { a, b } = &mut s;` | [ECS](../engine/ecs.md) |
| Two `&mut` into the same slice | `split_at_mut`, `chunks_mut`, `iter_mut` | [Collections](../foundations/collections.md) |
| A struct wants to store a reference to another object | Store a handle or index; or own the data | [Handles and arenas](../engine/handles-and-arenas.md) |
| Objects pointing at each other (graph, parent links) | Arena + handles; `Rc` + `Weak` only if ownership is truly shared | [ECS](../engine/ecs.md) |
| "borrowed value does not live long enough" | Move the owner to an outer scope, or return an owned value | [Lifetimes](../foundations/lifetimes.md) |
| "`Rc<...>` cannot be sent between threads safely" | `Arc` (and `Mutex` for mutation) | [Concurrency](../systems/concurrency.md) |
| A closure passed to `thread::spawn` borrows a local | `move` the data in, or use `thread::scope` | [Concurrency](../systems/concurrency.md) |
| Global mutable state | Pass a context; or `Mutex`, atomics, `OnceLock` | [Game loop](../engine/game-loop.md) |
