# OpenGL from Rust

OpenGL is a C API built on a hidden global: the current context, plus a large
state machine of bindings. That makes it the least Rust-shaped graphics API,
and therefore a good place to see how Rust code wraps a C API it cannot change.
If you have written GL against GLFW and a loader such as glad, everything here
will look familiar; the new parts are where ownership and `Drop` replace manual
`glDelete*` calls.

This chapter covers:

- getting a window and a context with winit and glutin,
- loading GL functions with the `gl` and `glow` crates,
- buffers, shaders and uploads with `bytemuck`,
- wrapping GL object names in types with `Drop`,
- what the borrow checker can and cannot do for a state machine.

## The crates

| Job | C/C++ | Rust |
|---|---|---|
| Window and events | GLFW, SDL | [winit](https://docs.rs/winit) (or the `sdl2`/`glfw` bindings) |
| Context creation | GLFW, SDL, WGL/GLX/EGL | [glutin](https://docs.rs/glutin) (with `glutin-winit`) |
| Function loader | glad, GLEW | [gl](https://docs.rs/gl) (generated, C-style) or [glow](https://docs.rs/glow) (thin wrapper, also runs on WebGL) |
| Casting structs to bytes | `reinterpret_cast`, `memcpy` | [bytemuck](https://docs.rs/bytemuck) |

The **`gl`** crate is a generated binding with exactly the C names: you call
`gl::GenBuffers(1, &mut id)` inside `unsafe`, and porting C++ code is mostly
mechanical. **`glow`** ("GL on whatever") wraps the same calls in slightly more
Rust-like signatures (returning the new object, taking slices instead of
pointer + length) and runs on desktop GL, GLES and WebGL2 in the browser. Both
leave every call `unsafe`, because the driver can do anything with a bad
argument. This chapter uses glow.

## Window, context and loader

Creating a context is the most boilerplate-heavy part, as it is in C++ without
GLFW. With winit 0.30 and glutin 0.32, the outline is:

```rust,ignore
use glutin::prelude::*;
use glutin_winit::DisplayBuilder;
use winit::event_loop::EventLoop;

let event_loop = EventLoop::new()?;
let window_attrs = winit::window::Window::default_attributes().with_title("GL");
let template = glutin::config::ConfigTemplateBuilder::new().with_alpha_size(8);

// Pick a framebuffer config and create the window together (needed on some platforms).
let (window, gl_config) = DisplayBuilder::new()
    .with_window_attributes(Some(window_attrs))
    .build(&event_loop, template, |mut configs| configs.next().unwrap())?;
let window = window.unwrap();
let display = gl_config.display();

let context_attrs = glutin::context::ContextAttributesBuilder::new()
    .with_context_api(glutin::context::ContextApi::OpenGl(Some(glutin::context::Version::new(4, 1))))
    .build(Some(window_handle(&window)));
let surface_attrs = window.build_surface_attributes(Default::default())?;
let surface = unsafe { display.create_window_surface(&gl_config, &surface_attrs)? };
let context = unsafe { display.create_context(&gl_config, &context_attrs)? }
    .make_current(&surface)?;

// The loader: the equivalent of gladLoadGLLoader(glfwGetProcAddress).
let gl = unsafe {
    glow::Context::from_loader_function_cstr(|name| display.get_proc_address(name))
};
```

The glutin repository has a complete, maintained example; copy it rather than
writing this from memory. The [game loop](game-loop.md) chapter covers the
winit event loop that drives rendering.

Notice the types: `make_current` consumes a `NotCurrentContext` and returns a
`PossiblyCurrentContext`. The "is this context current?" state that GL keeps
globally is partly moved into the type system, so you cannot make a context
current twice by accident.

## A triangle

With a `glow::Context` in hand, the GL calls are the ones you know:

```rust,ignore
use glow::HasContext;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex { pos: [f32; 2], color: [f32; 3] }

const VERTICES: [Vertex; 3] = [
    Vertex { pos: [-0.5, -0.5], color: [1.0, 0.0, 0.0] },
    Vertex { pos: [ 0.5, -0.5], color: [0.0, 1.0, 0.0] },
    Vertex { pos: [ 0.0,  0.5], color: [0.0, 0.0, 1.0] },
];

unsafe {
    let vao = gl.create_vertex_array()?;          // Result<NativeVertexArray, String>
    gl.bind_vertex_array(Some(vao));

    let vbo = gl.create_buffer()?;
    gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
    gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytemuck::cast_slice(&VERTICES), glow::STATIC_DRAW);

    let stride = std::mem::size_of::<Vertex>() as i32;
    gl.enable_vertex_attrib_array(0);
    gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, stride, std::mem::offset_of!(Vertex, pos) as i32);
    gl.enable_vertex_attrib_array(1);
    gl.vertex_attrib_pointer_f32(1, 3, glow::FLOAT, false, stride, std::mem::offset_of!(Vertex, color) as i32);

    let program = link_program(&gl, VERTEX_SRC, FRAGMENT_SRC)?;

    // Each frame:
    gl.clear_color(0.1, 0.1, 0.12, 1.0);
    gl.clear(glow::COLOR_BUFFER_BIT);
    gl.use_program(Some(program));
    gl.draw_arrays(glow::TRIANGLES, 0, 3);
}
surface.swap_buffers(&context)?;
```

Compared with C++:

- `bytemuck::cast_slice(&VERTICES)` replaces `sizeof(vertices), vertices`. The
  byte length comes from the slice, so the size argument cannot be wrong, and
  `Pod` guarantees the struct has no padding.
- `offset_of!(Vertex, pos)` replaces `(void*)offsetof(Vertex, pos)`.
- Object names are typed (`NativeBuffer`, `NativeProgram`), not bare `GLuint`,
  so passing a buffer where a texture is expected does not compile.
- `Some(vbo)` / `None` replaces "0 means unbind".

Shader compilation returns the info log as a `String` in the error case:

```rust,ignore
unsafe fn compile(gl: &glow::Context, kind: u32, src: &str) -> Result<glow::NativeShader, String> {
    unsafe {
        let shader = gl.create_shader(kind)?;
        gl.shader_source(shader, src);
        gl.compile_shader(shader);
        if gl.get_shader_compile_status(shader) {
            Ok(shader)
        } else {
            let log = gl.get_shader_info_log(shader);
            gl.delete_shader(shader);
            Err(log)
        }
    }
}
```

With `?`, a shader error propagates up to whoever can report it, and the
`delete_shader` on the error path is hard to forget because the function has
exactly two exits. But it is still manual. The next section makes cleanup
automatic.

## Owning GL objects with `Drop`

A GL object name is a resource like a file handle: it must be deleted exactly
once, and not used afterwards. That is the definition of an owned type with a
`Drop` impl. The one complication is that deleting needs the context, so the
wrapper keeps a reference-counted handle to it.

The example below uses a small fake `Gl` that prints the calls it receives, so
it runs on the Playground. With glow, the bodies would be
`unsafe { self.gl.delete_buffer(self.id) }` and so on.

```rust
use std::cell::Cell;
use std::marker::PhantomData;
use std::rc::Rc;

// Stand-in for glow::Context: hands out names and logs calls.
#[derive(Default)]
pub struct Gl { next: Cell<u32> }
impl Gl {
    fn gen_buffer(&self) -> u32 { self.next.set(self.next.get() + 1); println!("glGenBuffers -> {}", self.next.get()); self.next.get() }
    fn buffer_data(&self, id: u32, size: usize) { println!("glBufferData({id}, {size} bytes)"); }
    fn delete_buffer(&self, id: u32) { println!("glDeleteBuffers({id})"); }
}

/// A GPU buffer holding elements of type T. Deleted when dropped.
pub struct Buffer<T> {
    gl: Rc<Gl>,          // keeps the context alive; also makes Buffer !Send
    id: u32,
    len: usize,
    _marker: PhantomData<T>,
}

impl<T: Copy> Buffer<T> {
    pub fn new(gl: &Rc<Gl>, data: &[T]) -> Self {
        let id = gl.gen_buffer();
        // With glow and bytemuck: gl.buffer_data_u8_slice(target, bytemuck::cast_slice(data), usage),
        // with the bound T: Pod. The fake only needs the byte count.
        gl.buffer_data(id, std::mem::size_of_val(data));
        Buffer { gl: gl.clone(), id, len: data.len(), _marker: PhantomData }
    }
    pub fn len(&self) -> usize { self.len }
}

impl<T> Drop for Buffer<T> {
    fn drop(&mut self) {
        self.gl.delete_buffer(self.id);
    }
}

struct Mesh {
    vertices: Buffer<[f32; 3]>,
    indices: Buffer<u16>,
}

fn main() {
    let gl = Rc::new(Gl::default());
    {
        let mesh = Mesh {
            vertices: Buffer::new(&gl, &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]),
            indices: Buffer::new(&gl, &[0, 1, 2]),
        };
        println!("drawing {} indices", mesh.indices.len());
        let _ = mesh.vertices.len();
    } // mesh dropped here: both buffers deleted, in field declaration order
    println!("end of scope");
}
```

This is RAII exactly as in a C++ wrapper class, with three differences that
remove the usual pitfalls:

- **No rule of five.** In C++ a `GlBuffer` class must delete its copy
  constructor and write a move constructor that zeroes the source, or a copy
  will double-delete. A Rust struct without `Clone` cannot be copied, and a
  move leaves nothing behind to drop. The wrapper above is complete.
- **Typed buffers.** `Buffer<u16>` and `Buffer<[f32; 3]>` are different types,
  so passing the vertex buffer where the index buffer is expected is a compile
  error, and `len()` counts elements, not bytes.
- **Thread affinity is checked.** A GL context is current on one thread. The
  `Rc` inside makes `Buffer` neither `Send` nor `Sync`, so the compiler rejects
  moving it to a worker thread. In C++, that bug shows up as a driver crash
  or a silent no-op.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Many engines do not delete GL objects from `Drop` directly, because a drop can
happen while the object is still referenced by queued draw calls, or from a
thread without the context. The common alternative is a deletion queue: `Drop`
pushes the name onto a list owned by the renderer, and the renderer deletes
everything in the list at a safe point in the frame. The ownership logic is
the same; only the timing changes. [Vulkan](vulkan.md) needs this from the
start.

</div>

## The bind-to-edit state machine

GL's global bindings are the part Rust can do least about. `glBindBuffer`
changes hidden state that later calls depend on, and nothing in the types
records it. The classic bug is a helper that binds something else between your
bind and your edit:

```rust
use std::cell::Cell;

// A fake GL that keeps the hidden binding, as a real driver does.
#[derive(Default)]
struct Gl { array_buffer: Cell<u32> }
impl Gl {
    fn bind_buffer(&self, id: u32) {
        self.array_buffer.set(id);
        println!("glBindBuffer(GL_ARRAY_BUFFER, {id})");
    }
    fn buffer_data(&self, bytes: usize) {
        println!("glBufferData: {bytes} bytes go to buffer {}", self.array_buffer.get());
    }
    fn named_buffer_data(&self, id: u32, bytes: usize) {
        println!("glNamedBufferData({id}): {bytes} bytes go to buffer {id}");
    }
}

fn draw_debug_lines(gl: &Gl) {
    gl.bind_buffer(2);                 // binds its own buffer and leaves it bound
}

fn main() {
    let gl = Gl::default();
    let mesh_vbo = 1;

    // Bind-to-edit: correct only if nothing binds in between.
    gl.bind_buffer(mesh_vbo);
    draw_debug_lines(&gl);
    gl.buffer_data(64);                // goes to buffer 2, not the mesh

    // DSA: the object is an argument, so there is no hidden state to clobber.
    gl.named_buffer_data(mesh_vbo, 64);
}
```

This compiles in Rust exactly as it does in C++: `&Gl` is a shared reference
and the binding lives behind a `Cell`, just as it lives inside the driver.
Options, from least to most structure:

1. **Use DSA (direct state access, GL 4.5).** `glNamedBufferData(id, ...)`
   takes the object directly, and most of the hidden state disappears. glow
   exposes these as `named_buffer_data_u8_slice` and friends. If you can
   require GL 4.5, do this.
2. **Re-bind before every use.** Simple, and the driver ignores redundant
   binds cheaply on most implementations.
3. **Guards.** A method `buffer.bind(&mut gl_state) -> BoundBuffer<'_>` that
   borrows a state object mutably. Only one buffer can be bound at a time
   because only one `&mut` borrow of the state can exist. This encodes the
   state machine in lifetimes, but it is usually more ceremony than it is
   worth for GL.

### Re-binding with a state cache

Option 2 makes every operation self-contained: each method binds what it
needs, so it does not matter what ran before. Engines usually put a small cache
in front of the bind calls to skip the redundant ones:

```rust
use std::cell::Cell;

#[derive(Default)]
struct Gl { calls: Cell<u32> }
impl Gl {
    fn bind_buffer(&self, id: u32) { self.calls.set(self.calls.get() + 1); println!("  glBindBuffer({id})"); }
    fn buffer_data(&self, bytes: usize) { println!("  glBufferData({bytes} bytes)"); }
}

/// Owns the context and remembers what is bound.
struct GlState { gl: Gl, array_buffer: u32 }
impl GlState {
    fn bind_array_buffer(&mut self, id: u32) {
        if self.array_buffer != id {   // skip the call if it is already bound
            self.gl.bind_buffer(id);
            self.array_buffer = id;
        }
    }
}

struct Buffer { id: u32 }
impl Buffer {
    fn upload(&self, st: &mut GlState, data: &[f32]) {
        st.bind_array_buffer(self.id); // never assume the current binding
        st.gl.buffer_data(std::mem::size_of_val(data));
    }
}

fn main() {
    let mut st = GlState { gl: Gl::default(), array_buffer: 0 };
    let (a, b) = (Buffer { id: 1 }, Buffer { id: 2 });
    println!("upload a"); a.upload(&mut st, &[0.0; 16]);
    println!("upload a"); a.upload(&mut st, &[0.0; 16]); // no bind: already bound
    println!("upload b"); b.upload(&mut st, &[0.0; 4]);
    println!("{} bind calls", st.gl.calls.get());
}
```

The cache is only correct if every GL call goes through `GlState`. Middleware
that calls GL directly (an ImGui backend, a video decoder) changes the real
binding behind the cache's back, so reset the cache after calling into it.

### Guards that borrow the state

Option 3 moves the edit functions onto a guard type. You can only get a
`BoundBuffer` by binding, and the guard holds the only `&mut GlState`, so a
second bind while the first guard is alive is a borrow error:

```rust
use std::cell::Cell;

#[derive(Default)]
struct Gl { array_buffer: Cell<u32> }
impl Gl {
    fn bind_buffer(&self, id: u32) { self.array_buffer.set(id); println!("glBindBuffer({id})"); }
    fn buffer_data(&self, bytes: usize) { println!("glBufferData -> buffer {}, {bytes} bytes", self.array_buffer.get()); }
}

pub struct GlState { gl: Gl }
pub struct Buffer { id: u32 }

/// Proof that `id` is the bound GL_ARRAY_BUFFER. Edits are only available here.
pub struct BoundBuffer<'a> { st: &'a mut GlState, id: u32 }

impl Buffer {
    pub fn bind<'a>(&self, st: &'a mut GlState) -> BoundBuffer<'a> {
        st.gl.bind_buffer(self.id);
        BoundBuffer { st, id: self.id }
    }
}

impl BoundBuffer<'_> {
    pub fn data(&mut self, bytes: usize) {
        debug_assert_eq!(self.st.gl.array_buffer.get(), self.id);
        self.st.gl.buffer_data(bytes);
    }
}

fn main() {
    let mut st = GlState { gl: Gl::default() };
    let (mesh, lines) = (Buffer { id: 1 }, Buffer { id: 2 });

    let mut m = mesh.bind(&mut st);
    m.data(64);
    // let mut l = lines.bind(&mut st); // error[E0499]: cannot borrow `st` as
    // m.data(16);                      // mutable more than once at a time

    let mut l = lines.bind(&mut st);    // fine: `m` is no longer used
    l.data(16);
}
```

The bug from the first example cannot be written: `draw_debug_lines` would
need `&mut GlState` to bind, and it cannot get one while `m` is alive. The
cost shows up quickly in real code. GL has a binding point per target, per
texture unit and per vertex array, the element buffer binding is stored inside
the bound VAO, and a draw needs several things bound at once, so the guards
multiply and their lifetimes appear in every helper's signature.

In practice, wrap object lifetime (which `Drop` handles completely) and keep
the binding calls explicit, with DSA where you can require GL 4.5 and a state
cache otherwise. Lifetime bugs are the expensive ones.

## Debugging

Your tools still work: RenderDoc, Nsight and apitrace capture GL calls from a
Rust program the same way. Enable `KHR_debug` output with
`gl.debug_message_callback(...)` and route messages into your logger
(`log`/`tracing`), as you would with `glDebugMessageCallback`.

## Summary

| C++ | Rust |
|---|---|
| GLFW / SDL window | winit |
| GLFW / WGL / GLX / EGL context | glutin |
| glad / GLEW | `gl` (C names) or `glow` (typed, also WebGL) |
| `GLuint` names | `glow::NativeBuffer`, `NativeTexture`, ... |
| `sizeof(v), v.data()` | `bytemuck::cast_slice(&v)` |
| `offsetof` | `std::mem::offset_of!` |
| RAII wrapper with deleted copy and hand-written move | Struct + `Drop`; no `Clone` means no copies |
| "Only call from the GL thread" comment | `Rc` inside: `!Send`, enforced by the compiler |

## Exercises

1. Add a `Texture` wrapper to the fake-`Gl` example, and a `Material` that
   owns a `Texture` and a `Buffer<f32>`. Predict the deletion order when a
   `Material` is dropped, then run it.
2. Try to send a `Buffer` to another thread with `std::thread::spawn`. Read
   the error and find where it mentions `Rc`.
3. Change `Drop for Buffer` to push the name into a `RefCell<Vec<u32>>`
   deletion queue in `Gl`, and add a `Gl::collect_garbage` that deletes them.
   Call it at the "end of the frame".
