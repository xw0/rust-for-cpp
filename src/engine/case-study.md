# Case study: a small renderer

This last chapter puts the book together in one program. It is a complete,
runnable miniature engine: math types, an asset store with typed handles, a
struct-of-arrays world with a system, a renderer behind a trait, and a fixed
timestep loop. To run anywhere (including the Playground) it renders with a
small software rasterizer into a grid of characters. The second half of the
chapter shows how to replace that back end with wgpu and a real window, and
what a full project layout looks like.

This chapter covers:

- the complete program, and which chapter each part comes from,
- design decisions: what owns what, and who borrows what when,
- replacing the back end with wgpu,
- the project layout of a real engine, and where to go next.

## The whole program

Press **Run**. Then change a `spin` rate or a `scale`, or add an entity, and
run it again.

```rust
use std::marker::PhantomData;
use std::ops::{Add, Mul, Sub};

// ---------- math (Math and SIMD) ----------
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Vec2 { x: f32, y: f32 }
impl Vec2 {
    const fn new(x: f32, y: f32) -> Self { Vec2 { x, y } }
    fn rotate(self, angle: f32) -> Self {
        let (s, c) = angle.sin_cos();
        Vec2::new(self.x * c - self.y * s, self.x * s + self.y * c)
    }
    fn cross(self, o: Vec2) -> f32 { self.x * o.y - self.y * o.x }
}
impl Add for Vec2 { type Output = Vec2; fn add(self, o: Vec2) -> Vec2 { Vec2::new(self.x + o.x, self.y + o.y) } }
impl Sub for Vec2 { type Output = Vec2; fn sub(self, o: Vec2) -> Vec2 { Vec2::new(self.x - o.x, self.y - o.y) } }
impl Mul<f32> for Vec2 { type Output = Vec2; fn mul(self, s: f32) -> Vec2 { Vec2::new(self.x * s, self.y * s) } }

// ---------- assets (Handles and arenas, Assets) ----------
struct Mesh { triangles: Vec<[Vec2; 3]> }

struct Handle<T> { index: u32, _t: PhantomData<fn() -> T> }
impl<T> Clone for Handle<T> { fn clone(&self) -> Self { *self } }
impl<T> Copy for Handle<T> {}

struct Assets<T> { items: Vec<T> }
impl<T> Assets<T> {
    fn new() -> Self { Assets { items: Vec::new() } }
    fn add(&mut self, item: T) -> Handle<T> {
        self.items.push(item);
        Handle { index: self.items.len() as u32 - 1, _t: PhantomData }
    }
    fn get(&self, h: Handle<T>) -> &T { &self.items[h.index as usize] }
}

// ---------- world (ECS) ----------
#[derive(Clone, Copy)]
struct Transform { position: Vec2, rotation: f32, scale: f32, }

#[derive(Default)]
struct World {
    transforms: Vec<Transform>,
    meshes: Vec<Option<Handle<Mesh>>>,
    spins: Vec<Option<f32>>,          // radians per second
    glyphs: Vec<char>,
}
impl World {
    fn spawn(&mut self, t: Transform, mesh: Option<Handle<Mesh>>, spin: Option<f32>, glyph: char) -> usize {
        self.transforms.push(t);
        self.meshes.push(mesh);
        self.spins.push(spin);
        self.glyphs.push(glyph);
        self.transforms.len() - 1
    }
}

// A system: borrows exactly the columns it needs.
fn spin_system(transforms: &mut [Transform], spins: &[Option<f32>], dt: f32) {
    for (t, spin) in transforms.iter_mut().zip(spins) {
        if let Some(rate) = spin {
            t.rotation += rate * dt;
        }
    }
}

// ---------- rendering (OpenGL / Vulkan / wgpu) ----------
trait Renderer {
    fn begin_frame(&mut self);
    fn draw(&mut self, mesh: &Mesh, transform: &Transform, glyph: char);
    fn end_frame(&mut self) -> String;
}

/// A software rasterizer into a character grid. A wgpu backend would
/// implement the same trait with buffers, a pipeline and a render pass.
struct AsciiRenderer { width: usize, height: usize, pixels: Vec<char> }

impl AsciiRenderer {
    fn new(width: usize, height: usize) -> Self {
        AsciiRenderer { width, height, pixels: vec![' '; width * height] }
    }
    fn to_screen(&self, p: Vec2) -> Vec2 {
        // World y in [-1, 1] spans the grid's height. A character cell is about twice
        // as tall as it is wide, so one world unit in x is twice as many columns.
        let half_h = self.height as f32 * 0.5;
        Vec2::new(self.width as f32 * 0.5 + p.x * half_h * 2.0, half_h - p.y * half_h)
    }
}

impl Renderer for AsciiRenderer {
    fn begin_frame(&mut self) {
        self.pixels.fill('.');
    }
    fn draw(&mut self, mesh: &Mesh, t: &Transform, glyph: char) {
        for tri in &mesh.triangles {
            let [a, b, c] = tri.map(|v| self.to_screen((v * t.scale).rotate(t.rotation) + t.position));
            let area = (b - a).cross(c - a);
            if area.abs() < f32::EPSILON { continue; }
            // Bounding box, clamped to the screen: the indexing below can never go out of range.
            let min_x = a.x.min(b.x).min(c.x).floor().max(0.0) as usize;
            let max_x = (a.x.max(b.x).max(c.x).ceil() as usize).min(self.width);
            let min_y = a.y.min(b.y).min(c.y).floor().max(0.0) as usize;
            let max_y = (a.y.max(b.y).max(c.y).ceil() as usize).min(self.height);
            for y in min_y..max_y {
                for x in min_x..max_x {
                    let p = Vec2::new(x as f32 + 0.5, y as f32 + 0.5);
                    // Edge functions, normalized by the triangle's winding.
                    let w0 = (c - b).cross(p - b) / area;
                    let w1 = (a - c).cross(p - c) / area;
                    let w2 = (b - a).cross(p - a) / area;
                    if w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0 {
                        self.pixels[y * self.width + x] = glyph;
                    }
                }
            }
        }
    }
    fn end_frame(&mut self) -> String {
        self.pixels.chunks(self.width).map(|row| row.iter().collect::<String>() + "\n").collect()
    }
}

fn render_world(world: &World, assets: &Assets<Mesh>, renderer: &mut dyn Renderer) -> String {
    renderer.begin_frame();
    for ((t, mesh), glyph) in world.transforms.iter().zip(&world.meshes).zip(&world.glyphs) {
        if let Some(handle) = mesh {
            renderer.draw(assets.get(*handle), t, *glyph);
        }
    }
    renderer.end_frame()
}

// ---------- the loop (Game loop) ----------
fn main() {
    let mut meshes = Assets::new();
    let quad = meshes.add(Mesh {
        triangles: vec![
            [Vec2::new(-1.0, -1.0), Vec2::new(1.0, -1.0), Vec2::new(1.0, 1.0)],
            [Vec2::new(-1.0, -1.0), Vec2::new(1.0, 1.0), Vec2::new(-1.0, 1.0)],
        ],
    });
    let tri = meshes.add(Mesh {
        triangles: vec![[Vec2::new(0.0, 1.0), Vec2::new(-0.87, -0.5), Vec2::new(0.87, -0.5)]],
    });

    let mut world = World::default();
    world.spawn(Transform { position: Vec2::new(-0.8, 0.0), rotation: 0.0, scale: 0.45 }, Some(quad), Some(1.0), '#');
    world.spawn(Transform { position: Vec2::new(0.8, -0.1), rotation: 0.0, scale: 0.7 }, Some(tri), Some(-0.5), '@');
    world.spawn(Transform { position: Vec2::new(0.0, 0.0), rotation: 0.0, scale: 1.0 }, None, None, '?'); // no mesh: not drawn

    let mut renderer = AsciiRenderer::new(64, 20);
    let step = 1.0 / 60.0;
    for _frame in 0..30 {                     // half a second of fixed steps
        spin_system(&mut world.transforms, &world.spins, step);
    }
    print!("{}", render_world(&world, &meshes, &mut renderer));
}
```

