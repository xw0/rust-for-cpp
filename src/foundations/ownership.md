# Ownership and moves

You already know the core idea of this chapter. In C++ you write a class whose
constructor acquires a resource and whose destructor releases it, and you rely
on scope to run that destructor at the right time. That is RAII, and it is the
best idea C++ has.

Rust takes RAII and makes it the **only** way resources are managed, then adds
one thing C++ never had: the compiler tracks, for every value, which variable
currently owns it. That one addition removes use-after-move, double free and
most of the rule of five.

This chapter covers:

- the three ownership rules, and how they map onto RAII,
- what a move actually does in each language (they are surprisingly different),
- `Copy` and `Clone`, the replacements for copy constructors,
- `Drop`, the replacement for destructors, and drop order,
- wrapping a GPU resource so it cannot leak or be freed twice.

## The rules

1. Every value has exactly one **owner**, a variable or a field.
2. When the owner goes out of scope, the value is **dropped** (its destructor runs).
3. Ownership can be **moved** to another variable, and then the old one can no
   longer be used.

Rules 1 and 2 are RAII exactly as you know it. Rule 3 is where Rust and C++
part ways.

## What a move does

Here is the same function in both languages. Step through each tab, and pay
attention to what happens to `a`.

<div class="rfc-memviz" data-diagram="ownership-move"></div>

Two differences matter:

| | C++ | Rust |
|---|---|---|
| Who performs the move | The move constructor, user code that can do anything | The compiler: a bitwise copy of the value's bytes |
| State of the source | A live object in a "valid but unspecified" state | Statically inaccessible; using it is a compile error |
| Destructor of the source | Still runs, so the move constructor must neutralize it | Does not run |
| Can a move throw / fail? | Yes, unless marked `noexcept` | No, it is a `memcpy` |

Because a Rust move is always a shallow byte copy, every type is movable and no
type can customize how it moves. You never write a move constructor, and
`std::vector`'s old dilemma (copy elements on reallocation unless the move
constructor is `noexcept`) does not exist: `Vec` always moves elements with
`memcpy`.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

"Bitwise copy" describes the semantics, not necessarily the machine code. The
optimizer removes most moves entirely, just as C++ elides copies. If a move
does show up in a profile, it is a `memcpy` of `size_of::<T>()` bytes. A
`Vec<T>` is 24 bytes on a 64-bit target no matter how many elements it holds,
so moving one is cheap. A `[f32; 4096]` is 16 KiB, so move it into a `Box`
first if you pass it around by value.

</div>

Try it yourself. This program does not compile. Run it to see the error, then
fix it by removing the bad line, or by using `let b = a.clone();` to make an
explicit deep copy.

```rust,editable,compile_fail
fn main() {
    let a = vec![1, 2, 3];
    let b = a;
    println!("a has {} elements", a.len());
    println!("b has {} elements", b.len());
}
```

## Moves into and out of functions

Passing an argument by value moves it, exactly like passing a
`std::unique_ptr<T>` by value. There is no `std::move` to write, because the
move is the default, and there is no null left behind.

<div class="rfc-memviz" data-diagram="move-into-fn"></div>

Returning a value moves it out to the caller, which is how a function hands
ownership back:

```rust
fn make_buffer(len: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(len);
    v.resize(len, 0.0);
    v // moved out to the caller; nothing is freed here
}

fn add_one(mut v: Vec<f32>) -> Vec<f32> {
    for x in &mut v {
        *x += 1.0;
    }
    v // ownership comes back
}

fn main() {
    let buf = make_buffer(4);
    let buf = add_one(buf); // move in, move out
    println!("{buf:?}");
}
```

Taking and giving back ownership works, but it is clumsy when a function only
needs to look at or modify a value. That is what borrowing is for, and it is
the subject of the [next chapter](borrowing.md). In practice most functions
take references, and you move only when ownership really changes hands: pushing
into a container, sending to another thread, storing in a struct.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

In C++, `void f(std::string s)` followed by `f(name)` silently copies the
string, and you add `std::move` to avoid it. In Rust, `f(name)` moves, and you
write `f(name.clone())` when you really want a copy. Expensive operations are
always visible in the source.

</div>

## Copy types

