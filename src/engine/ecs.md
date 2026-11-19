# ECS and the borrow checker

The classic object-oriented engine has a `GameObject` base class, a scene
graph of parents and children pointing at each other, and components that
hold pointers to their owner and to sibling components. Translate that
literally into Rust and you hit the borrow checker on the first day: every
object is reachable from several places, and any of those places might want to
mutate it.

The entity-component-system pattern (ECS) that many C++ engines adopted for
performance happens to be the shape that the borrow checker likes best. This
chapter explains why, builds a tiny ECS in about a hundred lines, and then
shows the crates real projects use.

This chapter covers:

- why a graph of mutually pointing objects fights the borrow checker,
- the struct-of-arrays world and split borrows,
- a tiny generic ECS with runtime-checked column borrows,
- archetypes, and the hecs and bevy_ecs crates,
- running systems in parallel safely.

## Why object graphs hurt

Here is a typical C++ scene node:

```cpp
struct Node {
    Node* parent;
    std::vector<Node*> children;
    Transform local, world;
    std::vector<Component*> components;   // each Component has Node* owner
};
```

Every pointer here is a second path to the same object. In C++ nothing stops
you from updating a child through `children[i]` while another function holds a
`Node&` to that same child. In Rust, a `&mut Node` must be the only path to
that node for as long as it lives. A literal translation therefore ends up as
`Rc<RefCell<Node>>` everywhere, with `Weak` for the parent link:

```rust
use std::cell::RefCell;
use std::rc::{Rc, Weak};

struct Node {
    name: String,
    parent: RefCell<Weak<Node>>,
    children: RefCell<Vec<Rc<Node>>>,
    local_y: f32,
    world_y: RefCell<f32>,
}

fn update_world(node: &Rc<Node>, parent_y: f32) {
    let y = parent_y + node.local_y;
    *node.world_y.borrow_mut() = y;
    for child in node.children.borrow().iter() {
        update_world(child, y);
    }
}

fn main() {
    let root = Rc::new(Node {
        name: "root".into(), parent: RefCell::new(Weak::new()),
        children: RefCell::new(vec![]), local_y: 1.0, world_y: RefCell::new(0.0),
    });
    let arm = Rc::new(Node {
        name: "arm".into(), parent: RefCell::new(Weak::new()),
        children: RefCell::new(vec![]), local_y: 2.0, world_y: RefCell::new(0.0),
    });
    *arm.parent.borrow_mut() = Rc::downgrade(&root);
    root.children.borrow_mut().push(arm.clone());

    update_world(&root, 0.0);
    let parent = arm.parent.borrow().upgrade().unwrap();
    println!("{} world y = {}, parent = {}", arm.name, arm.world_y.borrow(), parent.name);
}
```

It works, but look at the cost. Every node is a separate heap allocation with
a reference count, every field access goes through a runtime borrow flag, a
mistake becomes a `BorrowMutError` panic instead of a compile error, and the
data is scattered across the heap, which is the cache behavior ECS was
invented to avoid. This is a sign that the design is fighting the language,
not that Rust cannot express it.

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

If you find yourself writing `Rc<RefCell<...>>` for most of your game objects,
stop and restructure. Put objects in arenas or component storage, refer to them
by [handle](handles-and-arenas.md), and pass the storage (not the object) to
the code that needs it.

</div>

## Step 1: a world of columns

The simplest ECS is a struct of arrays. An entity is an index; each component
type is a column; a missing component is `None`:

