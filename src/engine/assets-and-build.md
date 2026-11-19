# Assets, build scripts and serialization

A C++ engine's build is more than compiling C++: shaders are compiled to
SPIR-V or DXIL, textures are compressed, meshes are converted, and code is
generated from schemas, all wired into CMake with `add_custom_command`. At run
time, an asset manager loads the results, often on worker threads, and
reloads them when they change. This chapter covers the Rust equivalents.

This chapter covers:

- `build.rs` build scripts for shader compilation and code generation,
- embedding files in the binary,
- serialization with serde,
- an asset cache with typed handles and background loading,
- watching files for hot reload,
- organizing an engine as a Cargo workspace.

## Build scripts

A file named `build.rs` in a package root is compiled and run by Cargo
**before** the package itself is compiled. It is ordinary Rust, so it can do
anything: run a compiler, generate code, compile a C library with the `cc`
crate (see [FFI](../systems/ffi.md)). It talks to Cargo by printing
`cargo::` lines to stdout.

Here is a build script that compiles every GLSL shader in `shaders/` to SPIR-V
with `glslc`:

```rust,ignore
// build.rs
use std::path::Path;
use std::process::Command;

fn main() {
    let out_dir = std::env::var("OUT_DIR").unwrap();   // Cargo's per-build scratch dir
    println!("cargo::rerun-if-changed=shaders");       // only rerun when shaders change

    for entry in std::fs::read_dir("shaders").unwrap() {
        let path = entry.unwrap().path();
        let ext = path.extension().and_then(|e| e.to_str());
        if !matches!(ext, Some("vert" | "frag" | "comp")) {
            continue;
        }
        let file_name = path.file_name().unwrap().to_str().unwrap();
        let output = Path::new(&out_dir).join(format!("{file_name}.spv"));
        let status = Command::new("glslc")
            .arg(&path)
            .arg("-o")
            .arg(&output)
            .status()
            .expect("glslc not found: install the Vulkan SDK");
        if !status.success() {
            panic!("shader compilation failed: {}", path.display());
        }
    }
}
```

The crate then embeds the results:

```rust,ignore
// src/shaders.rs
pub const MESH_VERT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/mesh.vert.spv"));
pub const MESH_FRAG: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/mesh.frag.spv"));
```

Things to know:

- **`OUT_DIR`** is where build scripts write. Never write into `src/`: Cargo
  may build several configurations in parallel, and `src/` is not a build
  directory.
- **`cargo::rerun-if-changed=PATH`** limits reruns to changes in that path. Without
  any `rerun-if` line, the script reruns when any file in the package changes.
- **Build dependencies** go in `[build-dependencies]` in `Cargo.toml`, separate
  from the crate's own dependencies. `shaderc`, `cc`, `bindgen` and
  `naga` are common ones.
- **Errors** are reported by panicking or exiting with a non-zero code; Cargo
  shows the script's stderr. `cargo::warning=message` prints a warning without
  failing.
- **Environment for the crate**: `cargo::rustc-env=KEY=value` sets a variable
  readable with `env!("KEY")` in the crate (a version string, a git hash).

A build script replaces `add_custom_command` plus the dependency tracking you
would otherwise write in CMake. For heavy asset processing (texture
compression of gigabytes of data), engines usually keep a separate asset
cooker binary instead, run explicitly or by the editor, so `cargo build` stays
fast.

## Embedding files

Three macros read files at compile time, relative to the current source file:

| Macro | Result | C++ equivalent |
|---|---|---|
| `include_bytes!("logo.png")` | `&'static [u8; N]` | `xxd -i`, `#embed` (C23) |
| `include_str!("shader.wgsl")` | `&'static str` (must be UTF-8) | Raw string with `#include`, `#embed` |
| `include!("generated.rs")` | Rust code pasted in | `#include` |

Embedded data needs no file I/O and no path handling at run time, which makes
it ideal for default assets, fonts, shaders and small tools. For large
asset sets, load from disk so you can change assets without rebuilding.

A common pattern is to embed in release builds and load from disk in debug
builds, for hot reloading:

```rust
fn shader_source(name: &str) -> std::borrow::Cow<'static, str> {
    #[cfg(not(debug_assertions))]
    {
        // In a real project: match name { "mesh" => include_str!("../shaders/mesh.wgsl"), ... }
        let _ = name;
        return std::borrow::Cow::Borrowed("/* embedded */");
    }
    #[cfg(debug_assertions)]
    {
        let path = format!("shaders/{name}.wgsl");
        std::fs::read_to_string(&path)
            .map(std::borrow::Cow::Owned)
            .unwrap_or_else(|e| std::borrow::Cow::Owned(format!("/* {path}: {e} */")))
    }
}

fn main() {
    println!("{}", shader_source("mesh"));
}
```

`Cow<'static, str>` ("clone on write") holds either a borrowed `&'static str`
or an owned `String`, so both branches return the same type without copying
the embedded text.

