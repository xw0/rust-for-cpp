# Handles and arenas instead of pointers

Game objects point at each other. A missile tracks its target, a light belongs
to a room, a UI widget knows its parent, an animation references a skeleton. In
C++ these links are usually raw pointers or `shared_ptr`/`weak_ptr`, and the
classic bug is a pointer that outlives its object: the enemy dies, its memory is
reused for a bullet, and the missile now steers toward the bullet.

The [borrowing chapter](../foundations/borrowing.md) showed that Rust
references are for short-lived access. A `&Enemy` stored inside a `Missile`
would freeze the whole enemy list for as long as the missile exists. This
chapter introduces the pattern most Rust engines use instead, which many C++
engines also use for the same reasons: **objects live in an arena, and other
objects refer to them by handle.**

You will:

- see why indices alone are not enough, and how a generation counter fixes them,
- build a small, typed generational arena (about 80 lines),
- compare it with `Rc`/`Weak` and with what C++ engines do,
- learn which crates to use in real projects.

## Handles in one picture

An **arena** is a `Vec` of slots that owns every object of one type. A
**handle** is a small `Copy` value (a slot index plus a generation number) that
identifies one object. Every time a slot is freed, its generation goes up, so
any handle created before that no longer matches.

Play with it. Start in C++ style, spawn two entities, despawn the first, spawn
another (it reuses the free slot), then read through the old pointer. Then
switch to handles and do the same.

<div class="rfc-widget" data-widget="arena"></div>

With plain pointers or indices, reading through a stale reference gives you
*a* valid-looking object, just the wrong one. No sanitizer catches it, because
the memory is not freed: it was reused, legitimately. A generation check turns
that into an `Option` you are forced to handle.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">You have seen this before</span>

This is the same design as handles in many C++ engines and libraries: Andre
Weissflog's "Handles are the better pointers" (the Sokol libraries), versioned
entity IDs in EnTT, and `VkBuffer` itself, which is a handle and not a pointer.
Rust did not invent it. What Rust adds is that the
alternative, long-lived raw pointers, simply does not compile, so the whole
codebase converges on handles.

</div>

## Building a generational arena

A handle should be typed, so a `Handle<Texture>` cannot be passed where a
`Handle<Mesh>` is expected, even though both are just two integers.
`PhantomData` adds the type parameter without storing anything:

```rust
use std::fmt;
use std::marker::PhantomData;

/// A copyable reference to a `T` stored in an `Arena<T>`. 8 bytes.
pub struct Handle<T> {
    index: u32,
    generation: u32,
    // `fn() -> T` instead of `T`: the handle does not own a T, so it stays
    // Copy, Send and Sync whatever T is.
    _marker: PhantomData<fn() -> T>,
}

// `#[derive(Clone, Copy)]` would require `T: Copy`, so implement them by hand.
impl<T> Clone for Handle<T> {
    fn clone(&self) -> Self { *self }
}
impl<T> Copy for Handle<T> {}
impl<T> PartialEq for Handle<T> {
    fn eq(&self, o: &Self) -> bool {
        self.index == o.index && self.generation == o.generation
    }
}
impl<T> Eq for Handle<T> {}
impl<T> fmt::Debug for Handle<T> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "#{}g{}", self.index, self.generation)
    }
}

struct Slot<T> {
    generation: u32,
    value: Option<T>,
}

pub struct Arena<T> {
    slots: Vec<Slot<T>>,
    free: Vec<u32>, // indices of empty slots, reused LIFO
    len: usize,
}

impl<T> Arena<T> {
    pub fn new() -> Self {
        Arena { slots: Vec::new(), free: Vec::new(), len: 0 }
    }

    pub fn insert(&mut self, value: T) -> Handle<T> {
        self.len += 1;
        let index = match self.free.pop() {
            Some(i) => {
                self.slots[i as usize].value = Some(value);
                i
            }
            None => {
                self.slots.push(Slot { generation: 0, value: Some(value) });
                (self.slots.len() - 1) as u32
            }
        };
        let generation = self.slots[index as usize].generation;
        Handle { index, generation, _marker: PhantomData }
    }

