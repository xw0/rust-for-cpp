# Collections and strings

Rust's standard collections cover the STL containers you use daily, with the
same complexity guarantees and similar memory layouts. The differences are in
the API: no iterator pairs, no invalidation bugs, explicit capacity
management, and strings that are always UTF-8.

This chapter covers:

- `Vec<T>` and slices,
- `HashMap`, `BTreeMap`, `HashSet`, `VecDeque` and `BinaryHeap`,
- the entry API,
- `String` and `&str`, and why strings are not arrays of characters,
- other string types: `OsString`, `CString`, `Path`,
- choosing containers for engine workloads.

## The mapping

| STL | Rust | Notes |
|---|---|---|
| `std::vector<T>` | `Vec<T>` | Same layout: pointer, capacity, length |
| `std::array<T, N>` | `[T; N]` | Built-in type |
| `std::span<T>` | `&[T]` / `&mut [T]` | Built-in slice type |
| `std::deque<T>` | `VecDeque<T>` | A ring buffer, not chunked like `std::deque` |
| `std::list<T>` | `LinkedList<T>` | Exists; almost never the right choice |
| `std::unordered_map<K, V>` | `HashMap<K, V>` | Open addressing (SwissTable), much faster than node-based `unordered_map` |
| `std::unordered_set<T>` | `HashSet<T>` | |
| `std::map<K, V>` | `BTreeMap<K, V>` | A B-tree, not a red-black tree: better cache behavior |
| `std::set<T>` | `BTreeSet<T>` | |
| `std::priority_queue<T>` | `BinaryHeap<T>` | Max-heap |
| `std::string` | `String` | UTF-8 |
| `std::string_view` | `&str` | |

All of these live in `std::collections` except `Vec`, `String` and slices,
which are always in scope.

## `Vec<T>`

```rust
fn main() {
    let mut particles: Vec<[f32; 3]> = Vec::with_capacity(1024); // reserve up front
    for i in 0..4 {
        particles.push([i as f32, 0.0, 0.0]);
    }
    println!("len {} cap {}", particles.len(), particles.capacity());

    let last = particles.pop();                 // Option<[f32; 3]>
    particles.insert(0, [9.0; 3]);              // O(n), like vector::insert
    particles.swap_remove(1);                   // O(1): move the last element into the hole
    particles.retain(|p| p[0] < 5.0);           // erase-remove idiom in one call
    particles.extend([[7.0; 3], [8.0; 3]]);
    particles.sort_by(|a, b| a[0].total_cmp(&b[0]));
    particles.dedup();
    println!("{particles:?} popped {last:?}");

    let first_two = &particles[..2];            // a slice borrowing from the Vec
    let total: f32 = first_two.iter().map(|p| p[0]).sum();
    println!("{total}");

    particles.clear();                          // len 0, capacity kept
    particles.shrink_to_fit();
}
```

Things that differ from `std::vector`:

- **Elements move with `memcpy`** on reallocation; there are no move
  constructors to call and no `noexcept` question.
- **Indexing is bounds-checked** and panics when out of range. Use `.get(i)`
  for an `Option`, or iterate to avoid checks entirely. `get_unchecked` exists
  but is `unsafe`.
- **No invalidation bugs**: while you hold a reference into a `Vec`, the
  compiler will not let you push to it ([Borrowing](borrowing.md)).
- `Vec<bool>` is a normal vector of bytes. There is no bit-packing special case.
- `vec![value; n]` and `vec![a, b, c]` build vectors inline.

Most of the useful algorithms are methods on **slices**, so they work on
`Vec`, arrays and sub-ranges alike: `sort`, `sort_unstable`, `binary_search`,
`contains`, `iter().position`, `chunks`, `windows`, `split_at`, `rotate_left`,
`fill`, `copy_from_slice`, `reverse`.

## Maps and sets

