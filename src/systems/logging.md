# Logging and diagnostics

Every C++ engine has its own logging: `UE_LOG`, a wrapper around spdlog or
glog, or a home-grown macro that writes to a file and the in-game console.
Third-party libraries each bring their own logging too, and wiring them all
into one output is a chore. Rust settled this early. Libraries log through a
shared **facade**, and the application chooses, once, where the messages go.

This chapter covers:

- the facade and backend split, and why libraries never pick a backend,
- `log` with `env_logger`, and filtering with `RUST_LOG`,
- `tracing`: structured fields and spans, which also feed the profiler,
- engine needs: log files that do not stall a frame, an in-game console,
  logs in tests, compile-time filtering,
- panics: hooks, backtraces and crash reports.

## Facades and backends

The [`log`](https://docs.rs/log) crate defines macros (`error!`, `warn!`,
`info!`, `debug!`, `trace!`), a `Log` trait and one global slot for a logger.
It does not print anything. A **backend** crate implements the trait and is
installed by `main`. Until a backend is installed, log calls do nothing
beyond one check.

The whole mechanism fits in a page. This is a simplified `log`, written with
the standard library only:

```rust
use std::fmt::Arguments;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum Level { Error, Warn, Info, Debug }

/// The facade: one trait and one global slot.
pub trait Logger: Send + Sync {
    fn enabled(&self, level: Level, target: &str) -> bool;
    fn log(&self, level: Level, target: &str, args: Arguments);
}

static LOGGER: OnceLock<Box<dyn Logger>> = OnceLock::new();

pub fn emit(level: Level, target: &str, args: Arguments) {
    if let Some(logger) = LOGGER.get() {        // no backend yet: one check, nothing else
        if logger.enabled(level, target) {
            logger.log(level, target, args);    // arguments are formatted only here
        }
    }
}

macro_rules! info {
    ($($arg:tt)*) => { $crate::emit($crate::Level::Info, module_path!(), format_args!($($arg)*)) };
}
macro_rules! debug {
    ($($arg:tt)*) => { $crate::emit($crate::Level::Debug, module_path!(), format_args!($($arg)*)) };
}

// A "library" module: it only uses the macros.
mod render {
    pub fn draw(meshes: usize) {
        debug!("drawing {meshes} meshes");
        info!("frame done");
    }
}

// The application chooses the backend, once.
struct Stderr { max: Level }
impl Logger for Stderr {
    fn enabled(&self, level: Level, _target: &str) -> bool { level <= self.max }
    fn log(&self, level: Level, target: &str, args: Arguments) {
        eprintln!("[{level:?} {target}] {args}");
    }
}

fn main() {
    render::draw(3);                            // before init: nothing happens
    LOGGER.set(Box::new(Stderr { max: Level::Info })).ok();
    render::draw(3);                            // info is printed, debug is filtered out
}
```

`format_args!` captures the arguments without formatting them, so a filtered
message costs a comparison, not a string allocation. `module_path!()` gives
every message a **target** such as `my_game::render`, which is what filters
match on.

The rule that follows from this design: **libraries depend only on the
facade, and only binaries choose a backend.** A renderer crate calls
`log::debug!`; the game, the editor and the test harness each decide where
those messages go. In C++ terms, every library logs through the same
interface, and the application supplies the sink.

## `log` and `env_logger`

```toml
[dependencies]
log = "0.4"
env_logger = "0.11"
```

```rust,ignore
mod render {
    pub fn draw(meshes: usize) {
        log::debug!("drawing {meshes} meshes");
        if meshes > 10_000 {
            log::warn!("{meshes} draw calls this frame");
        }
    }
}

fn main() {
    env_logger::init();                         // reads RUST_LOG
    log::info!("starting");
    render::draw(20_000);
}
```

```text
$ RUST_LOG=info cargo run
[2026-11-23T15:40:02Z INFO  game] starting
[2026-11-23T15:40:02Z WARN  game::render] 20000 draw calls this frame

$ RUST_LOG=warn,game::render=debug cargo run
[2026-11-23T15:40:05Z DEBUG game::render] drawing 20000 meshes
[2026-11-23T15:40:05Z WARN  game::render] 20000 draw calls this frame
```

`RUST_LOG` is a list of `target=level` rules, plus an optional default
level. Because targets are module paths, you can turn on `debug` for one
subsystem, or silence a chatty dependency (`wgpu_core=warn`), without
recompiling. Most crates that log, including wgpu, winit and many others, use
`log`, so their messages appear in the same output.