```rust
#[derive(Clone, Copy, Debug)]
struct Position { x: f32, y: f32 }
#[derive(Clone, Copy, Debug)]
struct Velocity { x: f32, y: f32 }
#[derive(Clone, Copy, Debug)]
struct Health(i32);

#[derive(Default)]
struct World {
    positions: Vec<Option<Position>>,
    velocities: Vec<Option<Velocity>>,
    health: Vec<Option<Health>>,
}

impl World {
    fn spawn(&mut self, p: Option<Position>, v: Option<Velocity>, h: Option<Health>) -> usize {
        self.positions.push(p);
        self.velocities.push(v);
        self.health.push(h);
        self.positions.len() - 1
    }
}

// A system is a function that borrows exactly the columns it needs.
fn movement(positions: &mut [Option<Position>], velocities: &[Option<Velocity>], dt: f32) {
    for (p, v) in positions.iter_mut().zip(velocities) {
        if let (Some(p), Some(v)) = (p, v) {
            p.x += v.x * dt;
            p.y += v.y * dt;
        }
    }
}

fn poison(health: &mut [Option<Health>]) {
    for h in health.iter_mut().flatten() {
        h.0 -= 1;
    }
}

fn main() {
    let mut world = World::default();
    let player = world.spawn(Some(Position { x: 0.0, y: 0.0 }), Some(Velocity { x: 1.0, y: 0.5 }), Some(Health(10)));
    let rock = world.spawn(Some(Position { x: 5.0, y: 5.0 }), None, None);

    // Split borrows: &mut to one field and & to another at the same time is fine.
    movement(&mut world.positions, &world.velocities, 0.016);
    poison(&mut world.health);

    println!("player {:?} {:?}", world.positions[player], world.health[player]);
    println!("rock   {:?}", world.positions[rock]);
}
```

Two things make this pleasant in Rust:

- **Split borrows.** `&mut world.positions` and `&world.velocities` borrow
  different fields, so the compiler allows both at once. This is the same rule
  that lets the particle loop in [Memory and
  performance](../systems/memory-and-performance.md) vectorize: the compiler
  knows the slices do not alias.
- **Systems declare their access in their signature.** `movement` cannot touch
  health; `poison` cannot touch positions. You can read a system's data
  dependencies from its parameter list.

What this version lacks is extensibility: every component type is a field of
`World`, and despawning leaves holes. Despawning is solved with generations,
exactly as in the [arena chapter](handles-and-arenas.md). Extensibility needs
type erasure.

## Step 2: a generic world

A reusable ECS cannot know the component types in advance. It stores one
column per type in a map keyed by `TypeId`, with the column type-erased as
`Box<dyn Any>`. Each column sits inside a `RefCell`, so that a query can borrow
the `Position` column mutably and the `Velocity` column immutably at the same
time, through a shared `&World`:

```rust
use std::any::{Any, TypeId};
use std::cell::{Ref, RefCell, RefMut};
use std::collections::HashMap;

type Entity = usize;

#[derive(Default)]
struct World {
    next: Entity,
    columns: HashMap<TypeId, Box<dyn Any>>, // each value is a RefCell<Vec<Option<T>>>
}

impl World {
    fn spawn(&mut self) -> Entity {
        self.next += 1;
        self.next - 1
    }

    fn insert<T: 'static>(&mut self, e: Entity, value: T) {
        let column = self
            .columns
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::new(RefCell::new(Vec::<Option<T>>::new())))
            .downcast_mut::<RefCell<Vec<Option<T>>>>()
            .expect("column type matches its TypeId");
        let column = column.get_mut();          // &mut World: no runtime check needed
        if column.len() <= e {
            column.resize_with(e + 1, || None);
        }
        column[e] = Some(value);
    }

    fn column<T: 'static>(&self) -> &RefCell<Vec<Option<T>>> {
        self.columns
            .get(&TypeId::of::<T>())
            .and_then(|c| c.downcast_ref())
            .expect("no such component type")
    }

    fn read<T: 'static>(&self) -> Ref<'_, Vec<Option<T>>> {
        self.column::<T>().borrow()
    }

    fn write<T: 'static>(&self) -> RefMut<'_, Vec<Option<T>>> {
        self.column::<T>().borrow_mut()
    }
}

#[derive(Debug)]
struct Position(f32, f32);
#[derive(Debug)]
struct Velocity(f32, f32);
struct Name(&'static str);

fn movement(world: &World, dt: f32) {
    let mut positions = world.write::<Position>();
    let velocities = world.read::<Velocity>();
    for (p, v) in positions.iter_mut().zip(velocities.iter()) {
        if let (Some(p), Some(v)) = (p, v) {
            p.0 += v.0 * dt;
            p.1 += v.1 * dt;
        }
    }
}

fn report(world: &World) {
    let names = world.read::<Name>();
    let positions = world.read::<Position>();
    for (n, p) in names.iter().zip(positions.iter()) {
        if let (Some(n), Some(p)) = (n, p) {
            println!("{:>6} at {:?}", n.0, p);
        }
    }
}

fn main() {
    let mut world = World::default();
    let ship = world.spawn();
    world.insert(ship, Name("ship"));
    world.insert(ship, Position(0.0, 0.0));
    world.insert(ship, Velocity(10.0, 0.0));
    let buoy = world.spawn();
    world.insert(buoy, Name("buoy"));
    world.insert(buoy, Position(3.0, 4.0));

    movement(&world, 0.5);
    report(&world);
}
```

