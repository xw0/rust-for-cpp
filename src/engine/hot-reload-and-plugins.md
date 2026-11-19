# Hot reloading and plugins

C++ engines reload game code by building it as a DLL, unloading the old one
and loading the new one while the process keeps running (Handmade Hero, Live++,
Unreal's Live Coding). Plugins work the same way, with a C or C++ interface
that both sides agree on. Rust can do all of this, but there is one fact to
understand first: **Rust has no stable ABI**. This chapter explains what that
means, then shows the practical ways to reload code, load plugins and embed a
scripting language.

This chapter covers:

- what "no stable ABI" means, and the C ABI escape hatch,
- loading dynamic libraries with `libloading`,
- hot reloading game code, and keeping state across reloads,
- the hot-reload tools available today,
- scripting with Lua, Rhai and WebAssembly.

## No stable ABI

The layout of a default Rust struct, the calling convention of a Rust
function, the layout of `Vec`, `String` and trait objects, and the mangling of
symbol names can all change between compiler versions, and even between two
builds with different flags. Rust makes no promise, and in practice field
reordering means it really does change. C++ is in a similar position in
theory (the ABI belongs to the compiler, not the standard) but in practice
compilers keep it stable for years.

The consequences:

- A Rust dynamic library and the program that loads it must be built **by the
  same compiler, with the same flags, from the same dependency versions** if
  they exchange Rust types. For hot reloading during development, that holds
  automatically: you are rebuilding the same workspace.
- For **plugins built separately** (by users, by other teams, months later),
  the interface must use the C ABI: `extern "C"` functions and `#[repr(C)]`
  types, exactly as in the [FFI chapter](../systems/ffi.md). Crates such as
  [abi_stable](https://docs.rs/abi_stable) and
  [stabby](https://docs.rs/stabby) generate stable-ABI versions of `Vec`,
  `String`, trait objects and more, so a plugin interface does not have to be
  written in raw C types.

Rust has two library crate types for this:

| `crate-type` | Produces | Use for |
|---|---|---|
| `cdylib` | `.dll` / `.so` / `.dylib` exporting a C ABI, with the Rust standard library linked in | Plugins, and libraries called from C, C++, Python |
| `dylib` | A Rust dynamic library for other Rust code | Rarely used directly; tooling for faster linking |

## Loading a library

The [libloading](https://docs.rs/libloading) crate wraps `LoadLibrary` /
`dlopen` and `GetProcAddress` / `dlsym`. A minimal plugin:

```toml
# plugin/Cargo.toml
[lib]
crate-type = ["cdylib"]
```

```rust,ignore
// plugin/src/lib.rs
#[repr(C)]
pub struct PluginInfo {
    pub api_version: u32,
    pub name: *const std::ffi::c_char,
}

#[unsafe(no_mangle)]
pub extern "C" fn plugin_info() -> PluginInfo {
    PluginInfo { api_version: 1, name: c"sky-renderer".as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn plugin_update(dt: f32) {
    // ...
}
```

`#[unsafe(no_mangle)]` keeps the symbol name as written (`extern "C"` alone
does not); the `unsafe(...)` wrapper, new in the 2024 edition, marks that two
libraries exporting the same name is your responsibility. The host:

```rust,ignore
use libloading::{Library, Symbol};

type InfoFn = unsafe extern "C" fn() -> PluginInfo;
type UpdateFn = unsafe extern "C" fn(f32);

// SAFETY: loading a library runs its initializers; we trust plugins/ to contain our plugins.
let lib = unsafe { Library::new("plugins/libsky.so")? };
let info: Symbol<InfoFn> = unsafe { lib.get(b"plugin_info")? };
let info = unsafe { info() };
if info.api_version != 1 {
    return Err("incompatible plugin".into());
}
let update: Symbol<UpdateFn> = unsafe { lib.get(b"plugin_update")? };
unsafe { update(0.016) };
```

Two lifetime details make this safer than the C++ equivalent:

- `Symbol<'lib, T>` borrows the `Library`. You cannot unload the library
  (`drop(lib)`) while a `Symbol` from it is still alive: that is a compile
  error, not a crash in code that no longer exists.
- But a plain function pointer copied out of a symbol, or a `&'static str`
  pointing into the library's data, escapes that check. Before unloading,
  make sure nothing from the library is still referenced: no function
  pointers, no trait objects whose vtables live in it, no threads running its
  code, no `'static` data from it.

## Hot reloading game code

The classic setup splits the program into a small host that owns the window,
the memory and the main loop, and a game library that contains the logic. On
each frame, the host checks whether the library changed and reloads it. The
key design rule is the same as in C++: **the state lives in the host; the
library only contains functions.** Then reloading swaps the code and keeps the
world.

The runnable example below simulates this with function pointers instead of a
real library, but the structure is the one you would use:

```rust
// Shared between host and game library: #[repr(C)] so both builds agree on it.
#[repr(C)]
#[derive(Debug, Default)]
pub struct GameState {
    pub frame: u64,
    pub player_x: f32,
    pub score: u32,
}

// The game library's interface: plain C-ABI function pointers.
#[repr(C)]
pub struct GameApi {
    pub update: extern "C" fn(state: &mut GameState, dt: f32),
}

// --- Version 1 of the game library ---
extern "C" fn update_v1(state: &mut GameState, dt: f32) {
    state.frame += 1;
    state.player_x += 1.0 * dt * 60.0;
}

// --- Version 2, after you edit and rebuild: the player is faster and scores ---
extern "C" fn update_v2(state: &mut GameState, dt: f32) {
    state.frame += 1;
    state.player_x += 3.0 * dt * 60.0;
    state.score += 10;
}

fn main() {
    let mut state = GameState::default();           // owned by the host: survives reloads
    let mut api = GameApi { update: update_v1 };    // in reality: loaded from game.dll

    for frame in 0..6 {
        if frame == 3 {
            println!("-- library changed on disk: reloading --");
            api = GameApi { update: update_v2 };    // unload old library, load new one
        }
        (api.update)(&mut state, 1.0 / 60.0);
        println!("{state:?}");
    }
}
```

With a real library, the reload step is:

1. Copy `game.dll` to a temporary name and load the copy, so the compiler can
   overwrite the original while it is loaded (Windows locks loaded DLLs).
2. Look up the `GameApi` (one exported function returning the table).
3. Drop the old `Library` after the new one is loaded.

Things that break across a reload, and how to avoid them:

- **Changing the layout of `GameState`.** The new code would interpret the old
  bytes differently. Either restart when the state struct changes, or
  serialize the state with serde before unloading and deserialize after, which
  also lets you add fields.
- **Heap data allocated by the old library.** With Rust's default global
  allocator, every `cdylib` uses the system allocator, so a `Vec` allocated in
  the library and freed in the host works in practice. But a `Vec`'s *layout*
  is not guaranteed to match across builds; prefer to keep heap-owning types
  in the host, or use the same compiler for both, which is the normal case in
  development.
- **Statics and thread-locals** in the library are reset on reload. Keep state
  in `GameState`.
- **Trait objects and closures** whose code lives in the library dangle after
  unloading. Do not store them in the host.

## Hot-reload tools

You rarely need to write the loader by hand:

| Tool | How it works |
|---|---|
| [hot-lib-reloader](https://docs.rs/hot-lib-reloader) | Generates the libloading code from an attribute on a module: you mark functions as hot-reloadable, and calls go through the latest library. Uses Rust ABI, so same compiler on both sides. |
| [subsecond](https://docs.rs/subsecond) (from the Dioxus project) | Patches individual functions in a running binary, like Live++, without splitting into a library. Wrap the frame call in `subsecond::call(...)`; changed functions are swapped in. Requires its CLI (`dx`) to drive the build. |
| Bevy's hot reloading | Assets and shaders reload out of the box; code hot patching is built on subsecond. |

For assets and shaders, which change much more often than code, reload data
instead ([Assets](assets-and-build.md)). It needs no unsafe code and works on
every platform.

## Scripting

Many engines put gameplay logic in a scripting language, for fast iteration and
for modders. The usual choices all have good Rust embeddings:

| Language | Crate | Notes |
|---|---|---|
| Lua / LuaJIT / Luau | [mlua](https://docs.rs/mlua) | Mature; safe API; Rust structs exposed as userdata; async support |
| Rhai | [rhai](https://docs.rs/rhai) | Pure-Rust scripting language with Rust-like syntax; easy to embed and sandbox |
| WebAssembly | [wasmtime](https://docs.rs/wasmtime), [wasmer](https://docs.rs/wasmer) | Sandboxed, fast, any source language (Rust, C, C++, AssemblyScript); good for untrusted mods |
| JavaScript | `rquickjs`, `boa` | For UI or tooling scripts |

A taste of mlua, exposing an engine function to Lua:

```rust,ignore
use mlua::Lua;

let lua = Lua::new();
let spawn = lua.create_function(|_, (kind, x, y): (String, f32, f32)| {
    println!("spawn {kind} at ({x}, {y})");
    Ok(())
})?;
lua.globals().set("spawn", spawn)?;

lua.load(r#"
    for i = 1, 3 do
        spawn("crate", i * 2.0, 0.0)
    end
"#).exec()?;
```

Argument conversion is generated from the Rust types (`(String, f32, f32)`),
and a wrong type in the script becomes a Lua error, not a crash. Compared with
writing Lua bindings in C++ by hand (or with sol2), there is less glue and the
borrow checker prevents a script callback from holding a Rust reference beyond
its call.

WebAssembly is worth a closer look for mods: each mod runs in a sandbox with
its own memory, can only call the functions you give it, and can be compiled
from Rust with the same toolchain as the engine. Fuel metering in wasmtime lets
you cap how many instructions a script runs per frame.

## Summary

| C++ | Rust |
|---|---|
| ABI de facto stable per compiler | No stable Rust ABI; `extern "C"` + `#[repr(C)]` for plugins |
| `extern "C" __declspec(dllexport)` | `#[unsafe(no_mangle)] pub extern "C" fn` in a `cdylib` |
| `LoadLibrary` / `dlopen` | `libloading::Library::new` |
| `GetProcAddress` / `dlsym` | `lib.get::<fn type>(b"name")`, borrows the library |
| Handmade-style DLL reload | Host owns state; library exposes a function table |
| Live++ | subsecond |
| sol2 / LuaBridge | mlua |
| Custom VM / mod sandbox | wasmtime |

## Exercises

1. Add a `render` function pointer to `GameApi` that prints the player
   position, and a version 3 that renders differently. Reload twice.
2. Add a field to `GameState` in version 2 only. Why would that be a problem
   with a real library? Sketch how you would carry the state across with
   serde.
3. Build a real `cdylib` with one `extern "C" fn add(a: i32, b: i32) -> i32`,
   load it with libloading from a separate binary, and call it. Then try to
   `drop(lib)` while you still hold the `Symbol`. What does the compiler say?