Moving an `i32` and then using the original would be silly: there is nothing to
"own". Types whose bytes can be duplicated safely implement the `Copy` trait,
and assignment copies them instead of moving them. The source stays usable.

```rust
#[derive(Clone, Copy, Debug)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

fn length(v: Vec3) -> f32 {
    (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
}

fn main() {
    let up = Vec3 { x: 0.0, y: 1.0, z: 0.0 };
    let also_up = up;                  // a copy, not a move
    println!("{}", length(up));        // `up` is still usable
    println!("{also_up:?}");
}
```

Integers, floats, `bool`, `char`, shared references, and arrays and tuples of
`Copy` types are all `Copy`. A type can only be `Copy` if all its fields are,
and if it has no `Drop` implementation. `String`, `Vec` and `Box` are never
`Copy`, because duplicating their bytes would create two owners of one heap
allocation.

The rule of thumb for engine code: small plain-data types such as vectors,
matrices, colors, handles and IDs should derive `Copy`. Anything that owns a
resource should not.

`Clone` is the explicit deep copy, the equivalent of a copy constructor that
you must call by name. `#[derive(Clone)]` generates a member-wise clone, like a
defaulted copy constructor.

| C++ | Rust |
|---|---|
| Trivially copyable type | `#[derive(Clone, Copy)]` |
| Copy constructor | `impl Clone` (called explicitly with `.clone()`) |
| `= delete` copy constructor | Do nothing: types are not copyable unless you opt in |
| Move constructor / move assignment | Nothing to write: every move is a `memcpy` |
| Destructor | `impl Drop` |

## Drop: destructors

`Drop` is the destructor. It runs when the owner goes out of scope, and it
runs at most once per value, because the compiler tracks moves.

```rust
struct Noisy(&'static str);

impl Drop for Noisy {
    fn drop(&mut self) {
        println!("drop {}", self.0);
    }
}

struct Pair {
    first: Noisy,
    second: Noisy,
}

fn main() {
    let _a = Noisy("a");
    let _b = Noisy("b");
    let _p = Pair { first: Noisy("p.first"), second: Noisy("p.second") };
    let c = Noisy("c");
    drop(c); // explicit early drop: `c` is moved into `drop` and dies there
    println!("end of main");
}
```

Run it and read the output carefully:

- Local variables are dropped in reverse order of declaration, like C++.
- Struct fields are dropped in **declaration order**, which is the opposite of
  C++ (members are destroyed in reverse). This rarely matters, but it does
  when one field must outlive another, for example a Vulkan device and the
  objects created from it. Put the dependent objects first, or wrap the
  order-sensitive part in an explicit `Drop` for the parent struct.
- `drop(x)` is not special. It is an ordinary function that takes its argument
  by value and does nothing, so the value is dropped when it returns.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood: drop flags</span>

What if a value is moved on only one branch?

```rust
fn maybe_consume(v: Vec<u8>, flag: bool) {
    if flag {
        drop(v);
    }
    // is `v` dropped here?
}
# fn main() { maybe_consume(vec![1], true); }
```

The compiler adds a hidden boolean "drop flag" on the stack, sets it when `v`
is moved, and checks it at the end of scope. This is the only runtime cost of
ownership tracking, and it only appears when moves are conditional.

</div>

## Wrapping a GPU resource

Here is where ownership pays off for graphics code. In C++, a class that owns
an OpenGL buffer name needs the full rule of five to be correct:

```cpp
class GlBuffer {
public:
    explicit GlBuffer(GLsizeiptr size) { glGenBuffers(1, &id_); /* ... */ }
    ~GlBuffer() { if (id_) glDeleteBuffers(1, &id_); }

    GlBuffer(const GlBuffer&) = delete;             // no copies: double delete
    GlBuffer& operator=(const GlBuffer&) = delete;

    GlBuffer(GlBuffer&& o) noexcept : id_(o.id_) { o.id_ = 0; }   // steal, null out
    GlBuffer& operator=(GlBuffer&& o) noexcept {
        if (this != &o) {
            if (id_) glDeleteBuffers(1, &id_);
            id_ = o.id_;
            o.id_ = 0;
        }
        return *this;
    }
private:
    GLuint id_ = 0;   // 0 doubles as the "moved-from" marker
};
```