This is the trade most ECS libraries make internally. The compiler cannot see
which columns a query will touch, because the types are chosen at run time
through a map, so the borrow rules move to run time: a system that asks for
`write::<Position>()` twice panics with "already borrowed" instead of creating
two aliasing `&mut`. The guarantee is the same as the compiler's (never two
mutable paths to the same column), only checked later. Real libraries check
these conflicts once, when a query or system is created, rather than on every
access.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

`Box<dyn Any>` plus `downcast_ref` is Rust's checked equivalent of storing a
`void*` next to a type ID and `static_cast`ing it back. `downcast_ref` compares
`TypeId`s and returns `None` on mismatch, so a bug gives you a clean panic
instead of reinterpreting memory.

</div>

## Archetypes

Columns of `Option<T>` indexed by entity waste memory when components are
sparse, and a query over two components still walks every entity. Production
ECS libraries (Unity DOTS, flecs, bevy_ecs, hecs) use **archetypes** instead:
all entities with exactly the same set of component types are stored together,
in one table with a dense column per type.

| Archetype | Columns (dense, same length) | Entities |
|---|---|---|
| {Position, Velocity} | `Vec<Position>`, `Vec<Velocity>` | ship, bullet 1, bullet 2 |
| {Position, Name} | `Vec<Position>`, `Vec<Name>` | buoy |
| {Position, Velocity, Health} | three columns | player |

A query for `(&mut Position, &Velocity)` visits only the tables whose
archetype contains both types, and inside each table zips two dense slices:
the same tight loop as the struct-of-arrays version, with no `Option` checks.
Adding or removing a component moves the entity to a different table, which is
the cost of the design. An entity ID maps to (table, row) through a small
lookup array with generations, like the arena in the previous chapter.

Rust does not change how archetypes work. What it changes is that a query
hands out `&mut Position` and `&Velocity` references, and the library must
prove they never alias. Libraries do that with the same runtime check we used,
done once per query, plus a little `unsafe` inside to hand out the slices.

## Using hecs

