# The game loop, windows and global state

A C++ game's `main` usually looks like this: create a window with SDL or GLFW,
then `while (!quit) { poll events; update; render; }`, with the engine's
subsystems reachable through singletons. Rust changes two of those pieces. The
standard windowing crate, winit, owns the loop and calls you, rather than you
calling it. And singletons are mostly replaced by passing context explicitly,
because mutable global state is exactly what the borrow checker is designed to
control.

This chapter covers:

- winit's event loop and the `ApplicationHandler` trait,
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

If you prefer the C++ shape, the `sdl2` and `glfw` crates are bindings to the
libraries you know, with a classic `poll_events()` loop.

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
startup, called from anywhere with `log::info!(...)`.

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
| SDL / GLFW window and loop | winit `EventLoop` + `ApplicationHandler` (or `sdl2`/`glfw` crates) |
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