```rust
use std::collections::{BTreeMap, HashMap, HashSet};

fn main() {
    let mut textures: HashMap<String, u32> = HashMap::new();
    textures.insert("brick".to_string(), 1);
    textures.insert("grass".to_string(), 2);

    // Lookup with &str even though keys are String (via the Borrow trait).
    if let Some(id) = textures.get("brick") {
        println!("brick is texture {id}");
    }
    println!("{:?}", textures.get("lava"));   // None, no default-constructed insert

    // The entry API: find-or-insert in one hash lookup.
    let mut refcounts: HashMap<&str, u32> = HashMap::new();
    for name in ["brick", "grass", "brick", "brick"] {
        *refcounts.entry(name).or_insert(0) += 1;
    }
    println!("{refcounts:?}");

    // Ordered map: iteration is sorted by key.
    let mut by_depth: BTreeMap<u32, Vec<&str>> = BTreeMap::new();
    by_depth.entry(3).or_default().push("tree");
    by_depth.entry(1).or_default().push("sky");
    by_depth.entry(3).or_default().push("rock");
    for (depth, names) in &by_depth {
        println!("{depth}: {names:?}");
    }
    // Range queries, like lower_bound/upper_bound:
    let near: Vec<_> = by_depth.range(..3).collect();
    println!("{near:?}");

    let visible: HashSet<u32> = [1, 2, 3].into_iter().collect();
    let lit: HashSet<u32> = [2, 3, 4].into_iter().collect();
    let both: Vec<_> = visible.intersection(&lit).collect();
    println!("{both:?}");
}
```

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

`map[key]` in C++ inserts a default value when the key is missing. In Rust,
`map[&key]` **panics** when the key is missing, and there is no implicit
insert. Use `get` to look up, `entry(key).or_default()` to find-or-insert, and
`insert` to overwrite.

</div>

The default `HashMap` uses SipHash, which resists denial-of-service attacks
from attacker-chosen keys but is slower than necessary for integer keys in a
game. Swap the hasher with a crate like `rustc-hash` (`FxHashMap`) or `ahash`
when the keys are trusted:

```rust,ignore
use rustc_hash::FxHashMap;
let mut by_entity: FxHashMap<u32, Transform> = FxHashMap::default();
```

## `VecDeque` and `BinaryHeap`

```rust
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

fn main() {
    // A ring buffer: frame-time history.
    let mut frame_times: VecDeque<f32> = VecDeque::with_capacity(4);
    for t in [16.6, 16.7, 33.3, 16.5, 16.8] {
        if frame_times.len() == 4 {
            frame_times.pop_front();
        }
        frame_times.push_back(t);
    }
    println!("{frame_times:?}");

    // A min-heap of (cost, node) for Dijkstra / A*: wrap in Reverse.
    let mut open = BinaryHeap::new();
    open.push(Reverse((5u32, "b")));
    open.push(Reverse((1, "a")));
    open.push(Reverse((3, "c")));
    while let Some(Reverse((cost, node))) = open.pop() {
        print!("{node}:{cost} ");
    }
    println!();
}
```

## Strings

Rust has two main string types:

- **`String`**: owned, growable, heap-allocated. Like `std::string`.
- **`&str`**: a borrowed view of string data, a pointer and a length. Like
  `std::string_view`. String literals are `&'static str`.

Both are **always valid UTF-8**. The compiler and the standard library enforce
it: every function that creates a `String` from bytes either validates them or
is `unsafe`.

```rust
fn shout(s: &str) -> String {          // take &str, return String: the usual pattern
    s.to_uppercase()
}

fn main() {
    let mut log = String::from("frame ");
    log.push_str("42");
    log += ": ok";
    let summary = format!("{log} ({} bytes)", log.len());

    let name: &str = "Ünïcödé";
    println!("{summary}");
    println!("{} bytes, {} chars", name.len(), name.chars().count());
    // let c = name[0];            // error: strings cannot be indexed by integer
    println!("{:?}", name.chars().nth(1));
    println!("{}", &name[0..2]);   // byte range: must fall on char boundaries, or it panics
    println!("{}", shout("hello"));

    for word in "load mesh  brick.obj".split_whitespace() {
        print!("[{word}]");
    }
    println!();
    let path = "assets/textures/brick.png";
    if let Some((dir, file)) = path.rsplit_once('/') {
        println!("{dir} | {file} | {}", file.ends_with(".png"));
    }
}
```

