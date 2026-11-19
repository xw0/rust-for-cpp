# Error handling

C++ has too many ways to report an error: exceptions, error codes, `errno`,
`HRESULT`, `VkResult`, `std::error_code`, `std::expected`, `bool` plus an out
parameter, and `assert`. Engines usually ban exceptions and end up with a mix
of the rest. Rust has two mechanisms with a clear division of labor:

- **`Result<T, E>`** for errors a caller can reasonably handle: a missing file, a
  malformed asset, a device that failed to initialize. It is an ordinary
  return value, as cheap as an error code.
- **`panic!`** for bugs: a broken invariant, an out-of-bounds index, an
  `unwrap()` on something that was supposed to be there. It is like a failed
  `assert` that stays on in release builds.

This chapter covers both, the `?` operator that makes `Result` pleasant, how
to define error types, and wrapping C error codes.

## `Result<T, E>`

`Result` is an enum from the standard library:

```rust
enum Result<T, E> {
    Ok(T),
    Err(E),
}
# fn main() {}
```

A function that can fail returns it, and the caller must look at it to get the
value out. There is no way to accidentally ignore the error and use the
garbage value, which is the classic bug with error codes and out parameters.

```rust
use std::fs;
use std::io;

fn read_shader(path: &str) -> Result<String, io::Error> {
    fs::read_to_string(path)
}

fn main() {
    match read_shader("shaders/missing.glsl") {
        Ok(src) => println!("{} bytes", src.len()),
        Err(e) => println!("could not load shader: {e}"),
    }
}
```

The compiler also warns if you call a function returning `Result` and drop the
result on the floor (`Result` is marked `#[must_use]`, the equivalent of
`[[nodiscard]]`).

## The `?` operator

Checking every call by hand would be as tedious as checking every `VkResult`.
The `?` operator does it for you: on `Ok(v)` it evaluates to `v`; on `Err(e)` it
**returns early** from the current function with that error, converting it to
the function's error type if needed.

<div class="rfc-compare">
<div class="rfc-cpp">

C++ with error codes

```cpp
VkResult create_renderer(Renderer* out) {
    VkResult r;
    r = create_instance(&out->instance);
    if (r != VK_SUCCESS) return r;
    r = pick_device(out->instance, &out->device);
    if (r != VK_SUCCESS) return r;
    r = create_swapchain(out->device, &out->swapchain);
    if (r != VK_SUCCESS) return r;
    return VK_SUCCESS;
}
```

</div>
<div class="rfc-rust">

Rust with `?`

```rust
# struct Instance; struct Device; struct Swapchain;
# struct Renderer { instance: Instance, device: Device, swapchain: Swapchain }
# #[derive(Debug)] struct GfxError;
# fn create_instance() -> Result<Instance, GfxError> { Ok(Instance) }
# fn pick_device(_: &Instance) -> Result<Device, GfxError> { Ok(Device) }
# fn create_swapchain(_: &Device) -> Result<Swapchain, GfxError> { Ok(Swapchain) }
fn create_renderer() -> Result<Renderer, GfxError> {
    let instance = create_instance()?;
    let device = pick_device(&instance)?;
    let swapchain = create_swapchain(&device)?;
    Ok(Renderer { instance, device, swapchain })
}
# fn main() { create_renderer().unwrap(); }
```

</div>
</div>

The control flow is identical to the C++ version: every `?` is an early return.
It is just visible as one character instead of three lines. Unlike exceptions,
there is no hidden path out of a function; every place that can return an
error is marked with `?`.

`?` also works on `Option` in functions that return `Option`, returning `None`
early.

## Defining error types

For a library, define an enum of the things that can go wrong, implement
`Display` for messages and `std::error::Error` so it composes with other
errors. Implement `From` for the underlying errors and `?` converts them
automatically:

```rust
use std::fmt;
use std::num::ParseIntError;

#[derive(Debug)]
enum ObjError {
    Io(std::io::Error),
    BadNumber { line: usize, source: ParseIntError },
    UnknownDirective { line: usize, text: String },
}

impl fmt::Display for ObjError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ObjError::Io(e) => write!(f, "I/O error: {e}"),
            ObjError::BadNumber { line, source } => write!(f, "line {line}: {source}"),
            ObjError::UnknownDirective { line, text } => write!(f, "line {line}: unknown `{text}`"),
        }
    }
}

impl std::error::Error for ObjError {}

impl From<std::io::Error> for ObjError {
    fn from(e: std::io::Error) -> Self {
        ObjError::Io(e)
    }
}

/// Count faces in a tiny subset of the OBJ format.
fn count_faces(text: &str) -> Result<usize, ObjError> {
    let mut faces = 0;
    for (i, line) in text.lines().enumerate() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            None | Some("#") | Some("v") | Some("vn") => {}
            Some("f") => {
                for p in parts {
                    let idx = p.split('/').next().unwrap_or("");
                    idx.parse::<u32>()
                        .map_err(|source| ObjError::BadNumber { line: i + 1, source })?;
                }
                faces += 1;
            }
            Some(other) => {
                return Err(ObjError::UnknownDirective { line: i + 1, text: other.to_string() })
            }
        }
    }
    Ok(faces)
}

fn main() {
    println!("{:?}", count_faces("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").map_err(|e| e.to_string()));
    match count_faces("v 0 0 0\nf 1 x 3\n") {
        Ok(n) => println!("{n} faces"),
        Err(e) => println!("error: {e}"),
    }
    if let Err(e) = count_faces("usemtl brick\n") {
        println!("error: {e}");
    }
}
```

