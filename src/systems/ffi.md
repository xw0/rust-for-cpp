# FFI with C and C++

Your engine already has millions of lines of C and C++, and every graphics API,
platform layer and middleware library speaks C. Rust talks to C directly, with
no wrapper layer and no overhead: a call from Rust to a C function is the same
machine-level call a C program would make. This chapter covers both
directions, the tools that generate bindings, and how to bring Rust into an
existing CMake project.

This chapter covers:

- calling C functions, and the types to use at the boundary,
- callbacks from C into Rust,
- generating bindings with bindgen,
- exposing Rust to C and C++ with cbindgen,
- C++ interop with cxx,
- linking: `build.rs`, static and dynamic libraries, and Corrosion for CMake,
- ownership across the boundary.

## Calling C

Declare foreign functions in an `extern "C"` block. In the 2024 edition the
block is marked `unsafe extern`, because the compiler cannot check that your
declaration matches the real function:

```rust
use std::ffi::{CStr, CString, c_char, c_int, c_void};

unsafe extern "C" {
    fn strlen(s: *const c_char) -> usize;
    fn abs(x: c_int) -> c_int;
    fn qsort(
        base: *mut c_void,
        n: usize,
        size: usize,
        cmp: extern "C" fn(*const c_void, *const c_void) -> c_int,
    );
}

// A Rust function with the C calling convention, usable as a C callback.
extern "C" fn cmp_floats(a: *const c_void, b: *const c_void) -> c_int {
    // SAFETY: qsort passes pointers to elements of our f32 array.
    let (a, b) = unsafe { (*(a as *const f32), *(b as *const f32)) };
    a.total_cmp(&b) as c_int
}

fn main() {
    let name = CString::new("u_projection").unwrap();
    let len = unsafe { strlen(name.as_ptr()) };
    let a = unsafe { abs(-7) };

    let mut depths = [3.5f32, -1.0, 2.25, 0.0];
    unsafe {
        qsort(depths.as_mut_ptr() as *mut c_void, depths.len(), size_of::<f32>(), cmp_floats);
    }

    let back: &CStr = name.as_c_str();
    println!("{len} {a} {depths:?} {:?}", back.to_str());
}
```

These particular functions are in the C runtime that every Rust program links
anyway. For other libraries you tell the linker what to link (below).

### Types at the boundary

Use only FFI-safe types in `extern` signatures:

| C | Rust |
|---|---|
| `int`, `unsigned`, `long`, `char` | `c_int`, `c_uint`, `c_long`, `c_char` (from `std::ffi`) |
| `int32_t`, `uint64_t`, `float`, `double` | `i32`, `u64`, `f32`, `f64` |
| `size_t` | `usize` |
| `bool` (C99) | `bool` |
| `T*`, `const T*` | `*mut T`, `*const T` |
| `T*` that is never null | `&T` / `&mut T` / `NonNull<T>` (if you can guarantee it) |
| `T*` that may be null | `Option<&T>`, `Option<NonNull<T>>`, or a raw pointer |
| `const char*` (string) | `*const c_char`; convert with `CStr` / `CString` |
| `void*` | `*mut c_void` |
| Function pointer | `extern "C" fn(...) -> ...` (or `Option<...>` if nullable) |
| `struct` | `#[repr(C)] struct` |
| `enum` | `#[repr(C)]`/`#[repr(i32)]` enum **only** if C can never pass other values; otherwise an integer and constants |
| Opaque handle (`struct VkDevice_T*`) | A pointer to an opaque `#[repr(C)] struct` with a private zero-sized field |

`String`, `Vec`, `&str`, slices, `Box<dyn Trait>`, trait objects and Rust enums
with data have no stable C representation. Pass pointer-and-length pairs
instead.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">Enums from C</span>

A Rust `enum` must only ever hold one of its declared values; anything else is
undefined behavior. C APIs regularly return values that were not in the header
you compiled against (a newer driver adds a `VkResult`). So do not declare C
enums as Rust enums in FFI signatures. Bindgen's default is to emit them as
integer constants for exactly this reason.

</div>

## Generating bindings with bindgen

Writing declarations by hand is error-prone for real libraries. **bindgen**
reads C headers through libclang and generates the Rust declarations, usually
from `build.rs`:

```rust,ignore
// build.rs
fn main() {
    println!("cargo::rerun-if-changed=wrapper.h");
    println!("cargo::rustc-link-lib=dylib=physics");          // link libphysics
    println!("cargo::rustc-link-search=native=third_party/physics/lib");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")                                   // #include "physics.h"
        .allowlist_function("ph_.*")                           // only what we need
        .allowlist_type("ph_.*")
        .generate()
        .expect("bindgen failed");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings.write_to_file(out.join("physics_sys.rs")).unwrap();
}
```

```rust,ignore
// src/lib.rs of a `physics-sys` crate
#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]
include!(concat!(env!("OUT_DIR"), "/physics_sys.rs"));
```

By convention a crate named `foo-sys` contains only the raw bindings and the
linking logic, and a separate `foo` crate wraps them in a safe API. You will
see this pattern across the ecosystem: `ash` (Vulkan), `glfw-sys`, `sdl2-sys`,
`openxr-sys`.

## Wrapping a C API safely

The safe wrapper is where Rust pays off: you encode the C library's rules
(creation and destruction pairing, which objects must outlive which, which
calls are thread-safe) in Rust types. A sketch for a physics library with
opaque handles:

```rust
// --- what bindgen would generate (stubbed so the example runs) ---
#[allow(non_camel_case_types)]
mod sys {
    #[repr(C)]
    pub struct ph_world { _private: [u8; 0] }   // opaque type
    pub unsafe fn ph_world_create(gravity: f32) -> *mut ph_world {
        println!("ph_world_create({gravity})");
        Box::into_raw(Box::new([0u8; 1])) as *mut ph_world
    }
    pub unsafe fn ph_world_step(_w: *mut ph_world, dt: f32) -> i32 {
        if dt > 0.0 { 0 } else { -1 }
    }
    pub unsafe fn ph_world_destroy(w: *mut ph_world) {
        println!("ph_world_destroy");
        drop(unsafe { Box::from_raw(w as *mut [u8; 1]) });
    }
}

// --- the safe wrapper ---
use std::ptr::NonNull;

pub struct World {
    raw: NonNull<sys::ph_world>,   // never null while World exists
}

#[derive(Debug)]
pub struct StepError(i32);

impl World {
    pub fn new(gravity: f32) -> Option<World> {
        let raw = unsafe { sys::ph_world_create(gravity) };
        NonNull::new(raw).map(|raw| World { raw })   // null -> None
    }

    // &mut self: the C library says a world must not be stepped concurrently,
    // and &mut makes that a compile-time guarantee.
    pub fn step(&mut self, dt: f32) -> Result<(), StepError> {
        match unsafe { sys::ph_world_step(self.raw.as_ptr(), dt) } {
            0 => Ok(()),
            code => Err(StepError(code)),
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        unsafe { sys::ph_world_destroy(self.raw.as_ptr()) };
    }
}

fn main() {
    let mut world = World::new(-9.81).expect("could not create world");
    world.step(1.0 / 60.0).unwrap();
    println!("{:?}", world.step(-1.0));
}   // destroyed exactly once, here
```

The wrapper makes the C API's rules impossible to break: you cannot forget to
destroy the world, destroy it twice, use it after destroying it, or step it
from two threads at once. Note that `World` is automatically neither `Send` nor
`Sync` because it holds a raw pointer; if the C library allows using a world
from another thread, you add `unsafe impl Send for World {}` and document why.

## Exposing Rust to C and C++

To be callable from C, a Rust function needs the C ABI and an unmangled name:

```rust
use std::ffi::{CStr, c_char};

/// Returns the number of vertices in an OBJ file's text, or -1 on error.
#[unsafe(no_mangle)]
pub extern "C" fn obj_count_vertices(text: *const c_char) -> i64 {
    if text.is_null() {
        return -1;
    }
    // SAFETY: the caller promises a valid NUL-terminated string.
    let Ok(s) = unsafe { CStr::from_ptr(text) }.to_str() else {
        return -1;
    };
    s.lines().filter(|l| l.starts_with("v ")).count() as i64
}

fn main() {
    let src = c"v 0 0 0\nv 1 0 0\nf 1 2 3\n";      // a C string literal
    println!("{}", obj_count_vertices(src.as_ptr()));
}
```

Build the crate as `crate-type = ["staticlib"]` or `["cdylib"]`
([Cargo](../foundations/cargo.md)) and link the result into your C++ program.
**cbindgen** generates the matching C or C++ header from the Rust source,
the reverse of bindgen.

