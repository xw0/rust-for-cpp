# Enums and pattern matching

If you take one feature from Rust back to C++, it will be this one. A Rust
`enum` is a **tagged union**: a type that is exactly one of several variants,
each of which can carry its own data. You have written this by hand in C (a
`struct` with a `kind` field and a `union`), and C++17 gave you `std::variant`
and `std::visit`. Rust makes it a core language feature, and pairs it with
`match`, a `switch` that checks you handled every case.

This chapter covers:

- C-style enums and enums with data,
- `match` and exhaustiveness,
- `Option<T>`, the replacement for null,
- patterns everywhere: `if let`, `let else`, destructuring,
- how enums are laid out in memory, including the niche optimization,
- an example: a render command list.

## C-style enums

The simplest enums are what you know from C++ `enum class`: named constants
in their own namespace, with no implicit conversion to integers.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlendMode {
    Opaque,
    AlphaBlend,
    Additive,
}

#[derive(Debug, Clone, Copy)]
#[repr(u32)]             // pick the underlying integer, for FFI or serialization
enum PrimitiveTopology {
    Points = 0,
    Lines = 1,
    Triangles = 3,
}

fn main() {
    let mode = BlendMode::AlphaBlend;
    let topo = PrimitiveTopology::Triangles;
    println!("{mode:?} {}", topo as u32);   // enum -> integer with `as`
}
```

Converting the other way, from an integer to an enum, is not a cast in Rust
because most integers are not valid variants. Write a `TryFrom` implementation
or a `match`.

## Enums with data

Each variant can carry its own fields, like a struct or a tuple:

```rust
#[derive(Debug)]
enum Light {
    Directional { direction: [f32; 3] },
    Point { position: [f32; 3], radius: f32 },
    Spot { position: [f32; 3], direction: [f32; 3], angle: f32 },
    Ambient(f32),
}

fn shadow_cost(light: &Light) -> u32 {
    match light {
        Light::Directional { .. } => 4,                 // cascades
        Light::Point { radius, .. } if *radius > 10.0 => 6,
        Light::Point { .. } => 6,
        Light::Spot { angle, .. } => if *angle > 1.0 { 2 } else { 1 },
        Light::Ambient(_) => 0,
    }
}

fn main() {
    let lights = vec![
        Light::Directional { direction: [0.0, -1.0, 0.0] },
        Light::Point { position: [0.0; 3], radius: 5.0 },
        Light::Spot { position: [0.0; 3], direction: [0.0, 0.0, 1.0], angle: 0.6 },
        Light::Ambient(0.1),
    ];
    let total: u32 = lights.iter().map(shadow_cost).sum();
    println!("shadow passes: {total}");
}
```

A `Light` value is one of the four variants. You cannot read `radius` from a
`Directional` light, because the only way to get at the fields is to `match`
on the variant first. Compare with the C version:

```cpp
struct Light {
    enum Kind { Directional, Point, Spot, Ambient } kind;
    union {
        struct { float direction[3]; } directional;
        struct { float position[3]; float radius; } point;
        /* ... */
    };
};
// Nothing stops you reading light.point.radius when kind == Directional.
```

and with `std::variant`, which is safe but verbose: a separate struct per
alternative, `std::visit` with an overload set of lambdas, and error messages
that span pages.

## `match` is exhaustive

A `match` must cover every possible value. Delete the `Light::Ambient(_)` arm
above and run it: the compiler rejects the program and names the missing
variant. This is the feature that makes enums so useful in a large codebase.
When you add a variant, the compiler lists every `match` that needs updating.
C++ compilers can warn about missing `case` labels in a `switch` over an enum,
but only for plain enums, only as a warning, and never for `std::variant`.

`match` arms are tried top to bottom, and the first matching pattern wins.
There is no fall-through and no `break`. Patterns can:

| Pattern | Matches |
|---|---|
| `Light::Point { radius, .. }` | A variant, binding a field, ignoring the rest |
| `3` / `'a'` / `"text"` | A literal |
| `1..=9` | An inclusive range |
| `A \| B` | Either pattern |
| `x @ 1..=9` | A range, binding the value to `x` |
| `_` | Anything, without binding |
| `name` | Anything, binding it to `name` |
| `pat if condition` | A pattern plus a guard expression |
| `(a, b)`, `[first, .., last]`, `Vec3 { x, .. }` | Tuples, slices, structs |

`_` as the last arm accepts everything else. Use it sparingly with your own
enums, because it also silences the exhaustiveness check for variants you add
later.

## `Option<T>`: no more null

`Option` is an ordinary enum from the standard library:

```rust
enum Option<T> {
    None,
    Some(T),
}
# fn main() {}
```

It is how Rust says "a value or nothing". There is no null pointer in safe
Rust, so a function that might not find something returns `Option`, and the
caller cannot use the result without dealing with the `None` case:

```rust
struct Scene {
    names: Vec<String>,
}