    /// Removes and returns the value, or `None` if the handle is stale.
    pub fn remove(&mut self, h: Handle<T>) -> Option<T> {
        let slot = self.slots.get_mut(h.index as usize)?;
        if slot.generation != h.generation {
            return None;
        }
        let value = slot.value.take()?;
        slot.generation = slot.generation.wrapping_add(1); // invalidate old handles
        self.free.push(h.index);
        self.len -= 1;
        Some(value)
    }

    pub fn get(&self, h: Handle<T>) -> Option<&T> {
        let slot = self.slots.get(h.index as usize)?;
        if slot.generation == h.generation { slot.value.as_ref() } else { None }
    }

    pub fn get_mut(&mut self, h: Handle<T>) -> Option<&mut T> {
        let slot = self.slots.get_mut(h.index as usize)?;
        if slot.generation == h.generation { slot.value.as_mut() } else { None }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Iterate over live values together with their handles.
    pub fn iter(&self) -> impl Iterator<Item = (Handle<T>, &T)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| {
            let h = Handle { index: i as u32, generation: s.generation, _marker: PhantomData };
            s.value.as_ref().map(|v| (h, v))
        })
    }
}

// ---- a tiny game using it ----

#[derive(Debug)]
struct Enemy {
    name: &'static str,
    hp: i32,
}

struct Missile {
    target: Handle<Enemy>,
    damage: i32,
}

fn main() {
    let mut enemies = Arena::new();
    let orc = enemies.insert(Enemy { name: "orc", hp: 30 });
    let bat = enemies.insert(Enemy { name: "bat", hp: 5 });

    let missiles = vec![
        Missile { target: orc, damage: 10 },
        Missile { target: bat, damage: 10 },
    ];

    // The orc dies before the missiles land, and a goblin spawns in its slot.
    enemies.remove(orc);
    let goblin = enemies.insert(Enemy { name: "goblin", hp: 12 });
    println!("orc was {orc:?}, goblin is {goblin:?}: same slot, new generation");

    for m in &missiles {
        match enemies.get_mut(m.target) {
            Some(e) => {
                e.hp -= m.damage;
                println!("hit {} -> hp {}", e.name, e.hp);
            }
            None => println!("missile aimed at {:?} lost its target", m.target),
        }
    }

    for (h, e) in enemies.iter() {
        println!("{h:?}: {e:?}");
    }
    println!("{} alive", enemies.len());
}
```

Run it. The missile aimed at the orc reports a lost target instead of hitting
the goblin that took the orc's memory.

Notice what the borrow checker is doing here, and what it is not doing:

- `missiles` holds handles, not references, so `enemies` is never frozen. You
  can insert and remove enemies while missiles exist.
- `get_mut` returns a short-lived `&mut Enemy`. *That* reference is checked as
  usual: you cannot keep it across a call to `enemies.insert`, which might
  reallocate the `Vec`. The borrow checker still protects you from the C++
  invalidation bug, at the moment of access.
- The arena is the single owner of every enemy. Dropping the arena drops them
  all, in one place.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood: cost and layout</span>

- A `Handle<T>` is 8 bytes and `Copy`. Compared with a 64-bit pointer it is
  the same size, survives reallocation, and can be serialized, saved to disk,
  or sent over the network, because it contains no address.
- Access costs one bounds check, one compare, and one load, all on the same
  cache line as the value. `Rc<RefCell<T>>` costs a separate heap allocation
  per object plus a runtime borrow flag.
- All enemies sit in one contiguous `Vec`, which is what you want for
  iteration in a system update.
- `Option<Handle<T>>` is 12 bytes here. If the generation starts at 1 and is
  stored as `NonZeroU32`, the compiler uses 0 as the `None` niche and
  `Option<Handle<T>>` becomes 8 bytes too. (That is exercise 2.)

</div>

## Comparing the options

| Need | C++ | Rust |
|---|---|---|
| Temporary access during a call | `T&`, `T*` | `&T`, `&mut T` |
| Single owner, heap allocated | `std::unique_ptr<T>` | `Box<T>` |
| Shared ownership, object lives while anyone holds it | `std::shared_ptr<T>` | `Rc<T>` / `Arc<T>` |
| Observe without keeping alive | `std::weak_ptr<T>` | `rc::Weak<T>` |
| Many objects of one type, referenced from many places, lifetime decided by game logic | object pool + handles, or raw pointers and care | `Arena<T>` + `Handle<T>` |

`Rc`/`Weak` work, and are the right answer for some structures (a shared
immutable asset, a UI tree). But for game objects whose lifetime is decided by
the game ("the enemy dies when its HP hits zero"), shared ownership is the
wrong model: nobody holding a reference should keep a dead enemy alive. The
arena makes the owner explicit, and handles make "it might be gone" explicit.

## Arenas of a different kind: bump allocation

"Arena" also names a second pattern you may know from C++ frame allocators:
allocate many small objects from one big block, then free the whole block at
once. In Rust this is the `bumpalo` crate. It hands out real references whose
lifetime is tied to the arena, so the borrow checker proves nothing outlives
the frame:

```rust,ignore
use bumpalo::Bump;