Every line of that is there to manage the moved-from state. In Rust there is no
moved-from state, so the type is:

```rust
# mod gl {
#     pub type GLuint = u32;
#     pub unsafe fn GenBuffers(_n: i32, ids: *mut GLuint) { unsafe { *ids = 1; } }
#     pub unsafe fn DeleteBuffers(_n: i32, ids: *const GLuint) {
#         println!("glDeleteBuffers({})", unsafe { *ids });
#     }
# }
pub struct GlBuffer {
    id: gl::GLuint, // never 0 while the struct exists
}

impl GlBuffer {
    pub fn new() -> GlBuffer {
        let mut id = 0;
        unsafe { gl::GenBuffers(1, &mut id) };
        GlBuffer { id }
    }
}

impl Drop for GlBuffer {
    fn drop(&mut self) {
        unsafe { gl::DeleteBuffers(1, &self.id) };
    }
}

fn main() {
    let a = GlBuffer::new();
    let b = a;            // move: `a` is gone, `b` owns the buffer
    let buffers = vec![b]; // move into a container
    drop(buffers);         // glDeleteBuffers runs exactly once
}
```

It is not `Copy` and not `Clone`, so it cannot be duplicated. Moves need no
code. `Drop` runs exactly once. The `0` sentinel is gone, so the destructor has
no `if`. (The `gl` module is stubbed out in a hidden part of the example so it
runs in the browser. Click the eye icon to see it. The [OpenGL
chapter](../engine/opengl.md) uses the real bindings.)

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Ownership is a tree: each value has one owner. Engines are full of things that
are *not* trees: a mesh used by many entities, a texture referenced by many
materials, a parent and child that point at each other. Rust has three answers,
and you will meet all of them:

- **Borrowing** for short-lived access ([next chapter](borrowing.md)).
- **Shared ownership** with `Rc`/`Arc`, the equivalents of `shared_ptr`
  ([Smart pointers](smart-pointers.md)).
- **Handles** into an arena that owns everything, which is usually the best fit
  for engines ([Handles and arenas](../engine/handles-and-arenas.md)).

</div>

## Leaving a value behind: `take` and `replace`

Sometimes you really do want the C++ behavior: move a value out of a struct
field and leave something valid in its place. You cannot move out of a field
you only borrowed, because that would leave a hole. Instead you swap something
in explicitly:

```rust
use std::mem;

struct Frame {
    commands: Vec<String>,
}

impl Frame {
    /// Hand the recorded commands to the renderer and start a fresh list.
    fn flush(&mut self) -> Vec<String> {
        mem::take(&mut self.commands) // leaves Vec::new() behind
    }
}

fn main() {
    let mut f = Frame { commands: vec!["draw".into(), "dispatch".into()] };
    let submitted = f.flush();
    println!("{submitted:?}, left: {:?}", f.commands);

    let mut current = String::from("old");
    let previous = mem::replace(&mut current, String::from("new"));
    println!("{previous} -> {current}");
}
```

`mem::take` (for types with a `Default`), `mem::replace` and `mem::swap` are
the explicit versions of the moved-from state. For optional fields,
`Option::take()` does the same and leaves `None` behind. The difference from
C++ is that the leftover value is one *you* chose, written in the source.

## Summary

| C++ | Rust |
|---|---|
| RAII is a convention | RAII is the only model; the compiler enforces it |
| `std::move(x)` casts; the move constructor moves | `let y = x;` moves, always a byte copy |
| Moved-from object is alive and must be valid | Moved-from variable cannot be used at all |
| Copy is implicit unless deleted | Copy only for `Copy` types; otherwise `.clone()` |
| Rule of five | Implement `Drop` if needed, derive `Clone` if wanted |
| Members destroyed in reverse order | Fields dropped in declaration order |

## Exercises

1. Change `Vec3` above to remove `Copy` (keep `Clone`). What error do you get,
   and what are two ways to fix `main`?
2. In the `Noisy` example, add a third field to `Pair` and predict the output
   before running it.
3. Add a `GlBuffer::into_raw(self) -> GLuint` method that gives up ownership
   without deleting the buffer. Hint: look up `std::mem::forget`, and think
   about why it takes `self` by value.