impl Scene {
    fn find(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|n| n == name)
    }
}

fn main() {
    let scene = Scene { names: vec!["camera".into(), "sun".into()] };

    match scene.find("sun") {
        Some(i) => println!("sun is object {i}"),
        None => println!("no sun"),
    }

    // Shorthand forms you will use constantly:
    if let Some(i) = scene.find("camera") {
        println!("camera is object {i}");
    }
    let player = scene.find("player").unwrap_or(0);        // default value
    let count = scene.find("sun").map(|i| i + 1);           // transform if present
    let must = scene.find("camera").expect("scene needs a camera"); // panic if None
    println!("{player} {count:?} {must}");
}
```

`unwrap()` and `expect()` panic on `None`. They are fine in prototypes, tests
and cases that are truly impossible, and should otherwise be rare. The
[error-handling chapter](errors.md) covers `Result`, the sibling of `Option`
for operations that fail with an error.

## Patterns beyond `match`

```rust
#[derive(Debug, Clone, Copy)]
struct Vec2 {
    x: f32,
    y: f32,
}

fn parse_size(s: &str) -> Option<(u32, u32)> {
    // let-else: bind or bail out. The else branch must diverge (return, break, panic).
    let Some((w, h)) = s.split_once('x') else {
        return None;
    };
    Some((w.parse().ok()?, h.parse().ok()?))
}

fn main() {
    let Vec2 { x, y } = Vec2 { x: 1.0, y: 2.0 };   // destructure a struct
    let (w, h) = parse_size("1920x1080").unwrap();  // destructure a tuple
    println!("{x} {y} {w} {h}");

    let samples = [3, 9, 4, 1];
    if let [first, .., last] = samples {             // slice patterns
        println!("first {first}, last {last}");
    }

    let mut stack = vec![1, 2, 3];
    while let Some(top) = stack.pop() {              // loop until None
        print!("{top} ");
    }
    println!();

    for (i, name) in ["albedo", "normal"].iter().enumerate() { // tuple pattern in for
        println!("{i}: {name}");
    }
}
```

## Memory layout

An enum is stored as a **tag** (discriminant) plus enough space for its largest
variant, exactly like the hand-written C version. The compiler picks the tag
size and may tuck it into padding.

The compiler also uses **niches**: bit patterns a type can never hold. A
reference is never null, so `Option<&T>` uses the null pointer to represent
`None`, and is the same size as a raw pointer. The same holds for `Box<T>`,
`NonZeroU32`, `bool` (values 2 to 255 are free) and enums with spare
discriminants.

```rust
use std::mem::size_of;
use std::num::NonZeroU32;

#[allow(dead_code)]
enum Shape {
    Circle { r: f32 },
    Rect { w: f32, h: f32 },
}

