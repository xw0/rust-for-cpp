# Unsafe Rust

Everything so far has been **safe Rust**: code in which the compiler
guarantees no undefined behavior. Some code cannot be checked by the compiler:
calling C functions, talking to hardware, implementing a new collection on raw
memory, using SIMD intrinsics. For those, Rust has the `unsafe` keyword. As a
C++ programmer you will find `unsafe` Rust familiar, since it is roughly what
you write every day, but the rules are stricter than you might expect, and the
way it is used is very different.

This chapter covers:

- what `unsafe` allows, and what it does not switch off,
- raw pointers,
- what counts as undefined behavior in Rust, especially aliasing,
- building safe abstractions on top of unsafe code,
- Miri, an interpreter that finds undefined behavior in tests.

## What `unsafe` unlocks

An `unsafe` block or function lets you do five extra things:

1. Dereference a raw pointer (`*const T`, `*mut T`).
2. Call an `unsafe` function, including all foreign (C) functions.
3. Access or modify a mutable `static`.
4. Implement an `unsafe` trait (such as `Send`, `Sync`, `GlobalAlloc`).
5. Access the fields of a `union`.

That is the whole list. Inside `unsafe`, the borrow checker, type checker and
bounds checks still run as usual. `unsafe` does not mean "turn off the
checks"; it means "I am doing one of these five things, and **I** promise the
invariants the compiler cannot verify".

```rust
fn main() {
    let mut values = [1u32, 2, 3, 4];
    let p: *mut u32 = values.as_mut_ptr();   // creating a raw pointer is safe

    unsafe {
        // Dereferencing it is not: we promise p+2 is in bounds and valid.
        *p.add(2) = 30;
        let second = p.add(1).read();
        println!("{second}");
    }
    println!("{values:?}");
}
```

## Raw pointers

`*const T` and `*mut T` are C pointers: they can be null, dangling,
unaligned, and they alias freely. Creating, copying and comparing them is safe;
only reading or writing through them requires `unsafe`. Convert between
references and raw pointers explicitly:

```rust
fn main() {
    let x = 5u64;
    let r: &u64 = &x;
    let p: *const u64 = r;                 // reference -> pointer: safe, implicit coercion
    let p2 = &raw const x;                 // or take the address directly
    let back: &u64 = unsafe { &*p };       // pointer -> reference: unsafe
    println!("{} {} {}", back, p == p2, p.is_null());

    // Pointer arithmetic is in elements, like C:
    let arr = [10u16, 20, 30];
    let q = arr.as_ptr();
    let third = unsafe { *q.add(2) };
    let byte_offset = unsafe { (q.add(2) as *const u8).offset_from(q as *const u8) };
    println!("{third} {byte_offset}");
}
```

## Undefined behavior in Rust

Rust's list of undefined behavior overlaps with C++'s, with some notable
differences. The ones that matter most:

- Dereferencing a dangling, null or misaligned pointer.
- Reading uninitialized memory (use `MaybeUninit<T>` for memory that starts
  uninitialized).
- Producing an invalid value: a `bool` that is not 0 or 1, an enum with an
  invalid discriminant, a null reference, a `char` that is not a Unicode
  scalar value, a `&str` that is not UTF-8. In C++ the bad `bool` is UB only
  when used; in Rust **creating** it is already UB.
- Data races.
- **Breaking the aliasing rules of references.**

The last one is the big difference. In C++, the main aliasing rule is
*strict aliasing*: pointers to different types are assumed not to alias. Rust
has no type-based aliasing rule at all (you may freely cast a `*mut f32` to
`*mut u32`), but it has a much stronger rule about references:

- While a `&mut T` is live, no other pointer or reference may access that
  memory.
- While a `&T` is live, the memory must not be written (except inside an
  `UnsafeCell`, which is what `Cell`, `RefCell` and `Mutex` are built on).

These are the same guarantees the borrow checker enforces in safe code, and the
optimizer relies on them (it is how `&mut` becomes `noalias`). In unsafe code
you can create two `&mut` to the same memory from raw pointers, and if you do,
the program is undefined even if it seems to work:

```rust,no_run
fn main() {
    let mut x = 0i32;
    let p = &raw mut x;
    unsafe {
        let a = &mut *p;
        let b = &mut *p;   // UB: two live &mut to the same i32
        *a += 1;
        *b += 1;
    }
}
```

The rule of thumb: **in unsafe code, work with raw pointers, and only create
references when you can guarantee the borrow rules for their whole lifetime.**

## Safe abstractions over unsafe code

The point of `unsafe` in Rust is not to write unsafe programs. It is to write a
small, carefully reviewed unsafe core and wrap it in a safe API, so that no
caller, however wrong, can cause undefined behavior. The standard library is
built this way: `Vec`, `HashMap`, `Rc` and `Mutex` all contain unsafe code, and
none of their public safe methods can be misused into UB.