## Serialization with serde

[serde](https://serde.rs) is the standard serialization framework. You derive
`Serialize` and `Deserialize` on your types, and pick a format crate:
`serde_json`, `ron` (Rusty Object Notation, popular for game data), `toml`,
`bincode` or `postcard` (compact binary), `rmp-serde` (MessagePack). The
derive generates code at compile time from the type definition, so there is no
runtime reflection and no schema file. It is the replacement for the
reflection macros and code generators C++ engines use for this
([Macros](../systems/macros.md) explains derives).

```rust,ignore
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct MaterialDesc {
    shader: String,
    #[serde(default = "default_color")]
    base_color: [f32; 4],
    textures: Vec<TextureSlot>,
    #[serde(default)]
    double_sided: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TextureSlot {
    Albedo { path: String },
    Normal { path: String, strength: f32 },
}

fn default_color() -> [f32; 4] { [1.0; 4] }

let text = r#"(
    shader: "pbr",
    textures: [
        (kind: "albedo", path: "rock_albedo.ktx2"),
        (kind: "normal", path: "rock_normal.ktx2", strength: 0.8),
    ],
)"#;
let material: MaterialDesc = ron::from_str(text)?;
let as_json = serde_json::to_string_pretty(&material)?;
```

Points for C++ programmers:

- Enums serialize naturally, including variants with data, which is awkward in
  most C++ serializers.
- Errors are values with position information ("missing field `shader` at line
  2 column 1"), not crashes or silently default-initialized fields.
- The same derive works for every format. A level can be RON while you edit it
  and bincode when you ship it, with no code change.
- Attributes customize the mapping: `rename`, `default`, `skip`, `flatten`,
  `with = "module"` for custom field encoding.

For zero-copy loading of large binary assets (the "mmap the file and cast it"
technique), serde is the wrong tool. Use `bytemuck` on `#[repr(C)]` data
([Math and SIMD](math-and-simd.md)) or the [rkyv](https://docs.rs/rkyv) crate,
which validates a byte buffer once and then gives you references into it.

## An asset cache with typed handles

Engines refer to assets by handle, for the same reasons as game objects
([Handles and arenas](handles-and-arenas.md)): assets load asynchronously, can
be reloaded, and are shared by many users. Here is a small cache that loads on
background threads and delivers results through a channel, all in the
standard library:

```rust
use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

pub struct Handle<T> { id: u32, _t: PhantomData<fn() -> T> }
impl<T> Clone for Handle<T> { fn clone(&self) -> Self { *self } }
impl<T> Copy for Handle<T> {}

pub enum Slot<T> { Loading, Ready(T), Failed(String) }

pub trait Asset: Send + 'static + Sized {
    fn load(path: &str) -> Result<Self, String>;
}

pub struct Assets<T: Asset> {
    by_path: HashMap<String, u32>,
    slots: Vec<Slot<T>>,
    tx: Sender<(u32, Result<T, String>)>,
    rx: Receiver<(u32, Result<T, String>)>,
}

impl<T: Asset> Assets<T> {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        Assets { by_path: HashMap::new(), slots: Vec::new(), tx, rx }
    }

    /// Returns immediately. Loading the same path twice returns the same handle.
    pub fn load(&mut self, path: &str) -> Handle<T> {
        if let Some(&id) = self.by_path.get(path) {
            return Handle { id, _t: PhantomData };
        }
        let id = self.slots.len() as u32;
        self.slots.push(Slot::Loading);
        self.by_path.insert(path.to_string(), id);
        let (tx, path) = (self.tx.clone(), path.to_string());
        thread::spawn(move || {
            let _ = tx.send((id, T::load(&path)));   // the receiver may be gone at shutdown
        });
        Handle { id, _t: PhantomData }
    }

    /// Call once per frame: moves finished loads into their slots.
    pub fn update(&mut self) {
        for (id, result) in self.rx.try_iter() {
            self.slots[id as usize] = match result {
                Ok(asset) => Slot::Ready(asset),
                Err(e) => Slot::Failed(e),
            };
        }
    }

    pub fn get(&self, h: Handle<T>) -> Option<&T> {
        match &self.slots[h.id as usize] {
            Slot::Ready(asset) => Some(asset),
            _ => None,
        }
    }

    pub fn status(&self, h: Handle<T>) -> &'static str {
        match &self.slots[h.id as usize] {
            Slot::Loading => "loading",
            Slot::Ready(_) => "ready",
            Slot::Failed(_) => "failed",
        }
    }
}

// A fake texture type whose "loading" takes a little time.
struct Texture { width: u32 }
impl Asset for Texture {
    fn load(path: &str) -> Result<Self, String> {
        thread::sleep(Duration::from_millis(20));
        if path.ends_with(".ktx2") { Ok(Texture { width: 512 }) } else { Err(format!("{path}: unknown format")) }
    }
}

fn main() {
    let mut textures: Assets<Texture> = Assets::new();
    let rock = textures.load("rock.ktx2");
    let rock_again = textures.load("rock.ktx2");
    let bad = textures.load("sky.bmp");

    for frame in 0..4 {
        textures.update();
        let width = textures.get(rock).map(|t| t.width);
        println!("frame {frame}: rock {} {:?}, sky {}", textures.status(rock), width, textures.status(bad));
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(rock.id, rock_again.id);
}
```

What the types guarantee:

- `T: Send` on `Asset` is required because the loaded value crosses from the
  worker thread to the main thread. A texture type holding an `Rc` would be
  rejected at compile time.
- `Handle<Texture>` and `Handle<Mesh>` are different types, so they cannot be
  mixed up.
- `get` returns `Option<&T>`: code that renders must decide what to do while
  an asset is still loading (skip it, or use a placeholder). It cannot forget.

A production version uses a thread pool (rayon, or the engine's job system)
instead of a thread per load, adds reference counting to unload unused assets,
and keeps generation numbers in handles. The
[bevy_asset](https://docs.rs/bevy_asset) crate is a full-featured example of
this design.

## Watching files

For hot reloading assets in development, the [notify](https://docs.rs/notify)
crate wraps the OS file-watching APIs (`ReadDirectoryChangesW`, FSEvents,
inotify):

```rust,ignore
use notify::{Event, RecursiveMode, Watcher};
use std::sync::mpsc;

let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
let mut watcher = notify::recommended_watcher(tx)?;
watcher.watch(std::path::Path::new("assets"), RecursiveMode::Recursive)?;

// Once per frame:
for event in rx.try_iter().flatten() {
    if event.kind.is_modify() {
        for path in event.paths {
            assets.reload_path(&path);    // re-run the loader, replace the slot
        }
    }
}
```

Because the rest of the engine holds handles, not references, replacing the
slot's contents is invisible to users: the next `get` returns the new data.
Editors save files in several steps (write a temp file, rename), so debounce:
collect changed paths for a few hundred milliseconds before reloading. The
`notify-debouncer-full` crate does this.

## Workspaces

An engine is several crates: the core, the renderer, the editor, tools, the
game. A **Cargo workspace** builds them together with one `Cargo.lock` and one
`target/` directory, like a top-level `CMakeLists.txt` with
`add_subdirectory` for each component:

```toml
# Cargo.toml at the repository root
[workspace]
resolver = "3"
members = ["crates/*", "game", "tools/asset-cooker"]

[workspace.package]
edition = "2024"
license = "MIT OR Apache-2.0"

[workspace.dependencies]          # one version of each dependency, chosen here
glam = { version = "0.30", features = ["bytemuck"] }
wgpu = "27"
serde = { version = "1", features = ["derive"] }

[workspace.lints.clippy]
undocumented_unsafe_blocks = "warn"

[profile.dev.package."*"]
opt-level = 2                     # optimize dependencies even in debug builds
```

```toml
# crates/renderer/Cargo.toml
[package]
name = "engine-renderer"
version = "0.1.0"
edition.workspace = true

[dependencies]
engine-core = { path = "../core" }
glam.workspace = true
wgpu.workspace = true

[lints]
workspace = true
```

The `[profile.dev.package."*"]` setting deserves attention: it compiles all
dependencies with optimizations while your own crates stay in fast-to-compile
debug mode. A debug build of a game that uses an unoptimized math library or
image decoder can be unplayably slow; this fixes it, at the cost of a longer
first build.

Splitting into crates also speeds up incremental builds: Rust compiles a crate
as a unit, so changing the game crate does not recompile the renderer. Keep
crates focused enough that a typical change touches one or two.

## Summary

| C++ | Rust |
|---|---|
| `add_custom_command` in CMake | `build.rs` writing to `OUT_DIR` |
| Dependency tracking for generated files | `cargo::rerun-if-changed` |
| `xxd -i`, `#embed` | `include_bytes!`, `include_str!` |
| Reflection macros / codegen for serialization | `#[derive(Serialize, Deserialize)]` |
| Custom JSON/XML parsers | serde + `serde_json`, `ron`, `toml`, `bincode` |
| mmap + cast for binary assets | `bytemuck`, `rkyv` |
| Asset manager with handles | Same design; `Send` bound checked at compile time |
| `ReadDirectoryChangesW` / inotify | `notify` |
| Top-level `CMakeLists.txt` + `add_subdirectory` | Cargo workspace |

## Exercises

1. Write a `build.rs` that sets `cargo::rustc-env=BUILD_TIME=...` (any string)
   and print it from `main` with `env!("BUILD_TIME")`. When does Cargo rerun
   the script?
2. Add a `reload(&mut self, h: Handle<T>)` method to `Assets` that starts
   loading the same path again but keeps serving the old value until the new
   one arrives. What must `Slot` look like now?
3. Give `Texture` an `Rc<String>` field and try to compile the asset example.
   Read the error. Which bound is violated, and why does the compiler care?
