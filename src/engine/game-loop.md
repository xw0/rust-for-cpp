# The game loop, windowing and global state

A C++ game's `main` usually looks like this: create a window with SDL or GLFW,
then `while (!quit) { poll events; update; render; }`, with the engine's
subsystems reachable through singletons. Rust changes two of those pieces. The
standard windowing crate, winit, owns the loop and calls you, rather than you
calling it. And singletons are mostly replaced by passing context explicitly,
because mutable global state is exactly what the borrow checker is designed to
control.

This chapter covers:

- winit's event loop and the `ApplicationHandler` trait,
- creating windows: attributes, DPI, fullscreen and multiple windows,
- how winit handles each platform, and how a window reaches the graphics API,
- a fixed timestep with interpolation,
- frame pacing and vsync,
- where global state goes when there are no singletons.

## winit: the loop calls you

winit is the Rust equivalent of the windowing half of GLFW or SDL: windows,
input, DPI, and the platform event loop, on Windows, macOS, Linux (X11 and
Wayland), Android, iOS and the web. Since version 0.30, you implement a trait
and hand it to the event loop:

```rust,ignore
use std::sync::Arc;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

#[derive(Default)]
struct App {
    window: Option<Arc<Window>>,
    game: Option<Game>,          // renderer + world, created once we have a window
}

impl ApplicationHandler for App {
    // Called when the app may create windows (at startup; again after suspend on mobile).
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(event_loop.create_window(Window::default_attributes()).unwrap());
        self.game = Some(Game::new(window.clone()));
        self.window = Some(window);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(game) = &mut self.game else { return };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => game.resize(size.width, size.height),
            WindowEvent::KeyboardInput { event, .. } => game.input.key(event),
            WindowEvent::RedrawRequested => {
                game.frame();                                   // update + render
                self.window.as_ref().unwrap().request_redraw(); // ask for the next one
            }
            _ => {}
        }
    }
}

fn main() -> Result<(), winit::error::EventLoopError> {
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);   // run continuously, like a game
    event_loop.run_app(&mut App::default())
}
```

Why the inversion? Some platforms (macOS, iOS, the web) do not let a program
own the main loop: the OS calls the application. winit adopts that model
everywhere, so the same code runs on all of them. In practice it changes
little: `RedrawRequested` is your "frame" callback, and calling
`request_redraw()` at the end of each frame keeps it running.

All state lives in the `App` struct. There are no globals; the event loop owns
`App`, and each callback gets `&mut self`. That is the start of the answer to
"where does global state go", which this chapter returns to below.

If you prefer the C++ shape, the `sdl3` and `glfw` crates are bindings to the
libraries you know, with a classic `poll_events()` loop.

## Creating windows

`ActiveEventLoop::create_window` is the only way to create a window in winit,
and an `ActiveEventLoop` exists only inside a callback. That is deliberate: on
Android, iOS and the web, a window cannot exist until the platform has started
the application, so winit makes it impossible to create one too early. Create
your windows in `resumed`, which every platform calls once the app is ready.

`Window::default_attributes()` returns a builder with the same options you
would pass to `SDL_CreateWindow` or set with GLFW window hints. An editor with
two windows, DPI handling and a fullscreen toggle:

```rust,ignore
use std::collections::HashMap;
use std::sync::Arc;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Fullscreen, Window, WindowId};

#[derive(Default)]
struct Editor {
    windows: HashMap<WindowId, Arc<Window>>,   // one entry per OS window
}

impl ApplicationHandler for Editor {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if !self.windows.is_empty() {
            return;                                // `resumed` runs again after a suspend on mobile
        }
        let main = Window::default_attributes()
            .with_title("Level editor")
            .with_inner_size(LogicalSize::new(1280.0, 720.0))   // logical units: scaled by DPI
            .with_min_inner_size(LogicalSize::new(640.0, 360.0));
        let inspector = Window::default_attributes()
            .with_title("Inspector")
            .with_inner_size(LogicalSize::new(360.0, 720.0));
        for attributes in [main, inspector] {
            let window = Arc::new(event_loop.create_window(attributes).unwrap());
            self.windows.insert(window.id(), window);
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(window) = self.windows.get(&id) else { return };
        match event {
            WindowEvent::CloseRequested => {
                self.windows.remove(&id);          // dropping the last Arc closes the window
                if self.windows.is_empty() {
                    event_loop.exit();
                }
            }
            WindowEvent::Resized(PhysicalSize { width, height }) => {
                // Resize this window's swapchain. Sizes in events are physical pixels.
                println!("{id:?}: {width}x{height} px, scale {}", window.scale_factor());
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                println!("{id:?} moved to a monitor with scale {scale_factor}");
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state.is_pressed() && event.logical_key == Key::Named(NamedKey::F11) =>
            {
                // Toggle borderless fullscreen on the window's current monitor.
                let fullscreen = window.fullscreen().is_none().then_some(Fullscreen::Borderless(None));
                window.set_fullscreen(fullscreen);
            }
            WindowEvent::RedrawRequested => { /* render this window */ }
            _ => {}
        }
    }
}

fn main() -> Result<(), winit::error::EventLoopError> {
    EventLoop::new()?.run_app(&mut Editor::default())
}

```

A few things in this example differ from what you may expect in C++:

- **Logical and physical sizes.** `LogicalSize` is in DPI-independent units,
  and winit multiplies it by the monitor's scale factor (1.0, 1.5, 2.0, ...).
  Sizes in events, such as `Resized`, are in **physical pixels**, which is
  what your swapchain needs. When a window moves to a monitor with a different
  scale, you get `ScaleFactorChanged` followed by a `Resized`. This is the
  same model as SDL3's pixel density, made explicit in the types.
- **Every event names its window.** `window_event` receives a `WindowId`, so
  multiple windows are a `HashMap` away. A renderer usually keeps one surface
  (swapchain) per window in the same map.
- **Closing is dropping.** There is no `DestroyWindow` call: a window closes
  when the last `Arc<Window>` is dropped, like any other RAII resource.
- **Fullscreen is a value.** `Fullscreen::Borderless(None)` uses the current
  monitor; `Fullscreen::Exclusive(video_mode)` switches the display mode,
  where the platform supports it. `event_loop.available_monitors()` lists the
  monitors and their video modes.

## How winit handles platforms

winit has one public API and a backend per platform, selected at compile time:

| Platform | winit talks to | Notes |
|---|---|---|
| Windows | Win32 (`CreateWindowExW`, a message loop) | The `Window` wraps an `HWND` |
| macOS | AppKit (`NSApplication`, `NSWindow`) | Must run on the main thread; the OS owns the loop |
| Linux | Wayland or X11, chosen at run time | Both are loaded dynamically, so one binary supports both |
| Android | `NativeActivity` or `GameActivity` | The surface is destroyed on `suspended` and must be recreated |
| iOS | UIKit | Like macOS, the OS owns the loop |
| Web | A `<canvas>` element and browser events | Built for `wasm32`; there is no blocking at all |

When you need something only one platform has, winit provides **extension
traits** in `winit::platform::<os>`, used behind `#[cfg]` so the code still
compiles everywhere:

```rust,ignore
let mut attributes = Window::default_attributes().with_title("Game");

#[cfg(target_os = "windows")]
{
    use winit::platform::windows::WindowAttributesExtWindows;
    attributes = attributes.with_drag_and_drop(false); // needed if a library uses multithreaded COM
}
#[cfg(target_os = "macos")]
{
    use winit::platform::macos::WindowAttributesExtMacOS;
    attributes = attributes.with_titlebar_transparent(true).with_fullsize_content_view(true);
}
#[cfg(target_os = "linux")]
{
    use winit::platform::wayland::WindowAttributesExtWayland;
    attributes = attributes.with_name("my-game", "my-game"); // app id for icons and grouping
}
```

### From a window to the graphics API

