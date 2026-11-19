# Smart pointers and interior mutability

You know `std::unique_ptr` and `std::shared_ptr`. Rust has direct equivalents,
`Box` and `Rc`/`Arc`, and they behave the way you expect, with two twists:
ownership rules apply to them like to everything else, so many of their C++
footguns disappear, and shared ownership combines with Rust's "shared XOR
mutable" rule in a way that needs a new tool, **interior mutability**.

This chapter covers:

- `Box<T>` and when you actually need it,
- `Rc<T>` and `Arc<T>`, and why there are two,
- `Weak<T>` and reference cycles,
- `Cell` and `RefCell`: mutation through a shared reference,
- the common combinations, and when to avoid them.

## `Box<T>`: one owner, on the heap

`Box<T>` is a pointer to a heap allocation that it owns, exactly like
`std::unique_ptr<T>`. It is one pointer wide, never null, and frees its
contents when dropped.

```rust
#[derive(Debug)]
enum Node {
    Leaf(u32),
    Branch(Box<Node>, Box<Node>),   // recursion needs indirection
}

fn sum(n: &Node) -> u32 {
    match n {
        Node::Leaf(v) => *v,
        Node::Branch(l, r) => sum(l) + sum(r),
    }
}

fn main() {
    let tree = Node::Branch(Box::new(Node::Leaf(1)), Box::new(Node::Branch(
        Box::new(Node::Leaf(2)),
        Box::new(Node::Leaf(3)),
    )));
    println!("{}", sum(&tree));

    let big = Box::new([0u8; 1 << 16]);   // 64 KiB on the heap, not the stack
    println!("{}", big.len());
}
```

You need `Box` less often than `unique_ptr`, because Rust values are moved
cheaply without heap allocation, and `Vec`, `String` and `HashMap` already
manage their heap memory. Use `Box` for:

- **recursive types**, as above (a type cannot contain itself directly),
- **trait objects**: `Box<dyn Trait>`,
- **large values** you want to move around without copying many bytes,
- **stable addresses** for data handed to C code.

## `Rc<T>` and `Arc<T>`: shared ownership

`Rc<T>` ("reference counted") is `shared_ptr<T>`: many owners, and the value is
dropped when the last one goes away. Cloning an `Rc` increments the count; it
does not clone the value.

<div class="rfc-memviz" data-diagram="rc-count"></div>

```rust
use std::rc::Rc;

#[derive(Debug)]
struct Mesh {
    name: String,
    vertex_count: u32,
}

struct Instance {
    mesh: Rc<Mesh>,
    transform: [f32; 3],
}

fn main() {
    let rock = Rc::new(Mesh { name: "rock".into(), vertex_count: 1200 });
    let instances: Vec<Instance> = (0..3)
        .map(|i| Instance { mesh: Rc::clone(&rock), transform: [i as f32, 0.0, 0.0] })
        .collect();
    println!("{} owners", Rc::strong_count(&rock));   // 4
    for inst in &instances {
        println!("{} at {:?} ({} verts)", inst.mesh.name, inst.transform, inst.mesh.vertex_count);
    }
    drop(instances);
    println!("{} owner", Rc::strong_count(&rock));    // 1
}
```

Why two types? `shared_ptr` always uses atomic increments, because it cannot
know whether it will be shared across threads. Rust can know: `Rc` uses plain,
non-atomic counts and the compiler **forbids sending it to another thread**
(it does not implement `Send`; see [Concurrency](../systems/concurrency.md)).
`Arc` ("atomically reference counted") uses atomic counts and can be shared
between threads. You get the cheap version by default and the compiler tells
you when you need the expensive one.

Two more differences from `shared_ptr`:

- The value inside an `Rc` is **immutable** through the `Rc`. `Rc<T>` gives you
  `&T`, never `&mut T`, because other owners might be reading it. Mutation
  needs interior mutability, below.
- `Rc::new` allocates the counts and the value together, like
  `std::make_shared`. There is no separate control block.

## `Weak<T>` and cycles

Reference counting cannot free cycles: if A owns B and B owns A, both counts
stay above zero forever. As with `weak_ptr`, the fix is a non-owning `Weak`
pointer for back-edges such as child-to-parent links. `upgrade()` returns an
`Option<Rc<T>>`, which is `None` once the value is gone:

```rust
use std::cell::RefCell;
use std::rc::{Rc, Weak};

struct SceneNode {
    name: String,
    parent: RefCell<Weak<SceneNode>>,        // back-edge: does not keep the parent alive
    children: RefCell<Vec<Rc<SceneNode>>>,   // owning edges
}

fn node(name: &str) -> Rc<SceneNode> {
    Rc::new(SceneNode {
        name: name.into(),
        parent: RefCell::new(Weak::new()),
        children: RefCell::new(Vec::new()),
    })
}

fn add_child(parent: &Rc<SceneNode>, child: Rc<SceneNode>) {
    *child.parent.borrow_mut() = Rc::downgrade(parent);
    parent.children.borrow_mut().push(child);
}

fn main() {
    let root = node("root");
    let arm = node("arm");
    add_child(&root, Rc::clone(&arm));
    add_child(&arm, node("hand"));

    let parent_name = arm.parent.borrow().upgrade().map(|p| p.name.clone());
    println!("arm's parent: {parent_name:?}");
    println!("root strong={} weak={}", Rc::strong_count(&root), Rc::weak_count(&root));
    drop(root);
    println!("after dropping root: {:?}", arm.parent.borrow().upgrade().map(|p| p.name.clone()));
}
```