Never let a panic unwind across an `extern "C"` boundary into C++. Since Rust
1.81, a panic that would unwind out of an `extern "C"` function aborts the
process instead, which is safe but abrupt. Catch errors and return error codes
at the boundary.

## C++ interop with cxx

C has a stable ABI; C++ does not. Calling C++ classes, templates or
`std::string` directly from Rust is not possible. The **cxx** crate provides a
safe, zero-overhead bridge for a declared subset: you describe the shared
interface once in Rust, and cxx generates both the Rust and the C++ glue,
checking at compile time that both sides match.

```rust,ignore
#[cxx::bridge]
mod ffi {
    // Shared struct, visible to both languages.
    struct MeshInfo {
        name: String,
        vertex_count: u32,
    }

    unsafe extern "C++" {
        include!("engine/asset_db.h");
        type AssetDb;                                  // an opaque C++ class
        fn open_asset_db(path: &str) -> UniquePtr<AssetDb>;
        fn mesh_info(self: &AssetDb, id: u64) -> MeshInfo;
    }

    extern "Rust" {
        fn validate_mesh(info: &MeshInfo) -> bool;     // callable from C++
    }
}

fn validate_mesh(info: &ffi::MeshInfo) -> bool {
    info.vertex_count > 0 && !info.name.is_empty()
}
```

cxx understands `std::unique_ptr`, `std::shared_ptr`, `std::string`,
`std::vector` and `rust::String`/`rust::Vec`/`rust::Slice` on the C++ side.
For large existing C++ APIs, `autocxx` generates cxx bridges from headers.

## Rust inside a CMake project

To introduce Rust into an existing C++ engine incrementally, add a Rust crate
as a library and let CMake drive Cargo. **Corrosion** does this:

```cmake
include(FetchContent)
FetchContent_Declare(Corrosion
    GIT_REPOSITORY https://github.com/corrosion-rs/corrosion.git
    GIT_TAG v0.5)
FetchContent_MakeAvailable(Corrosion)

corrosion_import_crate(MANIFEST_PATH rust/asset_tools/Cargo.toml)

add_executable(editor src/main.cpp)
target_link_libraries(editor PRIVATE asset_tools)   # the Rust staticlib
```

A common first project is a self-contained subsystem with a narrow interface:
an asset importer, a file-format parser, a networking layer, or a tool. Those
benefit most from Rust's safety (they handle untrusted input) and need the
least interop.

## Ownership across the boundary

The rules you follow in C APIs still apply, and Rust gives you tools to state
them:

- **Memory allocated by Rust must be freed by Rust**, and memory from C by C.
  Export a `free` function: `Box::into_raw` hands a pointer to C, and
  `Box::from_raw` in your `xxx_destroy` function takes it back.
- **Strings:** pass `*const c_char` in (borrowed, via `CStr`) and return either
  a pointer into Rust-owned storage that C must not free, or a `CString`
  turned into a raw pointer with a matching `free_string` function.
- **Callbacks with context:** pass a `*mut c_void` user pointer alongside an
  `extern "C" fn`, and cast it back to the right type in the callback.

## Summary

| C / C++ | Rust |
|---|---|
| Declaring a C function | `unsafe extern "C" { fn f(...); }` |
| Function pointer callback | `extern "C" fn(...)` |
| `extern "C"` + `__declspec(dllexport)` | `#[unsafe(no_mangle)] pub extern "C" fn` |
| Writing headers for bindings | bindgen (C → Rust), cbindgen (Rust → C) |
| C++ class interop | cxx, autocxx |
| `char*` strings | `CStr` (borrowed), `CString` (owned), `c"..."` literals |
| `target_link_libraries` | `cargo::rustc-link-lib` in `build.rs` |
| Rust library in CMake | Corrosion |

## Exercises

1. Use `qsort` from the C library to sort an array of `#[repr(C)] struct
   DrawItem { key: u64, mesh: u32 }` by `key`.
2. Write `#[unsafe(no_mangle)] extern "C"` functions `counter_new`,
   `counter_increment` and `counter_free` that manage a `Box<u64>` across the
   boundary, and a Rust `main` that calls them the way C would.
3. In the `World` wrapper, add a `Body` type created by `World` that must not
   outlive it. Give `Body` a lifetime parameter tied to the world (`Body<'w>`)
   and check that dropping the world first does not compile.