## Reading it as a map of the book

| Part of the program | Idea | Chapter |
|---|---|---|
| `Vec2` with `Add`, `Sub`, `Mul<f32>` | `Copy` value types, operator traits | [Operators](../foundations/operators-and-conversions.md), [Math](math-and-simd.md) |
| `Handle<T>` with `PhantomData<fn() -> T>` | Typed handles instead of pointers | [Handles and arenas](handles-and-arenas.md) |
| `Assets<T>` owns every `Mesh` | One owner per resource | [Ownership](../foundations/ownership.md), [Assets](assets-and-build.md) |
| `World` with one `Vec` per component | Struct of arrays, entities as indices | [ECS](ecs.md), [Memory and performance](../systems/memory-and-performance.md) |
| `spin_system(&mut [Transform], &[Option<f32>], dt)` | Split borrows; access visible in the signature | [Borrowing](../foundations/borrowing.md), [ECS](ecs.md) |
| `trait Renderer`, `&mut dyn Renderer` | Dynamic dispatch where it is cheap (once per draw) | [Traits and generics](../foundations/traits-and-generics.md) |
| `tri.map(...)`, `zip`, `chunks` | Iterators with no bounds checks in the hot loop | [Closures and iterators](../foundations/closures-and-iterators.md) |
| Clamped bounding box before indexing | Safe indexing that cannot panic | [Memory and performance](../systems/memory-and-performance.md) |
| `if let Some(handle) = mesh` | Absence is a type, not a null pointer | [Enums and match](../foundations/enums-and-match.md) |
| Fixed `step`, update before render | Fixed timestep | [Game loop](game-loop.md) |