## `tracing`: structured fields and spans

[`tracing`](https://docs.rs/tracing) is the other common facade, and the
better fit for a game. It has the same level macros, plus two things `log`
lacks:

- **Structured fields.** `info!(entity = id, hp, "took damage")` records
  `entity` and `hp` as typed key-value pairs, not just text. A backend can
  print them, filter on them or send them to a log database.
- **Spans.** A span is a named period of time with fields, such as one frame,
  one system or one asset load. Every event inside a span is reported with the
  span's context, and a profiler backend can show spans on a timeline.

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

```rust,ignore
use tracing::{debug, info, info_span, instrument, warn};

struct Enemy { id: u32, hp: i32 }

#[instrument(skip(enemies), fields(count = enemies.len()))]   // a span per call, with fields
fn update_ai(enemies: &mut [Enemy]) {
    for e in enemies.iter_mut().filter(|e| e.hp > 0) {
        e.hp -= 7;
        if e.hp <= 0 {
            info!(entity = e.id, "enemy died");
        } else {
            debug!(entity = e.id, hp = e.hp, "took damage");
        }
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()) // RUST_LOG
        .init();

    let mut enemies = vec![Enemy { id: 1, hp: 5 }, Enemy { id: 2, hp: 30 }];
    for frame in 0..2u64 {
        let _frame = info_span!("frame", n = frame).entered(); // ends when `_frame` is dropped
        update_ai(&mut enemies);
    }
    warn!(remaining = enemies.iter().filter(|e| e.hp > 0).count(), "level not cleared");
}
```

```text
$ RUST_LOG=debug cargo run
  INFO frame{n=0}:update_ai{count=2}: game: enemy died entity=1
 DEBUG frame{n=0}:update_ai{count=2}: game: took damage entity=2 hp=23
 DEBUG frame{n=1}:update_ai{count=2}: game: took damage entity=2 hp=16
  WARN game: level not cleared remaining=1
```

The output above omits timestamps. Each event carries the chain of spans it
happened in, so "took damage" is known to belong to frame 1 and to
`update_ai`, without passing a context object around. `#[instrument]` is an
attribute macro ([Declaring your own attributes](../intro/syntax.md#declaring-your-own-attributes))
that wraps the function in a span named after it.

The backend is called a **subscriber**, and it is built from **layers**: one
layer formats to the terminal, another writes a file, another sends spans to
a profiler. `tracing-subscriber` also captures messages from crates that use
`log`, so `wgpu` and `winit` output appears in the same stream.

The same spans feed the profiler. Add the `tracing-tracy` layer and every span
becomes a zone in [Tracy](https://github.com/wolfpld/tracy), the frame
profiler many C++ engines already use
([Memory layout and performance](memory-and-performance.md)). The `frame`
span above needs no extra code to appear on the timeline.

## Engine needs

### Log files that do not stall a frame

Writing to a file from the game thread can block on disk I/O.
`tracing-appender` moves the writing to a background thread and rotates the
file daily or hourly:

```toml
[dependencies]
tracing-appender = "0.2"
```

```rust,ignore
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn main() {
    let file = tracing_appender::rolling::daily("logs", "game.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file);
    // Keep `_guard` alive until exit: dropping it flushes the queue.

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())                                         // terminal
        .with(fmt::layer().with_ansi(false).with_writer(file_writer)) // file, no colors
        .init();

    tracing::info!("logging to the terminal and logs/game.log.<date>");
}
```

The `_guard` is RAII used deliberately: when `main` returns, the guard's
`Drop` flushes everything still in the queue. If you drop it early, by
writing `let _ = ...` instead of `let _guard = ...`, messages are lost. This
is the same mistake as discarding a C++ scope guard.

### An in-game console

A custom layer can forward events anywhere, for example into a buffer the
debug console draws each frame:

```rust,ignore
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

#[derive(Clone, Default)]
pub struct Console { lines: Arc<Mutex<Vec<String>>> }

impl<S: Subscriber> Layer<S> for Console {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut line = format!("{:>5} ", event.metadata().level());
        event.record(&mut LineVisitor(&mut line));       // collect the message and fields
        self.lines.lock().unwrap().push(line);
    }
}

struct LineVisitor<'a>(&'a mut String);
impl Visit for LineVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?} ");
        } else {
            let _ = write!(self.0, "{}={value:?} ", field.name());
        }
    }
}

fn main() {
    let console = Console::default();
    tracing_subscriber::registry().with(console.clone()).init();

    tracing::warn!(texture = "rock.png", "missing mip levels");
    for line in console.lines.lock().unwrap().iter() {
        println!("console: {line}");                      // the UI would draw these
    }
}
```

A real console would keep a bounded ring buffer and filter by level, but the
structure is the same: the game code logs as usual, and the console is one
more layer.

### Logs in tests

Test output is captured per test and shown only when a test fails. To see log
messages there, install a subscriber that writes to the test harness:

```rust,ignore
#[test]
fn loads_level() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init(); // `try_`: tests share one process
    // ...
}
```

### Removing log calls from release builds

Both facades can drop verbose levels at compile time, so `trace!` in a hot
loop costs nothing in a shipped build:

```toml
[dependencies]
log = { version = "0.4", features = ["release_max_level_info"] }
tracing = { version = "0.1", features = ["release_max_level_info"] }
```

With these features, `debug!` and `trace!` compile to nothing in release
builds, like a `UE_LOG` with a compiled-out verbosity. The arguments are not
evaluated either, so do not put side effects in log arguments.

## Panics and crash reports

A panic in Rust unwinds the thread by default, running destructors, and
prints a message to stderr. In a game you want that message, a backtrace and
the last log lines in one place. `std::panic::set_hook` replaces the default
printer:

```rust
use std::backtrace::Backtrace;
use std::panic;

fn main() {
    panic::set_hook(Box::new(|info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
        let message = info.payload_as_str().unwrap_or("(no message)");
        // In a game: tracing::error!(...), flush the log file, write a crash report.
        eprintln!("CRASH at {}: {message}", location.unwrap_or_default());
        let backtrace = Backtrace::force_capture().to_string();
        eprintln!("{} backtrace lines", backtrace.lines().count());
    }));

    // catch_unwind only so that this example keeps running after the panic.
    let result = panic::catch_unwind(|| {
        let levels: Vec<&str> = Vec::new();
        levels[3]                                     // index out of bounds: panics
    });
    println!("recovered: {}", result.is_err());
}
```

| Need | Rust |
|---|---|
| Backtrace on panic | `RUST_BACKTRACE=1`, or `Backtrace::force_capture()` in the hook |
| Crash in a log file | A panic hook that calls `tracing::error!` and flushes the writer |
| Abort instead of unwinding (smaller binary, like `-fno-exceptions`) | `panic = "abort"` in a `[profile]` |
| Minidumps and crash reporting for native crashes | Crates such as `sentry`, or a minidump writer, as in C++ |

A panic hook runs for panics only. A segmentation fault in `unsafe` code or a
C library is a native crash, and it needs the same crash-handler setup as a
C++ program.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

A setup that works well for games: `tracing` throughout the engine, with
spans for the frame, each system and each asset load; a subscriber in the
game binary with a terminal layer in development, a non-blocking file layer
always, a console layer for the in-game console, and the Tracy layer behind a
Cargo feature; `release_max_level_info` in shipped builds; and a panic hook
that logs the panic and flushes the file before the process exits. Library
crates in the workspace depend on `tracing` only.

</div>

## Summary

| C++ | Rust |
|---|---|
| `UE_LOG`, spdlog, glog, custom macros | `log` or `tracing` macros |
| Each library's own logging callback | One facade; the application installs the backend |
| Log categories | Targets (module paths), filtered with `RUST_LOG` |
| Scoped profiler markers | `tracing` spans, shown in Tracy with `tracing-tracy` |
| Async log sink | `tracing-appender::non_blocking` |
| Compiled-out verbosity | `release_max_level_*` features |
| `std::set_terminate`, signal handlers | `std::panic::set_hook` for panics; a crash handler for native crashes |

## Exercises

1. In the facade example, add a `warn!` macro and a backend that only prints
   messages whose target ends with `::render`.
2. Add `tracing` to a small program, put a span around each frame of a loop,
   and run it with `RUST_LOG=trace` and then `RUST_LOG=warn`.
3. Write logs to both the terminal and a daily file. Remove the `_guard`
   binding and check what is lost at exit.
4. Install a panic hook that writes the panic message and backtrace to a
   file, then trigger a panic from a worker thread. Does the hook run?