winit knows nothing about OpenGL, Vulkan or wgpu, and the graphics crates know
nothing about winit. They meet through the small
[`raw-window-handle`](https://docs.rs/raw-window-handle) crate, which defines
an enum of native handles (`HWND`, `NSView`, Wayland and X11 surfaces, Android
`ANativeWindow`, a web canvas). winit implements its `HasWindowHandle` and
`HasDisplayHandle` traits, and graphics crates accept anything that does:

```rust,ignore
fn print_handle(window: &Window) {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().unwrap().as_raw() {
        RawWindowHandle::Win32(h) => println!("HWND {:?}", h.hwnd),
        RawWindowHandle::AppKit(h) => println!("NSView {:?}", h.ns_view),
        RawWindowHandle::Wayland(h) => println!("wl_surface {:?}", h.surface),
        RawWindowHandle::Xlib(h) => println!("X11 window {}", h.window),
        other => println!("{other:?}"),
    }
}
```

That is why `wgpu::Instance::create_surface(window.clone())` takes the winit
window directly, `ash-window` creates a Vulkan surface from the same handles,
and glutin creates a GL context for it. The same bridge lets SDL3 or GLFW
windows drive wgpu, so the choice of windowing crate does not lock you into a
renderer ([Portable graphics with wgpu](wgpu.md), [Vulkan with ash](vulkan.md)).

### Choosing a windowing crate

| Crate | Use it when |
|---|---|
| [winit](https://docs.rs/winit) | The default: pure Rust, used by wgpu, Bevy, egui and most of the ecosystem |
| [sdl3](https://docs.rs/sdl3) | You want SDL's whole package (windows, input, gamepads, audio, file dialogs) or already ship SDL in C++ |
| [glfw](https://docs.rs/glfw) | You are porting a GLFW-based tool and want the same API |
| [`windows`](https://docs.rs/windows), [`objc2`](https://docs.rs/objc2) | You need complete control of one platform's windowing, as with raw Win32 in C++ |

## Fixed timestep

Physics and gameplay usually update at a fixed rate, decoupled from the
display. The accumulator pattern ("Fix your timestep!") translates directly:

```rust
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default)]
struct State { pos: f32, vel: f32 }

fn integrate(s: State, dt: f32) -> State {
    let acc = -9.81;
    State { vel: s.vel + acc * dt, pos: s.pos + s.vel * dt }
}

fn lerp(a: State, b: State, t: f32) -> State {
    State { pos: a.pos + (b.pos - a.pos) * t, vel: a.vel + (b.vel - a.vel) * t }
}

struct Clock {
    step: Duration,
    accumulator: Duration,
    max_frame: Duration,       // clamp, so a long stall does not cause a spiral of death
}

impl Clock {
    /// Returns how many fixed steps to run this frame, and the interpolation factor.
    fn advance(&mut self, frame_time: Duration) -> (u32, f32) {
        self.accumulator += frame_time.min(self.max_frame);
        let mut steps = 0;
        while self.accumulator >= self.step {
            self.accumulator -= self.step;
            steps += 1;
        }
        (steps, self.accumulator.as_secs_f32() / self.step.as_secs_f32())
    }
}

fn main() {
    let mut clock = Clock {
        step: Duration::from_secs_f64(1.0 / 60.0),
        accumulator: Duration::ZERO,
        max_frame: Duration::from_millis(250),
    };
    let (mut previous, mut current) = (State { pos: 10.0, vel: 0.0 }, State { pos: 10.0, vel: 0.0 });

    // Simulated frame times: a 144 Hz display with one 40 ms hitch.
    let frames = [6.9, 6.9, 6.9, 40.0, 6.9, 6.9];
    for ms in frames {
        let (steps, alpha) = clock.advance(Duration::from_secs_f64(ms / 1000.0));
        for _ in 0..steps {
            previous = current;
            current = integrate(current, clock.step.as_secs_f32());
        }
        let shown = lerp(previous, current, alpha);
        println!("frame {ms:>4} ms: {steps} steps, alpha {alpha:.2}, render pos {:.4}", shown.pos);
    }
}
```

In a real loop, `frame_time` comes from `std::time::Instant`:

```rust,ignore
let now = Instant::now();
let frame_time = now - self.last_frame;   // Instant - Instant = Duration
self.last_frame = now;
```

`Instant` is monotonic (`QueryPerformanceCounter`, `clock_gettime(CLOCK_MONOTONIC)`)
and `Duration` is an exact integer number of nanoseconds, so there is no
accumulated floating-point drift in the accumulator. Convert to `f32` seconds
only at the point of use.

## Frame pacing

- **Vsync** is a surface setting, not a loop setting: `PresentMode::Fifo` in
  wgpu, `VK_PRESENT_MODE_FIFO_KHR` in Vulkan, the swap interval in glutin.
  Presenting blocks until a vsync slot is available, which paces the loop.
- **Without vsync**, `ControlFlow::WaitUntil(next_frame_instant)` tells winit
  to sleep until the next frame is due, rather than spinning at 100% CPU.
- **For tools and editors** that only need to redraw on input, use
  `ControlFlow::Wait` and call `request_redraw()` only when something changes.
  The event loop then sleeps, like a normal desktop application.
- `std::thread::sleep` has the usual OS granularity (about 1 ms on Linux and
  macOS; on Windows, Rust requests high-resolution timers where available).
  For precise frame caps, sleep until slightly before the deadline, then spin.

## Where global state goes

C++ engines are full of singletons: `Renderer::Get()`, `g_Input`,
`AssetManager::Instance()`. Rust makes mutable globals deliberately awkward:
a `static mut` can only be accessed in `unsafe` code, and taking a reference
to one is rejected by default in the 2024 edition, because two `&mut` to the same global from
different call sites (or threads) is undefined behavior. The idiomatic options,
in order of preference:

### 1. Pass a context

Most "global" state is really per-game state that you can own in one struct
and pass down:

```rust
struct Input { jump_pressed: bool }
struct Audio { queued: Vec<&'static str> }
struct Time { dt: f32, frame: u64 }

struct Ctx<'a> {
    input: &'a Input,
    audio: &'a mut Audio,
    time: &'a Time,
}

struct Player { y: f32, vy: f32 }

impl Player {
    fn update(&mut self, ctx: &mut Ctx) {
        if ctx.input.jump_pressed && self.y == 0.0 {
            self.vy = 5.0;
            ctx.audio.queued.push("jump.wav");
        }
        self.vy -= 9.81 * ctx.time.dt;
        self.y = (self.y + self.vy * ctx.time.dt).max(0.0);
    }
}

fn main() {
    let input = Input { jump_pressed: true };
    let mut audio = Audio { queued: vec![] };
    let time = Time { dt: 1.0 / 60.0, frame: 1 };
    let mut player = Player { y: 0.0, vy: 0.0 };

    let mut ctx = Ctx { input: &input, audio: &mut audio, time: &time };
    player.update(&mut ctx);
    println!("frame {}: y = {:.3}, sounds = {:?}", time.frame, player.y, audio.queued);
}
```

Every dependency is visible in the signature: `Player::update` reads input and
time and writes audio. The compiler checks that nothing else holds `&mut Audio`
during the call, and tests can construct a `Ctx` with fake input. This is the
same idea as ECS resources (`Res<Time>`, `ResMut<Audio>` in bevy_ecs; see
[ECS](ecs.md)), which are a context struct managed by the scheduler.

### 2. Immutable globals, initialized once

Configuration, lookup tables and other values that never change after startup
can be globals safely, because shared read-only access cannot race:

```rust
use std::sync::OnceLock;
use std::collections::HashMap;

static CONFIG: OnceLock<HashMap<&'static str, f32>> = OnceLock::new();

fn config() -> &'static HashMap<&'static str, f32> {
    CONFIG.get_or_init(|| {
        println!("loading config (once)");
        HashMap::from([("gravity", 9.81), ("fov", 70.0)])
    })
}

// Fully compile-time tables need no initialization at all:
static GAMMA_LUT: [u8; 4] = [0, 21, 99, 255];

fn main() {
    println!("{} {}", config()["gravity"], config()["fov"]);
    println!("{:?}", GAMMA_LUT);
}
```

`OnceLock` is the thread-safe "initialize on first use" of a C++ function-local
`static`, and `LazyLock` is the same with the initializer stored in the static
itself: `static TABLE: LazyLock<Vec<u32>> = LazyLock::new(build_table);`.

### 3. Mutable globals, synchronized

For the few things that really are process-wide and mutable (a logger, a
profiler, an allocation counter), wrap them in a synchronization type:

- **Atomics** for counters and flags: `static FRAMES: AtomicU64 = AtomicU64::new(0);`
- **`Mutex`/`RwLock`** for anything bigger: `static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());`
  (`Mutex::new` is `const`, so no lazy initialization is needed).
- **`thread_local!`** for per-thread state, such as a per-thread scratch
  allocator: `thread_local! { static SCRATCH: RefCell<Vec<u8>> = RefCell::new(Vec::new()); }`

The `log` and `tracing` crates are built this way: a global logger set once at
startup, called from anywhere with `log::info!(...)`
([Logging and diagnostics](../systems/logging.md)).

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

Do not reach for `static mut` to port a singleton. If a piece of state is
mutated from many places, the Rust answer is to make those places receive it as
a parameter. This is often a large refactor in a C++ codebase, but in a new
Rust codebase it is the default and costs nothing, and it makes the data flow
visible, which is what you need when you later parallelize.

</div>

## Input handling

winit delivers input as events. Games usually convert them into a per-frame
state snapshot that update code reads:

```rust
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Key { W, A, S, D, Space }

#[derive(Default)]
struct Input {
    down: HashSet<Key>,
    pressed_this_frame: HashSet<Key>,
}

impl Input {
    fn on_key(&mut self, key: Key, is_down: bool) {
        if is_down {
            if self.down.insert(key) {          // insert returns false if already held
                self.pressed_this_frame.insert(key);
            }
        } else {
            self.down.remove(&key);
        }
    }
    fn end_frame(&mut self) { self.pressed_this_frame.clear(); }
    fn axis(&self, neg: Key, pos: Key) -> f32 {
        (self.down.contains(&pos) as i32 - self.down.contains(&neg) as i32) as f32
    }
}

fn main() {
    let mut input = Input::default();
    input.on_key(Key::D, true);
    input.on_key(Key::Space, true);
    input.on_key(Key::Space, true);             // OS key repeat: not a new press
    println!("x = {}, jump = {}", input.axis(Key::A, Key::D), input.pressed_this_frame.contains(&Key::Space));
    input.end_frame();
    println!("next frame jump = {}", input.pressed_this_frame.contains(&Key::Space));
    let _ = (Key::W, Key::S);
}
```

In winit, keys arrive as `KeyEvent { physical_key, logical_key, state, repeat, .. }`.
Use `physical_key` (a `KeyCode` like `KeyCode::KeyW`, by position) for WASD
movement so it works on AZERTY keyboards, and `logical_key` for text and
shortcuts. For gamepads, use the [gilrs](https://docs.rs/gilrs) crate.

## Summary

| C++ | Rust |
|---|---|
| SDL / GLFW window and loop | winit `EventLoop` + `ApplicationHandler` (or `sdl3`/`glfw` crates) |
| `SDL_CreateWindow`, GLFW window hints | `event_loop.create_window(Window::default_attributes()...)` in `resumed` |
| `HWND`, `NSView` passed to the renderer | `raw-window-handle`, accepted by wgpu, ash-window and glutin |
| `while (!quit) { ... }` | `RedrawRequested` + `request_redraw()`, `ControlFlow::Poll` |
| `std::chrono::steady_clock` | `std::time::Instant`, `Duration` |
| Singleton `Get()` | Context passed as a parameter; ECS resources |
| Function-local `static` | `OnceLock`, `LazyLock` |
| Global mutable variable | Atomic, `Mutex`, or `thread_local!`; `static mut` only with `unsafe` |
| `glfwSwapInterval(1)` | `PresentMode::Fifo` (wgpu), swap interval (glutin) |

## Exercises

1. Change the simulated frame times in the fixed-timestep example to a 30 Hz
   display (`33.3` ms). How many steps run per frame? What happens to `alpha`?
2. Add a `ctx.time.frame`-based cooldown to `Player::update` so the player can
   only jump every 30 frames. Which struct holds the "last jump frame"?
3. Write a global frame counter with `AtomicU64`, increment it from two
   threads with `std::thread::scope`, and print the total. Then try the same
   with `static mut COUNTER: u64` and read the compiler's error or warning.
