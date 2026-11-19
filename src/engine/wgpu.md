# wgpu: a safe, portable GPU API

[wgpu](https://wgpu.rs) is a Rust implementation of the WebGPU API. On the
desktop it runs on Vulkan, Metal, D3D12 or OpenGL; in the browser it runs on
WebGPU (or WebGL2). It is the graphics layer under Bevy, the Firefox WebGPU
implementation, and many Rust renderers and tools. For a C++ programmer, think
of it as a Vulkan-flavored version of bgfx, sokol_gfx or Dawn, with an API
designed in Rust so that misuse that is undefined behavior in Vulkan becomes a
compile error or a reported validation error.

This chapter covers:

- the WebGPU object model, compared with Vulkan,
- the steps from window to triangle,
- how wgpu uses ownership and borrowing to make GPU lifetimes safe,
- uniforms, bind groups and `bytemuck`,
- WGSL shaders, naga and SPIR-V,
- running the same code on the web.

The wgpu API changes between major versions (roughly every few months).
The code here shows the shape of the API; check the
[examples](https://github.com/gfx-rs/wgpu/tree/trunk/examples) for the version
you use.

## The object model

If you know Vulkan, WebGPU is Vulkan with the hard parts handled for you:

| Vulkan | wgpu | Difference |
|---|---|---|
| `VkInstance` | `Instance` | |
| `VkPhysicalDevice` | `Adapter` | |
| `VkDevice` + `VkQueue` | `Device` + `Queue` | One queue |
| `VkSurfaceKHR` + swapchain | `Surface` + `surface.configure()` | No swapchain images to manage |
| `VkBuffer` + `VkDeviceMemory` | `Buffer` | Memory allocated for you |
| `VkImage` + `VkImageView` | `Texture` + `TextureView` | |
| Descriptor set layout / set | `BindGroupLayout` / `BindGroup` | |
| `VkPipeline` | `RenderPipeline`, `ComputePipeline` | |
| Command pool + buffer | `CommandEncoder` → `CommandBuffer` | |
| Render pass begin/end | `RenderPass` value, ends when dropped | |
| Barriers, layouts | None: tracked automatically | |
| Fences for resource lifetime | None: tracked automatically | |

The last two rows are the big ones. wgpu tracks how each resource is used in
each pass and inserts barriers and layout transitions itself, and it keeps
every resource alive until the GPU has finished with it. Those are the two
largest sources of bugs in hand-written Vulkan, and they disappear. The cost is
some CPU overhead for the tracking, and less control over exactly when
barriers happen.

## From window to triangle

Setup, in outline (the window comes from winit; see [Game loop](game-loop.md)):

```rust,ignore
let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
let surface = instance.create_surface(window.clone())?;     // window: Arc<winit::window::Window>

let adapter = instance
    .request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(&surface),
        force_fallback_adapter: false,
    })
    .await?;
let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default()).await?;

let size = window.inner_size();
let config = surface
    .get_default_config(&adapter, size.width, size.height)
    .expect("surface not supported by adapter");
surface.configure(&device, &config);
```

The `request_*` functions are `async` because on the web they are JavaScript
promises. On the desktop, run them with `pollster::block_on(...)`, which
simply waits.

A pipeline, from a WGSL shader:

```rust,ignore
let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
    label: Some("triangle"),
    source: wgpu::ShaderSource::Wgsl(include_str!("triangle.wgsl").into()),
});

let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
    label: Some("triangle"),
    layout: None,                                   // derived from the shader
    vertex: wgpu::VertexState {
        module: &shader,
        entry_point: Some("vs_main"),
        buffers: &[],
        compilation_options: Default::default(),
    },
    fragment: Some(wgpu::FragmentState {
        module: &shader,
        entry_point: Some("fs_main"),
        targets: &[Some(config.format.into())],
        compilation_options: Default::default(),
    }),
    primitive: wgpu::PrimitiveState::default(),     // triangle list
    depth_stencil: None,
    multisample: wgpu::MultisampleState::default(),
    multiview: None,
    cache: None,
});
```

Descriptors are plain structs with public fields, filled in with struct
literal syntax and `..Default::default()` for the rest. They borrow what they
reference (`&shader`, `&[...]`), so, like ash's create-info structs, they cannot
outlive their contents.

Each frame:

```rust,ignore
let frame = surface.get_current_texture()?;
let view = frame.texture.create_view(&Default::default());
let mut encoder = device.create_command_encoder(&Default::default());
{
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("main"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &view,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.1, g: 0.1, b: 0.12, a: 1.0 }),
                store: wgpu::StoreOp::Store,
            },
            depth_slice: None,
        })],
        ..Default::default()
    });
    pass.set_pipeline(&pipeline);
    pass.draw(0..3, 0..1);                 // vertices 0..3, instances 0..1
}                                          // the pass ends here, when `pass` is dropped
queue.submit([encoder.finish()]);
frame.present();
```

And the shader, `triangle.wgsl`:

```wgsl
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) - 1) * 0.5;
    let y = f32(i32(i & 1u) * 2 - 1) * 0.5;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.5, 0.2, 1.0);
}
```

## Ownership in the API

The wgpu API uses Rust's rules to make several classes of GPU bug impossible
or detectable. Three examples.

**A render pass borrows its encoder.** `begin_render_pass` takes
`&mut CommandEncoder` and returns a `RenderPass<'_>` that keeps that mutable
borrow alive. While the pass exists, you cannot record anything else into the
encoder or finish it. "End the render pass before starting a copy" is enforced
by the borrow checker, and "end" is simply the end of the pass's scope. Here is
the same pattern in miniature:

```rust
struct CommandEncoder { commands: Vec<String> }
struct RenderPass<'enc> { encoder: &'enc mut CommandEncoder }

impl CommandEncoder {
    fn begin_render_pass(&mut self, name: &str) -> RenderPass<'_> {
        self.commands.push(format!("begin {name}"));
        RenderPass { encoder: self }
    }
    fn copy_buffer(&mut self) { self.commands.push("copy".into()); }
    fn finish(self) -> Vec<String> { self.commands }
}

impl RenderPass<'_> {
    fn draw(&mut self, n: u32) { self.encoder.commands.push(format!("draw {n}")); }
}

impl Drop for RenderPass<'_> {
    fn drop(&mut self) { self.encoder.commands.push("end".into()); }
}

fn main() {
    let mut encoder = CommandEncoder { commands: vec![] };
    {
        let mut pass = encoder.begin_render_pass("main");
        pass.draw(3);
        // encoder.copy_buffer();   // error: `encoder` is already borrowed by `pass`
    }
    encoder.copy_buffer();
    println!("{:?}", encoder.finish());
}
```

Uncomment the line and the compiler refuses: the encoder is mutably borrowed
by `pass`. In Vulkan, recording a copy inside a render pass is a
validation error at best and a GPU hang at worst. (Recent wgpu versions also
offer `pass.forget_lifetime()` for code that needs to store passes, and then
check this at run time instead.)

**Handles are reference counted.** `Buffer`, `Texture`, `BindGroup` and the
rest are cheap-to-clone handles to reference-counted objects. Dropping your
`Buffer` while a submitted command buffer still uses it is fine: wgpu keeps it
alive until that submission completes, then frees it. This is the deletion
queue from the [Vulkan chapter](vulkan.md), built in.

**`Device` and friends are `Send + Sync`.** You can create resources and
record command encoders on worker threads, then submit from one. The type
system says which objects can cross threads, so a parallel renderer needs no
"which thread owns the context?" documentation.

What wgpu does *not* catch at compile time (wrong buffer usage flags, bind
groups that do not match the pipeline layout, out-of-bounds draws) it catches
at run time with validation, as an error you can handle or a panic with a
readable message, never as undefined behavior. That is the guarantee: **safe
wgpu code cannot cause UB on the GPU**, even with wrong arguments.

## Uniforms and bind groups

Uniform data goes into a buffer, and a bind group connects buffers and
textures to a shader's `@group(n) @binding(m)` slots. The CPU-side struct must
match WGSL's layout rules, which you check with `bytemuck` and `const`
assertions (see [Math and SIMD](math-and-simd.md)):

```rust,ignore
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Camera {
    view_proj: [[f32; 4]; 4],   // mat4x4<f32>
    position: [f32; 3],         // vec3<f32>: 16-byte aligned in WGSL
    _pad: f32,
}
const _: () = assert!(std::mem::size_of::<Camera>() == 80);

use wgpu::util::DeviceExt;   // for create_buffer_init
let camera_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
    label: Some("camera"),
    contents: bytemuck::bytes_of(&camera),
    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
});

let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    label: Some("camera"),
    layout: &pipeline.get_bind_group_layout(0),
    entries: &[wgpu::BindGroupEntry { binding: 0, resource: camera_buffer.as_entire_binding() }],
});

// Each frame: update and bind.
queue.write_buffer(&camera_buffer, 0, bytemuck::bytes_of(&camera));
pass.set_bind_group(0, &bind_group, &[]);
```

```wgsl
struct Camera {
    view_proj: mat4x4<f32>,
    position: vec3<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;
```

`queue.write_buffer` is the easy path for small, frequent updates: wgpu copies
the data into a staging area and schedules the copy before the next
submission, so you do not manage staging buffers or worry about overwriting
data the GPU is reading.

## Shaders: WGSL, naga and SPIR-V

WGSL is WebGPU's shading language. It reads like a mix of Rust and HLSL, and
it is the native input. Other languages are supported through **naga**, the
shader translator inside wgpu (also usable on its own):

| Input | How |
|---|---|
| WGSL | `ShaderSource::Wgsl`, native |
| GLSL | `ShaderSource::Glsl` (feature `glsl`), through naga |
| SPIR-V | `ShaderSource::SpirV` (feature `spirv`), or `create_shader_module_passthrough` to skip translation on Vulkan |
| HLSL | Compile to SPIR-V with `dxc` first |

naga validates every shader when the module is created and reports errors with
the source span, so a typo is a clean error at load time with the line
underlined. The naga command-line tool (`cargo install naga-cli`) converts
between WGSL, SPIR-V, GLSL, HLSL and MSL, which is handy for inspecting what
your shader becomes on each back end.

For hot-reloading shaders during development, load the WGSL from disk instead
of `include_str!` and recreate the pipeline when the file changes ([Hot
reloading](hot-reload-and-plugins.md)). Use
`device.push_error_scope` / `pop_error_scope` around module creation to turn
validation errors into a `Result` instead of a panic, so a broken shader does
not end the session.

## Running on the web

The same wgpu code compiles to WebAssembly and runs in the browser:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli     # or use trunk, which wraps the whole flow
cargo build --target wasm32-unknown-unknown --release
```

Things that differ on the web:

- There is no blocking: `pollster::block_on` does not work. Spawn the async
  setup with `wasm_bindgen_futures::spawn_local`.
- The window is a `<canvas>`; winit's web backend handles it.
- Some features are not available in browsers (push constants, some texture
  formats, non-uniform indexing). `adapter.features()` and `adapter.limits()`
  tell you what you have, and code should check them as it would check Vulkan
  extensions.

## Summary

| C++ / Vulkan | wgpu |
|---|---|
| Vulkan, D3D12, Metal, GL back ends | One API, back end chosen at run time |
| Dawn (C++ WebGPU) | wgpu (Rust WebGPU) |
| Barriers and layout transitions | Automatic |
| Fences and deletion queues for resource lifetime | Automatic (reference counted handles) |
| Render pass begin/end | `RenderPass` borrows the encoder; ends on drop |
| Descriptor sets | Bind groups |
| GLSL/HLSL → SPIR-V | WGSL native; GLSL/SPIR-V through naga |
| Validation layers (optional) | Validation always on; errors, never UB |

## Exercises

1. In the miniature encoder example, uncomment `encoder.copy_buffer()` inside
   the pass and read the error. Then add a `ComputePass` type that also borrows
   the encoder, and check that you cannot have a render pass and a compute pass
   open at once.
2. Clone the wgpu repository and run the `hello_triangle` example
   (`cargo run --bin wgpu-examples hello_triangle`). Change the clear color,
   then change the shader to output a color from the vertex index.
3. Add a time uniform to the triangle: a `#[repr(C)]` struct with an `f32` and
   enough padding for WGSL's 16-byte uniform alignment, a buffer, a bind group,
   and a `queue.write_buffer` each frame. Write a `const` assertion for its
   size.
