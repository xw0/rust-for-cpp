# Threads, locks and Send/Sync

Rust's threads are OS threads, its atomics follow the C++11 memory model, and
its mutex is a thin wrapper over the platform's lock. Nothing here is new to
you. What is new is that **data races are compile errors**. The same ownership
and borrowing rules that prevent use-after-free also prevent two threads from
touching the same data without synchronization, and two marker traits, `Send`
and `Sync`, extend the rules across threads.

This chapter covers:

- spawning threads, and scoped threads that can borrow,
- `Send` and `Sync`,
- `Mutex<T>`: a lock that owns its data,
- `RwLock`, `Condvar`, atomics and memory ordering,
- channels,
- data parallelism with rayon, the job system you do not have to write.

## Spawning threads

```rust
use std::thread;

fn main() {
    let handles: Vec<_> = (0..4)
        .map(|id| {
            thread::spawn(move || {
                let sum: u64 = (id * 1000..(id + 1) * 1000).sum();
                sum                              // the thread's return value
            })
        })
        .collect();

    let total: u64 = handles.into_iter().map(|h| h.join().unwrap()).sum();
    println!("{total}");
}
```

`thread::spawn` takes a closure and returns a `JoinHandle`, like `std::thread`
returning a future-like handle. The closure must be `'static` (it may outlive
the caller), so it must own what it uses: hence `move`. (`|| { ... }` is a
closure with no parameters, and `move` makes it capture by value; see
[Closures](../foundations/closures-and-iterators.md#closures).) A `JoinHandle` that is
dropped without `join` **detaches** the thread rather than calling
`std::terminate` like an unjoined `std::thread`.

### Scoped threads

Often you want threads that work on data owned by the caller and finish before
the caller returns, the fork-join pattern. `thread::scope` guarantees all
threads spawned inside it are joined at the end of the scope, so they are
allowed to **borrow** local data:

```rust
use std::thread;

fn main() {
    let mut pixels = vec![0u32; 1920 * 1080];
    let width = 1920;

    thread::scope(|s| {
        // Split the image into 8 horizontal bands, one thread each.
        for (band, rows) in pixels.chunks_mut(width * 1080 / 8).enumerate() {
            s.spawn(move || {
                for (i, p) in rows.iter_mut().enumerate() {
                    *p = (band as u32) << 24 | (i % width) as u32;
                }
            });
        }
    }); // all threads joined here

    println!("{:#x} {:#x}", pixels[0], pixels[pixels.len() - 1]);
}
```

Each thread gets a `&mut` to a disjoint band from `chunks_mut`, so the borrow
checker can see there is no overlap. Try giving two threads the same band and
the program will not compile.

## `Send` and `Sync`

Two marker traits, implemented automatically by the compiler, describe what
may cross thread boundaries:

- **`Send`**: a value of this type can be **moved** to another thread.
- **`Sync`**: a value of this type can be **shared** between threads by
  reference (`T` is `Sync` if `&T` is `Send`).

Almost everything is both: integers, `String`, `Vec<T>` (if `T` is), your own
structs made of such fields. The exceptions are the types whose correctness
depends on not being shared:

| Type | `Send` | `Sync` | Why |
|---|---|---|---|
| `Rc<T>` | no | no | Non-atomic reference count |
| `Arc<T>` | yes* | yes* | Atomic count (*if `T` is `Send + Sync`) |
| `Cell<T>`, `RefCell<T>` | yes | no | Unsynchronized interior mutability |
| `Mutex<T>` | yes* | yes* | Locking makes shared access safe (*if `T: Send`) |
| Raw pointers `*const T`, `*mut T` | no | no | The compiler cannot know; you assert it with `unsafe impl` |

`thread::spawn` requires its closure to be `Send`. So this fails to compile,
where the C++ equivalent with `shared_ptr` and a non-atomic member races at run
time:

```rust,compile_fail
use std::rc::Rc;
use std::thread;

fn main() {
    let config = Rc::new(String::from("high"));
    let c = Rc::clone(&config);
    thread::spawn(move || {
        println!("{c}");   // error[E0277]: `Rc<String>` cannot be sent between threads safely
    });
}
```

Replace `Rc` with `Arc` and it compiles.

## `Mutex<T>`: the lock owns the data

In C++, a mutex sits *next to* the data it protects, and a comment says which
fields it guards. Nothing stops code from touching the data without the lock.

<div class="rfc-compare">
<div class="rfc-cpp">

C++

```cpp
struct Stats {
    std::mutex m;          // protects frames, dropped
    uint64_t frames = 0;
    uint64_t dropped = 0;
};

void on_frame(Stats& s, bool late) {
    std::lock_guard lock(s.m);
    ++s.frames;
    if (late) ++s.dropped;
}
// Elsewhere: s.frames++;  // compiles, races
```

</div>
<div class="rfc-rust">

Rust

```rust
use std::sync::Mutex;

struct Counts {
    frames: u64,
    dropped: u64,
}

struct Stats {
    counts: Mutex<Counts>,   // the only way in is lock()
}

fn on_frame(s: &Stats, late: bool) {
    let mut c = s.counts.lock().unwrap();
    c.frames += 1;
    if late {
        c.dropped += 1;
    }
}   // guard dropped: unlocked
# fn main() {
#     let s = Stats { counts: Mutex::new(Counts { frames: 0, dropped: 0 }) };
#     on_frame(&s, true);
#     println!("{}", s.counts.lock().unwrap().dropped);
# }
```

</div>
</div>

`Mutex<T>` **contains** the `T`. The only way to reach it is `lock()`, which
returns a guard that dereferences to `&mut T` and unlocks when dropped, like
`std::lock_guard` fused with the data. The guard borrows the mutex, so you
cannot keep a reference to the data after unlocking: that would be a borrow
outliving its owner, and it does not compile.

`lock()` returns a `Result` because of **poisoning**: if a thread panicked while
holding the lock, the data may be half-updated, and later lockers get an error
they can inspect. `unwrap()` (propagate the panic) is the usual response.

Sharing a mutex among threads uses `Arc`:

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..4)
        .map(|id| {
            let log = Arc::clone(&log);
            thread::spawn(move || {
                for job in 0..3 {
                    log.lock().unwrap().push(format!("worker {id} job {job}"));
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    println!("{} entries", log.lock().unwrap().len());
}
```

The borrow checker prevents data races. It does **not** prevent deadlocks or
logic races (check-then-act across two separate locks). Lock ordering is still
your job.

## Other primitives

| C++ | Rust | Notes |
|---|---|---|
| `std::shared_mutex` | `RwLock<T>` | `read()` and `write()` guards |
| `std::condition_variable` | `Condvar` | Used with a `MutexGuard` |
| `std::call_once`, function-local static | `OnceLock<T>`, `LazyLock<T>` | Thread-safe lazy initialization |
| `std::atomic<int>` etc. | `AtomicI32`, `AtomicU64`, `AtomicBool`, `AtomicPtr<T>` | Methods take an `Ordering` |
| `std::memory_order_relaxed` … `seq_cst` | `Ordering::Relaxed`, `Acquire`, `Release`, `AcqRel`, `SeqCst` | The same C++11 model (minus `consume`) |
| `std::barrier`, `std::latch` | `Barrier` | |

```rust
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::thread;

static NEXT_ENTITY: AtomicU32 = AtomicU32::new(1);       // no Mutex needed
static SHADER_DIR: LazyLock<String> = LazyLock::new(|| "assets/shaders".to_string());

fn new_entity() -> u32 {
    NEXT_ENTITY.fetch_add(1, Ordering::Relaxed)            // unique IDs: relaxed is enough
}

fn main() {
    // Publish a result from one thread to another: release/acquire, as in C++.
    let result = AtomicU64::new(0);
    let ready = AtomicBool::new(false);
    thread::scope(|s| {
        s.spawn(|| {
            result.store(42, Ordering::Relaxed);
            ready.store(true, Ordering::Release);          // everything before is visible...
        });
        while !ready.load(Ordering::Acquire) {             // ...to whoever sees `true` here
            std::hint::spin_loop();
        }
        println!("result {}", result.load(Ordering::Relaxed));
    });

    let ids: Vec<u32> = (0..3).map(|_| new_entity()).collect();
    println!("{ids:?} {}", *SHADER_DIR);
}
```

Atomics and their orderings behave exactly as in C++. If you know the C++
memory model, you know Rust's. Mara Bos's *Rust Atomics and Locks* is the
in-depth reference.

## Channels

Message passing is often simpler than shared state. `std::sync::mpsc` is a
multi-producer, single-consumer queue:

```rust
use std::sync::mpsc;
use std::thread;

enum LoadResult {
    Mesh { name: String, triangles: u32 },
    Failed(String),
}

fn main() {
    let (tx, rx) = mpsc::channel();
    for name in ["rock", "tree", "missing"] {
        let tx = tx.clone();
        thread::spawn(move || {
            let msg = if name == "missing" {
                LoadResult::Failed(name.into())
            } else {
                LoadResult::Mesh { name: name.into(), triangles: name.len() as u32 * 1000 }
            };
            tx.send(msg).unwrap();   // ownership of msg moves to the receiver
        });
    }
    drop(tx); // close our copy so the loop below ends when all senders are done

    for msg in rx {
        match msg {
            LoadResult::Mesh { name, triangles } => println!("loaded {name}: {triangles} tris"),
            LoadResult::Failed(name) => println!("failed: {name}"),
        }
    }
}
```

Sending moves the value: the sender can no longer touch it, so no locking is
needed for the payload. For multi-consumer queues, select, and better
performance, the `crossbeam-channel` crate is the common choice.

## Data parallelism with rayon

Most engine parallelism is "do this for every element, in parallel": cull
objects, skin meshes, update particles. The `rayon` crate turns an iterator
chain into a parallel one by changing `iter()` to `par_iter()`, running it on a
work-stealing thread pool:

```rust,ignore
use rayon::prelude::*;

fn update_particles(ps: &mut [Particle], dt: f32) {
    ps.par_iter_mut().for_each(|p| {        // split across all cores
        p.velocity += GRAVITY * dt;
        p.position += p.velocity * dt;
    });
}

fn visible(objects: &[Object], frustum: &Frustum) -> Vec<u32> {
    objects
        .par_iter()
        .filter(|o| frustum.intersects(&o.bounds))
        .map(|o| o.id)
        .collect()                           // order is preserved
}

// Fork-join: run two independent jobs in parallel.
let (shadows, gbuffer) = rayon::join(|| record_shadow_pass(&scene), || record_gbuffer(&scene));
```

The borrow rules make this safe: `par_iter_mut` hands each worker a disjoint
`&mut` element, and a closure that tried to write to shared state without
synchronization would not compile. This is the job system a C++ engine spends
months building and debugging, as a library.

## Summary

| C++ | Rust |
|---|---|
| `std::thread` | `std::thread::spawn` (requires `'static` + `Send`) |
| Fork-join over local data | `std::thread::scope` |
| Data race (UB, found by TSan) | Compile error |
| `std::mutex` beside the data | `Mutex<T>` containing the data |
| `std::lock_guard` | `MutexGuard`, returned by `lock()` |
| `shared_ptr<T>` across threads | `Arc<T>` |
| `std::atomic<T>` | `AtomicXxx` with explicit `Ordering` |
| Hand-written job system / TBB | `rayon` |

## Exercises

1. Write a scoped-thread version of a parallel sum over a `Vec<f32>`, splitting
   it into one chunk per available core (`std::thread::available_parallelism`).
2. Make the `Stats` example count per-thread with `AtomicU64`s instead of a
   mutex. Which `Ordering` is enough, and why?
3. Build a tiny job queue: a `Mutex<VecDeque<Box<dyn FnOnce() + Send>>>` with a
   `Condvar`, and four worker threads that run jobs until a shutdown flag is set.
