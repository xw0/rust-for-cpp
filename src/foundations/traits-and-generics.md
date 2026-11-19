# Traits and generics

C++ gives you two separate tools for polymorphism: virtual functions for
run-time dispatch and templates for compile-time dispatch, with concepts
(C++20) bolted on to constrain templates. Rust has one concept that serves
both purposes: the **trait**. A trait is a set of methods a type can
implement. Used as a constraint on a generic, it is a concept and the call is
resolved at compile time. Used behind a pointer as `dyn Trait`, it is an
interface with a vtable.

This chapter covers:

- defining and implementing traits,
- generics with trait bounds, and how they compare to templates and concepts,
- `dyn Trait` and where the vtable pointer lives,
- choosing between static and dynamic dispatch,
- associated types and constants,
- composition instead of inheritance,
- the orphan rule.

## Defining and implementing a trait

```rust
trait Shape {
    fn area(&self) -> f32;
    fn name(&self) -> String {               // a default method, like a non-pure virtual
        String::from("shape")
    }
}

struct Circle {
    r: f32,
}

struct Rect {
    w: f32,
    h: f32,
}

impl Shape for Circle {
    fn area(&self) -> f32 {
        std::f32::consts::PI * self.r * self.r
    }
    fn name(&self) -> String {
        format!("circle r={}", self.r)
    }
}

impl Shape for Rect {
    fn area(&self) -> f32 {
        self.w * self.h
    }
}

fn main() {
    let c = Circle { r: 1.0 };
    let r = Rect { w: 2.0, h: 3.0 };
    println!("{} {}", c.name(), c.area());
    println!("{} {}", r.name(), r.area());
}
```

The implementation is separate from the type: `impl Shape for Circle` can live
next to the trait, next to the type, or anywhere else in the crate. You can
implement your own traits for types you did not write, including `i32`, `Vec<T>`
and types from other crates. That is impossible with C++ base classes, which
must be decided when the class is defined.

## Generics: compile-time polymorphism

A **generic** function has type parameters, like a template. Unlike a template,
the parameters must be **bounded** by the traits the body uses:

<div class="rfc-compare">
<div class="rfc-cpp">

C++ template (unconstrained)

```cpp
template <typename S>
float total_area(const std::vector<S>& shapes) {
    float sum = 0;
    for (const auto& s : shapes)
        sum += s.area();   // checked only when instantiated
    return sum;
}
```

</div>
<div class="rfc-rust">

Rust generic (bounded)

```rust
# trait Shape { fn area(&self) -> f32; }
fn total_area<S: Shape>(shapes: &[S]) -> f32 {
    let mut sum = 0.0;
    for s in shapes {
        sum += s.area();   // allowed: S: Shape
    }
    sum
}
# fn main() {}
```

</div>
</div>

The bound `S: Shape` is a contract checked in both directions:

- **At the definition**, the body may only use what the bounds promise. Calling
  `s.perimeter()` inside `total_area` is an error right there, even if no one
  calls `total_area` yet. C++ templates are checked only when instantiated, and
  even concepts do not stop a template body from using operations its concept
  does not mention.
- **At the call site**, the argument type must implement `Shape`. The error says
  "the trait `Shape` is not implemented for `Triangle`", not three pages of
  substitution failures.

Code generation works exactly like templates: the compiler **monomorphizes**,
creating a separate copy of `total_area` for each concrete `S`, with `area()`
calls resolved statically and usually inlined. There is no run-time cost.

Bounds can be written several ways; they all mean the same:

```rust
use std::fmt::Debug;

trait Shape { fn area(&self) -> f32; }

fn a<S: Shape + Debug>(s: &S) -> f32 { s.area() }              // inline bounds
fn b<S>(s: &S) -> f32 where S: Shape + Debug { s.area() }      // where clause
fn c(s: &(impl Shape + Debug)) -> f32 { s.area() }              // impl Trait in argument position

// Returning `impl Trait`: "some concrete type that implements Iterator",
// like returning `auto` from a function, but with a stated interface.
fn evens(limit: u32) -> impl Iterator<Item = u32> {
    (0..limit).filter(|n| n % 2 == 0)
}

fn main() {
    println!("{:?}", evens(10).collect::<Vec<_>>());
}
```