Why no `s[i]`? Because in UTF-8 a character is one to four bytes, so "the i-th
character" is an O(n) scan and "the i-th byte" may be half a character. Rust
makes you say which you mean: `s.as_bytes()[i]` for bytes, `s.chars()` for
Unicode scalar values. For ASCII-only data (like many file formats), work on
`&[u8]` and byte literals `b"..."`.

Take `&str` in function parameters, not `&String`: a `&String` coerces to
`&str` automatically, and literals are already `&str`.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

`String` is literally a `Vec<u8>` with a UTF-8 guarantee: pointer, capacity,
length, 24 bytes. There is **no small-string optimization**, so every
non-empty `String` allocates. If you build many tiny strings (entity names,
debug labels), consider interning them into IDs, or crates like `smol_str` or
`compact_str`.

</div>

### Other string types

Text from the operating system or a C API is not necessarily UTF-8, so it has
its own types:

| Type | Owned | Use |
|---|---|---|
| `&str` | `String` | Rust text, always UTF-8 |
| `&OsStr` | `OsString` | Platform strings: environment variables, OS APIs (UTF-16 on Windows) |
| `&Path` | `PathBuf` | File paths; a thin wrapper over `OsStr` with path methods |
| `&CStr` | `CString` | NUL-terminated C strings for FFI |
| `&[u8]` | `Vec<u8>` | Raw bytes |

```rust
use std::ffi::CString;
use std::path::{Path, PathBuf};

fn main() {
    let mut p = PathBuf::from("assets");
    p.push("shaders");
    p.push("lit.frag");
    println!("{} ext={:?} stem={:?}", p.display(), p.extension(), p.file_stem());
    println!("{}", Path::new("a/b/../c.txt").parent().unwrap().display());

    let name = CString::new("u_model_matrix").unwrap(); // adds the NUL, rejects interior NULs
    let ptr: *const std::ffi::c_char = name.as_ptr();    // what glGetUniformLocation wants
    println!("{ptr:?}");
}
```

## Containers for engine workloads

- **`Vec<T>` first.** As in C++, a contiguous array beats everything for
  iteration. Use `swap_remove` for O(1) unordered removal.
- **Fixed capacity, no heap:** `[T; N]` plus a length, or the `arrayvec` crate.
- **Usually small, sometimes big:** `smallvec::SmallVec<[T; 8]>` stores up to
  eight elements inline, like LLVM's `SmallVector`.
- **Stable handles into a growing pool:** a slot map or generational arena
  ([Handles and arenas](../engine/handles-and-arenas.md)).
- **Integer keys:** `FxHashMap`, or a plain `Vec<Option<T>>` indexed by ID when
  IDs are dense.
- **Per-frame scratch memory:** a bump allocator (`bumpalo`), reset each frame.

## Summary

| C++ | Rust |
|---|---|
| `v[i]` (unchecked) / `v.at(i)` | `v[i]` (checked, panics) / `v.get(i)` (Option) |
| `v.reserve(n)` | `Vec::with_capacity(n)` / `v.reserve(n)` |
| Erase-remove idiom | `v.retain(...)` |
| `map[key]` inserts | `map.entry(key).or_default()`; `map[&key]` panics if missing |
| `map.find(k) != map.end()` | `map.get(&k)` returns `Option` |
| `std::string` (bytes, any encoding) | `String` (UTF-8) |
| `s[i]` | `s.as_bytes()[i]` or `s.chars().nth(i)` |
| `std::filesystem::path` | `PathBuf` / `&Path` |
| `c_str()` | `CString::new(..)?.as_ptr()` |

## Exercises

1. Count word frequencies in a paragraph with a `HashMap<&str, usize>` and the
   entry API, then print the five most common words sorted by count.
2. Write `fn split_extension(path: &str) -> (&str, Option<&str>)` that returns
   the path without its extension and the extension. What lifetime do the
   returned slices have?
3. Implement a fixed-size ring buffer of the last 120 frame times with
   `VecDeque`, and compute the average and the 99th percentile.