That is a lot of boilerplate, and in practice two crates remove it:

- **`thiserror`** for libraries: `#[derive(thiserror::Error)]` with
  `#[error("line {line}: {source}")]` attributes generates the `Display`,
  `Error` and `From` implementations above.
- **`anyhow`** for applications: `anyhow::Result<T>` holds *any* error, and
  `.context("loading level")?` adds a human-readable layer, so the final
  message reads like a stack of reasons ("loading level: reading mesh.obj:
  file not found").

A good rule: libraries return precise error enums so callers can react to
specific cases; applications collect errors with `anyhow` and report them.

```rust,ignore
// An application using anyhow (not runnable here: it needs the crate)
use anyhow::{Context, Result};

fn load_level(name: &str) -> Result<Level> {
    let path = format!("levels/{name}.ron");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {path}"))?;
    let level = parse_level(&text).context("parsing level")?;
    Ok(level)
}

fn main() -> Result<()> {
    let level = load_level("e1m1")?;  // main can return Result: errors are printed
    run(level)
}
```

## Panics

A **panic** means "this is a bug; stop". `panic!("...")`, `unreachable!()`,
`assert!(cond)`, an out-of-bounds index, integer overflow in debug builds and
`unwrap()` on `None`/`Err` all panic.

By default a panic **unwinds** the stack of the current thread, running `Drop`
for everything on the way, like an exception that nobody catches. If it reaches
the top of `main`, the program exits with an error message. If it happens on
another thread, that thread dies and `join()` returns an error. With
`panic = "abort"` in the profile, a panic aborts the process immediately
instead, which is what most game builds want: smaller binaries, no unwinding
tables, and a crash dump at the exact point of failure.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

A panic is not an exception to be caught and recovered from. Do not use it
for expected failures, and do not structure code around catching it
(`std::panic::catch_unwind` exists for FFI boundaries and thread pools, not for
control flow). Expected failure is `Result`; a panic is an `assert`.

</div>

When is `unwrap()` acceptable?

- In tests, examples and prototypes.
- When the invariant is guaranteed by your own code just above, and an error
  would be a bug. Prefer `expect("why this cannot fail")`, which documents the
  reason and appears in the panic message.
- At startup, for resources the program truly cannot run without, although
  returning an error from `main` gives a nicer message.

## Wrapping C error codes

C APIs report errors as integers. Convert them at the boundary, once, so the
rest of the code works with `Result`:

```rust
// Pretend these come from a C header via bindgen.
#[allow(non_camel_case_types)]
type VkResult = i32;
const VK_SUCCESS: VkResult = 0;
const VK_ERROR_OUT_OF_DEVICE_MEMORY: VkResult = -2;
const VK_ERROR_DEVICE_LOST: VkResult = -4;

#[derive(Debug, PartialEq)]
enum VkError {
    OutOfDeviceMemory,
    DeviceLost,
    Other(i32),
}

fn check(r: VkResult) -> Result<(), VkError> {
    match r {
        VK_SUCCESS => Ok(()),
        VK_ERROR_OUT_OF_DEVICE_MEMORY => Err(VkError::OutOfDeviceMemory),
        VK_ERROR_DEVICE_LOST => Err(VkError::DeviceLost),
        other => Err(VkError::Other(other)),
    }
}

fn allocate(size: u64) -> Result<u64, VkError> {
    let r = if size > 1 << 30 { VK_ERROR_OUT_OF_DEVICE_MEMORY } else { VK_SUCCESS }; // the "C call"
    check(r)?;
    Ok(0xdead_0000)
}

fn main() {
    println!("{:?}", allocate(256));
    println!("{:?}", allocate(4 << 30));
}
```

The `ash` crate does this for all of Vulkan: every function returns
`VkResult<T>`, a `Result<T, vk::Result>`. See the [Vulkan
chapter](../engine/vulkan.md).

## Summary

| C++ | Rust |
|---|---|
| Exceptions for recoverable errors | `Result<T, E>` and `?` |
| Error codes + out parameters | `Result<T, E>` |
| `[[nodiscard]]` | `#[must_use]` (on `Result` by default) |
| `std::expected<T, E>` (C++23) | `Result<T, E>` |
| `assert`, `std::terminate` | `assert!`, `panic!`, `unwrap()`, `expect()` |
| `-fno-exceptions` | `panic = "abort"` |
| Custom exception hierarchy | Error enum + `std::error::Error` (`thiserror`) |
| Catch-all error reporting | `anyhow::Error` with `.context()` |

## Exercises

1. Change `count_faces` to also accept `vt` lines, and to reject faces with
   fewer than three vertices with a new `ObjError` variant.
2. Write `fn parse_resolution(s: &str) -> Result<(u32, u32), String>` for input
   like `"1920x1080"`, using `?` and `map_err`.
3. Make `main` return `Result<(), Box<dyn std::error::Error>>` and use `?` on a
   file read. What gets printed when the file does not exist?