Generic structs work like class templates:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect<T> {
    min: [T; 2],
    max: [T; 2],
}

impl<T: Copy + PartialOrd> Rect<T> {
    fn contains(&self, p: [T; 2]) -> bool {
        p[0] >= self.min[0] && p[0] < self.max[0] && p[1] >= self.min[1] && p[1] < self.max[1]
    }
}

// Methods that exist only for one instantiation, like a partial specialization of the interface.
impl Rect<f32> {
    fn area(&self) -> f32 {
        (self.max[0] - self.min[0]) * (self.max[1] - self.min[1])
    }
}

fn main() {
    let pixels = Rect { min: [0u32, 0], max: [1920, 1080] };
    let uv = Rect { min: [0.0f32, 0.0], max: [0.5, 0.5] };
    println!("{} {} {}", pixels.contains([10, 10]), uv.contains([0.7, 0.1]), uv.area());
}
```

Rust has no template specialization (an unstable version exists), no
variadic generics, and no SFINAE. Const generics (`struct Matrix<const R: usize,
const C: usize>`) cover the most common use of non-type template parameters.

## `dyn Trait`: run-time polymorphism

To hold *different* shapes in one collection, you need dynamic dispatch. In
Rust that is a **trait object**, `dyn Shape`, always used behind a pointer:
`&dyn Shape`, `Box<dyn Shape>`, `Arc<dyn Shape>`.

```rust
trait Shape {
    fn area(&self) -> f32;
}
struct Circle { r: f32 }
struct Rect { w: f32, h: f32 }
impl Shape for Circle { fn area(&self) -> f32 { 3.14159 * self.r * self.r } }
impl Shape for Rect { fn area(&self) -> f32 { self.w * self.h } }

fn main() {
    let shapes: Vec<Box<dyn Shape>> = vec![
        Box::new(Circle { r: 1.0 }),
        Box::new(Rect { w: 2.0, h: 3.0 }),
    ];
    let total: f32 = shapes.iter().map(|s| s.area()).sum();
    println!("{total}");
    println!("Box<dyn Shape> is {} bytes", std::mem::size_of::<Box<dyn Shape>>());
    println!("Circle is {} bytes", std::mem::size_of::<Circle>());
}
```

The output shows something surprising: a `Box<dyn Shape>` is **two** pointers
wide, and a `Circle` is just its `f32`. Rust does not store a vtable pointer in
the object. It stores it in the **pointer**. Step through the comparison:

<div class="rfc-memviz" data-diagram="vtable"></div>

Consequences of storing the vtable in a "fat pointer":

- Types pay nothing for traits they might be used through. A `Vec3` can
  implement ten traits and still be 12 bytes, usable in a GPU buffer.
- The same object can be viewed through different traits at different times,
  each with its own vtable.
- You can make a trait object out of any type, including `i32` or a type from
  another crate, without changing it.
- Each `&dyn Trait` is 16 bytes instead of 8. Arrays of trait objects cost
  twice the pointer memory.

Not every trait can be used as `dyn`. A trait is **dyn-compatible** (formerly
"object safe") if its methods can be called through a vtable: no generic
methods, and no methods returning `Self` by value. The compiler tells you when
a trait is not.

## Static or dynamic dispatch?

| | Generics (`T: Trait`) | Trait objects (`dyn Trait`) |
|---|---|---|
| C++ analogue | Templates + concepts | Virtual functions |
| Dispatch | Compile time; inlinable | Run time; indirect call |
| Code size | One copy per type | One copy |
| Heterogeneous collections | No | Yes |
| Compile time | Longer | Shorter |

Rust code defaults to generics, as modern C++ defaults to templates in
libraries. Reach for `dyn` when you need a heterogeneous collection, a plugin
boundary, or to stop generic code from spreading through a large codebase.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

The classic OOP engine has `class GameObject { virtual void update(); }` and a
`std::vector<GameObject*>`. The direct translation, `Vec<Box<dyn GameObject>>`,
works and is sometimes right (a few dozen heterogeneous systems, editor
panels, a render-graph's passes). For thousands of entities it has the same
cache problems as in C++, plus it fights the borrow checker as soon as objects
need to touch each other. Most Rust engines use enums for closed sets of
variants ([Enums](enums-and-match.md)) and an ECS for game objects
([ECS chapter](../engine/ecs.md)).

</div>

## Associated types and constants

Traits can declare types and constants that each implementation fills in, much
like nested typedefs in a C++ traits class:

```rust
trait VertexFormat {
    type Index;                  // associated type
    const STRIDE: usize;         // associated constant
    fn attributes() -> &'static [(&'static str, usize)];
}