The program has no `unsafe`, no `Rc`, no `RefCell` and no global state, and it
did not need them. Note also what it does not contain: no "manager" objects
holding pointers to each other. Data flows down from `main` by borrowing:

```text
main
 ├── owns  Assets<Mesh>  ── lends &Assets ──────────┐
 ├── owns  World          ── lends &mut columns ─► spin_system
 │                        └─ lends &World ─────────► render_world ──► renderer.draw(&Mesh, &Transform)
 └── owns  AsciiRenderer  ── lends &mut dyn Renderer ┘
```

Each frame, `spin_system` gets exclusive access to transforms; then
`render_world` gets shared access to the world and the assets and exclusive
access to the renderer. The borrow checker verifies that these phases do not
overlap. If you later run systems in parallel, the same signatures tell you
which ones can run together.

## Replacing the back end with wgpu

The `Renderer` trait is the seam between the engine and the GPU. A wgpu back
end implements the same three methods, using what the [wgpu chapter](wgpu.md)
introduced. The essential parts:

```rust,ignore
struct GpuMesh { vertices: wgpu::Buffer, count: u32 }

struct WgpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    pipeline: wgpu::RenderPipeline,
    instances: wgpu::Buffer,             // per-draw transforms, rewritten each frame
    gpu_meshes: Vec<GpuMesh>,            // indexed like Assets<Mesh>
    pending: Vec<(u32, Instance)>,       // draws collected between begin and end
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Instance { position: [f32; 2], rotation: f32, scale: f32, color: [f32; 4] }

impl WgpuRenderer {
    fn draw_frame(&mut self) -> Result<(), wgpu::SurfaceError> {
        let frame = self.surface.get_current_texture()?;
        let view = frame.texture.create_view(&Default::default());
        let instances: Vec<Instance> = self.pending.iter().map(|(_, i)| *i).collect();
        self.queue.write_buffer(&self.instances, 0, bytemuck::cast_slice(&instances));

        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                    depth_slice: None,
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_vertex_buffer(1, self.instances.slice(..));
            for (i, (mesh, _)) in self.pending.iter().enumerate() {
                let gpu = &self.gpu_meshes[*mesh as usize];
                pass.set_vertex_buffer(0, gpu.vertices.slice(..));
                pass.draw(0..gpu.count, i as u32..i as u32 + 1);
            }
        }
        self.queue.submit([encoder.finish()]);
        frame.present();
        self.pending.clear();
        Ok(())
    }
}
```