[hecs](https://docs.rs/hecs) is a small, library-style archetype ECS: a
`World` and queries, no scheduler and no framework. It is the closest thing to
EnTT in spirit:

```rust,ignore
use hecs::World;

struct Position(f32, f32);
struct Velocity(f32, f32);
struct Frozen;

let mut world = World::new();
let ship = world.spawn((Position(0.0, 0.0), Velocity(10.0, 0.0)));
world.spawn((Position(1.0, 1.0), Velocity(0.0, 1.0), Frozen));

// Iterate entities that have Position and Velocity, but not Frozen.
for (_entity, (p, v)) in world
    .query_mut::<(&mut Position, &Velocity)>()
    .without::<&Frozen>()
{
    p.0 += v.0 * 0.016;
    p.1 += v.1 * 0.016;
}

world.insert_one(ship, Frozen)?;     // moves the entity to another archetype
world.despawn(ship)?;                // the old Entity is now stale: get() returns Err
```

`query_mut` takes `&mut World`, so the compiler alone proves exclusivity. The
shared version, `world.query::<...>()` on `&World`, checks column borrows at
run time, like our `RefCell`s.

## Using bevy_ecs

[bevy_ecs](https://docs.rs/bevy_ecs) is the ECS of the Bevy engine, and works
as a standalone crate. Systems are ordinary functions whose **parameter types
describe their data access**. The scheduler reads those types and runs systems
whose access does not conflict on different threads:

```rust,ignore
use bevy_ecs::prelude::*;

#[derive(Component)] struct Position(f32, f32);
#[derive(Component)] struct Velocity(f32, f32);
#[derive(Component)] struct Health(i32);
#[derive(Resource)]  struct Time { dt: f32 }

fn movement(time: Res<Time>, mut q: Query<(&mut Position, &Velocity)>) {
    for (mut p, v) in &mut q {
        p.0 += v.0 * time.dt;
        p.1 += v.1 * time.dt;
    }
}

fn regenerate(mut q: Query<&mut Health>) {
    for mut h in &mut q {
        h.0 = (h.0 + 1).min(100);
    }
}

let mut world = World::new();
world.insert_resource(Time { dt: 1.0 / 60.0 });
world.spawn((Position(0.0, 0.0), Velocity(1.0, 0.0), Health(50)));

let mut schedule = Schedule::default();
schedule.add_systems((movement, regenerate));  // disjoint access: may run in parallel
schedule.run(&mut world);
```

`movement` writes `Position` and reads `Velocity` and `Time`; `regenerate`
writes `Health`. No overlap, so the scheduler may run them at the same time.
If two systems both wrote `Position`, it would run them one after the other.
A single system that asks for `Query<&mut Position>` twice is rejected when the
schedule is built.

`Res<Time>` is a **resource**: a singleton stored in the world. This is how
ECS code handles global state without `static mut`, a topic the [game
loop](game-loop.md) chapter returns to.

## Parallel systems, by hand

The scheduler is not magic. Split borrows plus scoped threads give you the same
thing for the struct-of-arrays world, and the compiler checks it:

```rust
#[derive(Default)]
struct World {
    pos: Vec<[f32; 2]>,
    vel: Vec<[f32; 2]>,
    health: Vec<i32>,
}

fn main() {
    let mut w = World {
        pos: vec![[0.0, 0.0]; 4],
        vel: vec![[1.0, 2.0]; 4],
        health: vec![10; 4],
    };

    // Destructure into disjoint borrows, then hand them to different threads.
    let World { pos, vel, health } = &mut w;
    std::thread::scope(|s| {
        s.spawn(|| {
            for (p, v) in pos.iter_mut().zip(vel.iter()) {
                p[0] += v[0];
                p[1] += v[1];
            }
        });
        s.spawn(|| {
            for h in health.iter_mut() {
                *h -= 1;
            }
        });
    });
    println!("{:?} {:?}", w.pos[0], w.health);
}
```

If both threads tried to write `pos`, the program would not compile. In C++,
the same mistake compiles and becomes a data race you look for in a frame
capture. Here the scheduler's job, deciding what can run together, is done by
the type checker.

## Hierarchies in an ECS

Scene graphs do not disappear; they become data. Parent links are components
holding entity IDs, and the world transform is computed by a system:

```rust
#[derive(Clone, Copy)]
struct Parent(usize);

fn propagate(parents: &[Option<Parent>], local: &[f32], world: &mut [f32]) {
    // Assumes parents come before children (sort once when the hierarchy changes).
    for e in 0..local.len() {
        world[e] = match parents[e] {
            Some(Parent(p)) => world[p] + local[e],
            None => local[e],
        };
    }
}

fn main() {
    let parents = [None, Some(Parent(0)), Some(Parent(1))];  // root, arm, hand
    let local = [1.0, 2.0, 0.5];
    let mut world = [0.0; 3];
    propagate(&parents, &local, &mut world);
    println!("{world:?}");
}
```

No `Rc`, no `RefCell`, no `Weak`: the parent link is an index, the borrows are
three plain slices, and the update is a linear pass over contiguous memory.
Compare it with the `Rc<RefCell<Node>>` version at the top of the chapter.

## Summary

| C++ | Rust |
|---|---|
| `GameObject*` graph, components with owner pointers | Entities as IDs, components in columns or archetype tables |
| `std::shared_ptr` + `weak_ptr` scene graph | `Parent(Entity)` component and a propagation system |
| EnTT, flecs | hecs (library), bevy_ecs (with scheduler) |
| Hand-written job graph with read/write declarations | System parameter types (`Query<&mut T>`, `Res<T>`) |
| Data races found in captures | Conflicting access rejected by the compiler or at schedule build |
| `void*` + type ID | `Box<dyn Any>` + `downcast_ref` |

## Exercises

1. Add generational entity IDs and a `despawn` to the generic `World`, reusing
   the `Handle` idea from [Handles and arenas](handles-and-arenas.md). What
   should `insert` do with a stale entity?
2. In the generic `World`, write a system that calls `world.write::<Position>()`
   twice in the same scope. Run it. Which error do you get, and when would the
   compiler have caught it instead?
3. Add a third thread to the parallel example that reads `pos` while the first
   writes it. Read the compiler error, then fix it by running the reader after
   the scope ends.