This works, but look at how much ceremony a parent/child tree takes:
`Rc`, `Weak`, `RefCell`, `borrow_mut`, `upgrade`. That is a strong hint. In Rust,
graphs of objects that point at each other are usually better stored in an
arena with indices or handles; see [Handles and
arenas](../engine/handles-and-arenas.md). A scene graph becomes a `Vec<Node>`
where `parent: Option<NodeId>`.

## Interior mutability: `Cell` and `RefCell`

The borrow rules say: many `&T` *or* one `&mut T`. Sometimes you need to mutate
something that is reachable only through a shared reference: a cache inside an
otherwise immutable object, a counter in an `Rc`, the children list above.
C++ has `mutable` for the first case and nothing in particular for the rest.

Rust's answer is types that allow mutation through `&self` while keeping the
guarantees, by checking in a different way:

| Type | How it stays safe | Cost | C++ analogue |
|---|---|---|---|
| `Cell<T>` | Never hands out references: only `get` (copy out) and `set` (replace) | Zero | A `mutable` member of trivial type |
| `RefCell<T>` | Tracks borrows **at run time**; a conflicting borrow panics | A counter and a check per borrow | `mutable` + a debug assertion |
| `Mutex<T>`, `RwLock<T>` | Locking; thread-safe | A lock | `std::mutex` next to the data |
| Atomics | Hardware atomics; thread-safe | Atomic ops | `std::atomic<T>` |

```rust
use std::cell::{Cell, RefCell};

struct Material {
    name: String,
    shader_compiles: Cell<u32>,                // statistics, mutated through &self
    cached_hash: RefCell<Option<u64>>,          // lazily computed
}

impl Material {
    fn hash(&self) -> u64 {                     // &self, not &mut self
        if let Some(h) = *self.cached_hash.borrow() {
            return h;
        }
        let h = self.name.bytes().fold(14695981039346656037u64, |h, b| {
            (h ^ b as u64).wrapping_mul(1099511628211)
        });
        *self.cached_hash.borrow_mut() = Some(h);
        self.shader_compiles.set(self.shader_compiles.get() + 1);
        h
    }
}

fn main() {
    let m = Material { name: "brick".into(), shader_compiles: Cell::new(0), cached_hash: RefCell::new(None) };
    let a = m.hash();
    let b = m.hash();
    println!("{a:x} {b:x} computed {} time(s)", m.shader_compiles.get());

    // RefCell enforces the rules at run time:
    let list = RefCell::new(vec![1, 2, 3]);
    let reader = list.borrow();
    // let writer = list.borrow_mut();   // would panic: already borrowed
    println!("{:?} {:?}", reader, list.try_borrow_mut().is_err());
}
```

`RefCell` moves the borrow check from compile time to run time. That is
sometimes necessary, but every `borrow_mut()` is a potential panic that the
compiler can no longer rule out. Keep `RefCell` borrows short, and prefer a
design where ownership is clear enough that you do not need it.

## Common combinations

| Type | Meaning |
|---|---|
| `Box<T>` | Single owner, heap |
| `Rc<T>` | Shared ownership, read-only, one thread |
| `Rc<RefCell<T>>` | Shared ownership, mutable, one thread, run-time borrow checks |
| `Arc<T>` | Shared ownership, read-only, any thread |
| `Arc<Mutex<T>>` / `Arc<RwLock<T>>` | Shared ownership, mutable, any thread |
| `Weak<T>` | Non-owning back-reference |

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

When the borrow checker rejects a design ported from C++, `Rc<RefCell<T>>`
everywhere makes the errors go away. It also gives you a program full of
reference counts and run-time borrow panics, which is the C++ design with
extra overhead. It is fine for a few genuinely shared objects. If it is your
default, the data model needs rethinking: one owner (often a `Vec` or an
arena) and handles everywhere else.

</div>

## Summary

| C++ | Rust |
|---|---|
| `std::unique_ptr<T>` | `Box<T>` |
| `std::make_unique<T>(...)` | `Box::new(...)` |
| `std::shared_ptr<T>` (atomic counts) | `Rc<T>` (single thread) or `Arc<T>` (atomic) |
| `std::make_shared<T>(...)` | `Rc::new(...)` / `Arc::new(...)` |
| `std::weak_ptr<T>`, `lock()` | `Weak<T>`, `upgrade()` |
| `mutable` member | `Cell<T>` / `RefCell<T>` |
| `shared_ptr<T>` with `std::mutex` member | `Arc<Mutex<T>>` |

## Exercises

1. In the `Rc<Mesh>` example, try to change `inst.mesh.vertex_count` through an
   instance. Read the error, then make it work with `Cell<u32>`.
2. Rewrite the scene node tree without `Rc`: store nodes in a `Vec<Node>` with
   `parent: Option<usize>` and `children: Vec<usize>`. Write a function that
   returns the path from a node to the root as names.
3. Write a program that panics with `already borrowed: BorrowMutError` using
   `RefCell`, then fix it by shortening the first borrow.