#[repr(C)]
struct PosUv {
    pos: [f32; 3],
    uv: [f32; 2],
}

impl VertexFormat for PosUv {
    type Index = u16;
    const STRIDE: usize = std::mem::size_of::<PosUv>();
    fn attributes() -> &'static [(&'static str, usize)] {
        &[("pos", 0), ("uv", 12)]
    }
}

fn describe<V: VertexFormat>() {
    println!(
        "stride {} bytes, index {} bytes, attributes {:?}",
        V::STRIDE,
        std::mem::size_of::<V::Index>(),
        V::attributes()
    );
}

fn main() {
    describe::<PosUv>();
}
```

The standard library's `Iterator` trait has an associated type `Item`, which is
why you write `impl Iterator<Item = u32>`.

## Composition instead of inheritance

Rust has no struct inheritance. What it offers instead:

- **Composition:** a struct contains other structs as fields, and forwards
  methods explicitly where needed.
- **Default methods** on traits provide shared behavior.
- **Supertraits:** `trait Drawable: Shape` means every `Drawable` is also a
  `Shape`, so code with a `Drawable` can call `area()`. This is interface
  inheritance, not data inheritance.
- **Blanket implementations:** implement a trait for every type that satisfies
  some bound, e.g. `impl<T: Shape> Describe for T { ... }`.

```rust
trait Shape {
    fn area(&self) -> f32;
}

trait Describe {
    fn describe(&self) -> String;
}

// Every Shape gets Describe for free.
impl<T: Shape> Describe for T {
    fn describe(&self) -> String {
        format!("a shape with area {:.2}", self.area())
    }
}

struct Square(f32);
impl Shape for Square {
    fn area(&self) -> f32 { self.0 * self.0 }
}

fn main() {
    println!("{}", Square(3.0).describe());
}
```

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

Do not try to emulate a class hierarchy with traits and `Deref`. If you catch
yourself designing `trait Entity`, `trait Actor: Entity`, `trait Pawn: Actor`,
step back. Ask which *behaviors* you need to abstract over (update, render,
serialize), make those small traits, and let concrete types compose data.

</div>

## The orphan rule

You may write `impl Trait for Type` only if your crate defines the trait or the
type (or both). You cannot implement `std::fmt::Display` for `Vec<u8>`, because
neither is yours. This **coherence** rule guarantees there is at most one
implementation of a trait for a type in the whole program, so adding a
dependency can never make two implementations clash, the way two libraries'
`operator<<` overloads or template specializations can in C++.

The usual workaround is a newtype: `struct Bytes(Vec<u8>);` is your type, so
you may implement anything for it.

## Summary

| C++ | Rust |
|---|---|
| Abstract base class | Trait |
| Virtual function | Trait method called through `dyn Trait` |
| vptr inside the object | Vtable pointer inside a fat pointer |
| Template | Generic with trait bounds |
| Concept | Trait bound, checked at definition and use |
| `auto f()` returning a hidden type | `fn f() -> impl Trait` |
| Traits class / nested typedef | Associated type / constant |
| Inheritance of data | Composition |
| Template specialization | Not available (use traits on concrete types) |

## Exercises

1. Add a `perimeter` method to `Shape` without a default, and fix the compile
   errors. Then give it a default that returns `0.0` and remove one
   implementation. What changes?
2. Write `fn largest<T: PartialOrd + Copy>(xs: &[T]) -> Option<T>`. Call it with
   `i32`s, `f32`s and `char`s. Why does `Copy` appear in the bound?
3. Write a `trait System { fn run(&mut self, dt: f32); }` and store three
   different systems in a `Vec<Box<dyn System>>`. Then rewrite it with an
   `enum` of the three systems. Which would you choose for 3 systems, and for
   300?