struct DrawCmd {
    mesh: u32,
    instance_count: u32,
}

fn build_frame(frame_alloc: &Bump) {
    // Both allocations live in the arena. The references cannot escape it:
    // their lifetime is tied to `frame_alloc`.
    let cmd: &mut DrawCmd = frame_alloc.alloc(DrawCmd { mesh: 7, instance_count: 1 });
    let visible: &mut [u32] = frame_alloc.alloc_slice_fill_copy(1024, 0);
    cmd.instance_count = visible.len() as u32;
}

fn main() {
    let mut frame_alloc = Bump::new();
    loop {
        build_frame(&frame_alloc);
        frame_alloc.reset(); // free everything from this frame, O(1)
        # break;
    }
}
```

Generational arenas are for long-lived objects with individual lifetimes. Bump
arenas are for short-lived scratch data with a shared lifetime. Engines use
both.

## Crates for real projects

Writing your own arena is a good exercise and fine for small projects. For
production, use a maintained crate:

- [`slotmap`](https://docs.rs/slotmap): the most widely used. `SlotMap` is
  the design above; `DenseSlotMap` keeps values packed for faster iteration;
  `SecondaryMap` attaches extra per-object data to existing keys, which is a
  small step toward ECS components.
- [`thunderdome`](https://docs.rs/thunderdome): a compact generational arena
  with 8-byte `Option<Index>`.
- [`bumpalo`](https://docs.rs/bumpalo): bump allocation, as above.

The next step from "an arena per object type, plus handles" is an
entity-component system, where the handle is the entity and each component
type has its own storage. That is the [next chapter](ecs.md).

## Exercises

1. Add `fn get2_mut(&mut self, a: Handle<T>, b: Handle<T>) -> Option<(&mut T, &mut T)>`
   that returns two distinct objects mutably (for a collision response, say).
   Hint: `split_at_mut` or `get_disjoint_mut` from the [borrowing
   chapter](../foundations/borrowing.md), and decide what to do when `a == b`.
2. Change `generation` to `NonZeroU32` starting at 1 and confirm with
   `std::mem::size_of::<Option<Handle<Enemy>>>()` that it shrinks to 8 bytes.
3. `remove` uses `wrapping_add`. After 2³² reuses of one slot, a very old
   handle could match again. Make a slot retire permanently (never return to
   the free list) when its generation would wrap. What does that cost?
4. Make `Arena::iter_mut` that yields `(Handle<T>, &mut T)`. Why can't it be
   written by calling `get_mut` in a loop?