fn main() {
    println!("&u64              {}", size_of::<&u64>());              // 8
    println!("Option<&u64>      {}", size_of::<Option<&u64>>());      // 8: null is None
    println!("Option<Box<u64>>  {}", size_of::<Option<Box<u64>>>());  // 8
    println!("Option<u32>       {}", size_of::<Option<u32>>());       // 8: needs a tag
    println!("Option<NonZeroU32> {}", size_of::<Option<NonZeroU32>>()); // 4: 0 is None
    println!("Shape             {}", size_of::<Shape>());             // 12: tag + 2 floats
    println!("Option<Shape>     {}", size_of::<Option<Shape>>());     // 12: spare tag values
}
```

So "use `Option` instead of null" costs nothing for pointers. That is why
`Option<Box<Node>>` is the standard way to write a nullable owning pointer.

## Example: a render command list

Enums shine for command buffers, events, messages and state machines. Here is a
small command list a game thread could build and a render thread could
consume:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
enum Pipeline {
    Opaque,
    Transparent,
}

#[derive(Debug)]
enum Command {
    SetViewport { x: u32, y: u32, w: u32, h: u32 },
    BindPipeline(Pipeline),
    Draw { mesh: u32, instances: u32 },
    Clear([f32; 4]),
}

fn execute(cmds: &[Command]) -> (u32, u32) {
    let mut draw_calls = 0;
    let mut pipeline_changes = 0;
    let mut current = None;

    for cmd in cmds {
        match *cmd {
            Command::Clear(color) => println!("clear to {color:?}"),
            Command::SetViewport { x, y, w, h } => println!("viewport {w}x{h} at ({x}, {y})"),
            Command::BindPipeline(p) if current == Some(p) => {} // redundant bind: skip
            Command::BindPipeline(p) => {
                current = Some(p);
                pipeline_changes += 1;
            }
            Command::Draw { instances: 0, .. } => {}             // nothing to draw
            Command::Draw { mesh, instances } => {
                draw_calls += 1;
                println!("draw mesh {mesh} x{instances} with {:?}", current.unwrap());
            }
        }
    }
    (draw_calls, pipeline_changes)
}

fn main() {
    let cmds = vec![
        Command::Clear([0.1, 0.1, 0.1, 1.0]),
        Command::SetViewport { x: 0, y: 0, w: 1280, h: 720 },
        Command::BindPipeline(Pipeline::Opaque),
        Command::Draw { mesh: 1, instances: 100 },
        Command::BindPipeline(Pipeline::Opaque),
        Command::Draw { mesh: 2, instances: 0 },
        Command::BindPipeline(Pipeline::Transparent),
        Command::Draw { mesh: 3, instances: 4 },
    ];
    println!("{:?}", execute(&cmds));
    println!("each command is {} bytes", std::mem::size_of::<Command>());
}
```

Add a `Dispatch { x: u32, y: u32, z: u32 }` variant and the compiler points at
`execute` until you handle it.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Every `Command` is as large as its largest variant (here 20 bytes). For a
command stream with a few rare, very large variants, box the large payload
(`Upload(Box<UploadInfo>)`) so the common commands stay small and the vector
stays dense, the same trade-off as with `std::variant`.

</div>

## Summary

| C / C++ | Rust |
|---|---|
| `enum class` | `enum` without data |
| Hand-written tagged union / `std::variant` | `enum` with data |
| `switch` (fall-through, non-exhaustive) | `match` (no fall-through, exhaustive) |
| `std::visit` + overloaded lambdas | `match` |
| `nullptr`, `std::optional<T>` | `Option<T>`, free for pointers |
| Structured bindings | Patterns in `let`, `match`, `if let`, `for`, parameters |

## Exercises

1. Add a `Dispatch` variant to `Command` and handle it in `execute`.
2. Write `impl TryFrom<u32> for BlendMode` that maps 0, 1, 2 to the variants
   and returns `Err(value)` otherwise.
3. Model a door with states `Closed`, `Opening { progress: f32 }`, `Open` and
   `Closing { progress: f32 }`, and write
   `fn update(self, dt: f32) -> DoorState` that advances the state machine.