Here is a small example: a fixed-capacity, stack-allocated vector (like
`boost::static_vector`), built on uninitialized memory.

```rust
use std::mem::MaybeUninit;

pub struct StackVec<T, const N: usize> {
    len: usize,
    items: [MaybeUninit<T>; N],  // invariant: items[..len] are initialized
}

impl<T, const N: usize> StackVec<T, N> {
    pub fn new() -> Self {
        StackVec { len: 0, items: [const { MaybeUninit::uninit() }; N] }
    }

    pub fn push(&mut self, value: T) -> Result<(), T> {
        if self.len == N {
            return Err(value);           // full: give the value back
        }
        self.items[self.len].write(value);
        self.len += 1;
        Ok(())
    }

    pub fn pop(&mut self) -> Option<T> {
        if self.len == 0 {
            return None;
        }
        self.len -= 1;
        // SAFETY: items[len] was initialized (it was below the old len),
        // and decrementing len first means we never read it again.
        Some(unsafe { self.items[self.len].assume_init_read() })
    }

    pub fn as_slice(&self) -> &[T] {
        // SAFETY: items[..len] are initialized, and MaybeUninit<T> has the same layout as T.
        unsafe { std::slice::from_raw_parts(self.items.as_ptr() as *const T, self.len) }
    }
}

impl<T, const N: usize> Drop for StackVec<T, N> {
    fn drop(&mut self) {
        while self.pop().is_some() {}   // drop the initialized elements
    }
}

fn main() {
    let mut v: StackVec<String, 4> = StackVec::new();
    for w in ["a", "b", "c", "d", "e"] {
        if let Err(rejected) = v.push(w.to_string()) {
            println!("full, rejected {rejected}");
        }
    }
    println!("{:?}", v.as_slice());
    println!("{:?}", v.pop());
}
```

Notice the pattern:

- The **invariant** (`items[..len]` are initialized) is written down and
  maintained by every method.
- Each `unsafe` block has a `// SAFETY:` comment saying why the invariant
  makes it sound. This is a strong convention in Rust code reviews, and Clippy
  can require it (`clippy::undocumented_unsafe_blocks`).
- The fields are private, so code outside the module cannot break the
  invariant. Privacy is what makes the abstraction safe.
- The public API is entirely safe. Callers cannot misuse it into UB.

When reviewing Rust code, you audit the `unsafe` blocks and the module that
contains them. Everything else is checked by the compiler. In a C++ code
review, every line is potentially unsafe.

## Miri: finding UB in tests

[Miri](https://github.com/rust-lang/miri) is an interpreter for Rust's
mid-level IR that checks every memory access against the rules above: use
after free, out-of-bounds, uninitialized reads, invalid values, and aliasing
violations. It is like running AddressSanitizer, MemorySanitizer and
UBSan together, with an aliasing checker none of them have:

```sh
rustup +nightly component add miri
cargo +nightly miri test
```

Run your test suite under Miri for any crate that contains `unsafe` code. It is
slow (100 times or more), so run it on unit tests, not your game. On the
Playground, **Tools → Miri** runs it on the current example; try it on the
"two `&mut`" program above.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Real engines written in Rust contain unsafe code in a few well-defined places:
FFI to graphics APIs, SIMD intrinsics, custom allocators, lock-free queues, and
ECS storage. The rest, usually more than 95% of the code, is safe. Aim for the
same: concentrate `unsafe` into small modules with clear invariants and safe
interfaces, and keep game code free of it.

</div>

## Summary

| C++ | Rust |
|---|---|
| Every line may have UB | UB only possible inside `unsafe` (and the code it relies on) |
| `T*` | `*const T` / `*mut T` |
| Strict aliasing (type-based) | No type-based rule; `&mut` is exclusive, `&` is read-only |
| `std::launder`, placement new, uninitialized storage | `MaybeUninit<T>` |
| `reinterpret_cast` | `as` between raw pointers; `std::mem::transmute` |
| ASan / MSan / UBSan | Miri (plus the sanitizers, which also work) |
| Comments explaining why a cast is OK | `// SAFETY:` comments, linted |

## Exercises

1. Run the "two `&mut`" program under Miri on the Playground and read the
   report. Rewrite it to use only the raw pointer `p` for both increments.
   Does Miri accept it?
2. Add an `fn as_mut_slice(&mut self) -> &mut [T]` and an `fn clear(&mut self)`
   to `StackVec`, with `SAFETY` comments.
3. `StackVec::pop` decrements `len` *before* reading. What could go wrong if it
   read first and the element's `Drop` panicked later? (Hint: think about what
   `Drop for StackVec` would then do.)