And the loop moves into winit's `ApplicationHandler` ([Game loop](game-loop.md)):
`RedrawRequested` runs the fixed-step systems for the elapsed time, calls
`render_world`, and requests the next redraw. Nothing in `World`, `Assets` or
the systems changes. That is the payoff of the ownership-first design: the
engine core is plain data and functions, and the platform layer is a thin
shell around it.

Some decisions you would make next, and where the book discusses them:

- **Generations in handles**, so meshes can be unloaded:
  [Handles and arenas](handles-and-arenas.md).
- **Despawning entities**: generational entity IDs, or move to hecs or
  bevy_ecs: [ECS](ecs.md).
- **Uploading meshes in the background**: the asset cache with a channel:
  [Assets](assets-and-build.md).
- **Hot-reloading shaders**: load WGSL from disk in debug builds and rebuild
  the pipeline: [wgpu](wgpu.md), [Hot reloading](hot-reload-and-plugins.md).
- **Instancing and batching**: sort `pending` by mesh and issue one draw per
  mesh with an instance range.
- **Parallel systems**: split borrows with `std::thread::scope`, or rayon's
  `par_iter_mut` on component columns: [Concurrency](../systems/concurrency.md).

## A real project layout

```text
my-engine/
├── Cargo.toml                 # [workspace], shared dependencies and lints
├── crates/
│   ├── core/                  # math re-exports, handles, time, logging setup
│   ├── ecs/                   # or depend on hecs / bevy_ecs instead
│   ├── assets/                # loaders, cache, file watching
│   ├── render/                # Renderer trait + wgpu back end, shaders/
│   │   ├── build.rs           # compile or validate shaders
│   │   └── shaders/*.wgsl
│   └── platform/              # winit app, input mapping
├── game/                      # the actual game: systems and content, binary crate
├── tools/
│   └── asset-cooker/          # offline processing: textures, meshes
├── assets/                    # source data (RON, glTF, KTX2)
└── .github/workflows/ci.yml   # fmt, clippy, test
```

Each crate depends only on the ones below it. The renderer does not know about
the game; the game knows the renderer only through `core` types and the
`Renderer` API. Cargo enforces the dependency direction: a cycle between
crates does not build.

## Where to go from here

- Read the source of a real engine. [Bevy](https://bevyengine.org) is large,
  modular and well documented; [Fyrox](https://fyrox.rs) is a more classic
  editor-centric engine; [macroquad](https://macroquad.rs) is a small,
  immediate-mode framework that is pleasant to read in an afternoon.
- Port a small piece of your own C++ code: a math library, an allocator, a
  file format parser. Run Clippy on the result and read every suggestion.
- When something fights the borrow checker, try restructuring the data before
  reaching for `Rc<RefCell<...>>` or `unsafe`. The book's
  [cheat sheet](../appendix/cheat-sheet.md) collects the usual translations.

## Exercises

1. Add a `Velocity` column and a `movement_system`, and make the triangle
   drift across the screen. Which existing function signatures change?
2. Add a second renderer, `CountingRenderer`, that only counts triangles and
   returns `"N triangles"` from `end_frame`. Render the same world with both,
   without changing `render_world`.
3. Make `render_world` generic (`renderer: &mut impl Renderer`) instead of
   taking `&mut dyn Renderer`. What changes in the compiled program, and does
   it matter here?
