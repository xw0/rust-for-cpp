# Operator overloading and conversions

C++ lets you overload almost any operator and define implicit conversions in
two directions (converting constructors and conversion operators). Rust allows
overloading a fixed set of operators through traits, and has **no implicit
conversions** between your types at all. Every conversion is a named call. The
result is a little more typing and much less surprise.

This chapter covers:

- overloading arithmetic, indexing and compound assignment for a math type,
- `Copy` and `Clone` in detail,
- comparison traits, and why floats are awkward,
- `From`, `Into`, `TryFrom` and `AsRef` in place of conversion constructors,
- `Deref`, and why it is not a general conversion operator,
- `Display` and `Debug` in place of `operator<<`.

## Arithmetic operators

Each operator maps to a trait in `std::ops`. `a + b` is sugar for
`Add::add(a, b)`:

```rust
use std::ops::{Add, AddAssign, Index, IndexMut, Mul, Neg, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

impl Vec3 {
    const fn new(x: f32, y: f32, z: f32) -> Self { Vec3 { x, y, z } }
    fn dot(self, o: Vec3) -> f32 { self.x * o.x + self.y * o.y + self.z * o.z }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 { Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z) }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 { Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z) }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 { Vec3::new(-self.x, -self.y, -self.z) }
}

// Vec3 * f32
impl Mul<f32> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f32) -> Vec3 { Vec3::new(self.x * s, self.y * s, self.z * s) }
}

// f32 * Vec3: the left operand's type picks the impl, so this needs its own.
impl Mul<Vec3> for f32 {
    type Output = Vec3;
    fn mul(self, v: Vec3) -> Vec3 { v * self }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) { *self = *self + o; }
}

impl Index<usize> for Vec3 {
    type Output = f32;
    fn index(&self, i: usize) -> &f32 {
        match i {
            0 => &self.x,
            1 => &self.y,
            2 => &self.z,
            _ => panic!("Vec3 index {i} out of range"),
        }
    }
}

impl IndexMut<usize> for Vec3 {
    fn index_mut(&mut self, i: usize) -> &mut f32 {
        match i {
            0 => &mut self.x,
            1 => &mut self.y,
            2 => &mut self.z,
            _ => panic!("Vec3 index {i} out of range"),
        }
    }
}

fn main() {
    let gravity = Vec3::new(0.0, -9.81, 0.0);
    let mut velocity = Vec3::new(1.0, 5.0, 0.0);
    let dt = 1.0 / 60.0;
    velocity += gravity * dt;
    let reflected = velocity - 2.0 * velocity.dot(Vec3::new(0.0, 1.0, 0.0)) * Vec3::new(0.0, 1.0, 0.0);
    velocity[0] = 0.5;
    println!("{velocity:?} {reflected:?} {}", -gravity[1]);
}
```

What you can overload: `+ - * / %`, the bitwise operators `& | ^ ! << >>`,
unary `-`, their compound-assignment forms (`+=` and so on), indexing `[]`,
and dereference `*` (through `Deref`, below). Comparisons come from
`PartialEq` and `PartialOrd`.

What you cannot overload: `&&`, `||`, assignment `=`, the comma, `->`, `new`,
function call `()` on your own types (closures fill that role), and
conversion operators. There is no operator to overload for a copy, either:
`Copy` types are always copied bit for bit.

<div class="rfc-callout rfc-under-the-hood">
<span class="rfc-callout-title">Under the hood</span>

`Add` takes `self` by value. For small `Copy` types like `Vec3` that is ideal,
since they are passed in registers. For large types (a 4x4 matrix is 64 bytes)
it is common to also implement `Add<&Mat4> for &Mat4` so `&a + &b` avoids
copies, though in practice the optimizer usually removes them either way.
Check the assembly before you complicate the API.

</div>

## Copy and Clone

[Ownership](ownership.md) introduced these; here are the details:

- `Clone` is an explicit, possibly expensive duplicate: `let b = a.clone();`.
  You can implement it by hand or derive it, which clones each field.
- `Copy` is a marker that says "duplicating my bytes is a valid copy". It
  changes assignment and argument passing from a move to a copy. `Copy`
  requires `Clone`, and you cannot customize it: a `Copy` type's clone must be
  a plain bitwise copy.
- A type can be `Copy` only if all its fields are `Copy`, and it does not
  implement `Drop`.

So a Rust `Copy` type is what C++ calls *trivially copyable*, and there is no
way to write a type with an expensive implicit copy, like `std::string`. The
copy-constructor bugs (slicing, accidental deep copies in a range-for, copying
a `std::vector` into a lambda) do not have a Rust counterpart.

## Comparisons

| Trait | Operators | Meaning |
|---|---|---|
| `PartialEq` | `==`, `!=` | Equality that may not be reflexive (`NaN != NaN`) |
| `Eq` | (none) | Marker: equality is a true equivalence relation |
| `PartialOrd` | `<`, `<=`, `>`, `>=` | Ordering where some pairs are incomparable |
| `Ord` | (none) | Marker + `cmp`: a total order |
| `Hash` | (none) | Hashing consistent with `Eq` |

`#[derive(PartialEq, Eq, PartialOrd, Ord, Hash)]` compares field by field in
declaration order, like C++20's defaulted `operator<=>`.

The split exists because of floating point. `f32` is `PartialEq` and
`PartialOrd` but not `Eq` or `Ord`, so APIs that need a total order reject it:

```rust
fn main() {
    let mut depths = vec![3.5f32, -1.0, 2.25, 0.0];
    // depths.sort();                        // error: f32 is not Ord
    depths.sort_by(|a, b| a.total_cmp(b));   // IEEE totalOrder: NaNs sort to the ends
    println!("{depths:?}");

    let closest = depths.iter().copied().fold(f32::INFINITY, f32::min);
    println!("{closest}");

    // Hashing floats: store the bits, deciding explicitly what -0.0 and NaN mean.
    use std::collections::HashSet;
    let set: HashSet<u32> = depths.iter().map(|d| d.to_bits()).collect();
    println!("{} unique depths", set.len());
}
```

In C++ sorting a `std::vector<float>` containing a NaN with `std::sort` is
undefined behavior (it breaks the strict weak ordering requirement). In Rust the
type system makes you choose.

## Conversions: From, Into, TryFrom

C++ conversions are often implicit: a single-argument constructor converts
unless marked `explicit`, and `operator T()` converts out. Rust replaces all of
that with traits you call by name:

```rust
use std::convert::TryFrom;

#[derive(Debug, Clone, Copy)]
struct Rgba8([u8; 4]);

#[derive(Debug, Clone, Copy)]
struct LinearColor { r: f32, g: f32, b: f32, a: f32 }

// From: an infallible conversion. Implementing it gives you Into for free.
impl From<Rgba8> for LinearColor {
    fn from(c: Rgba8) -> Self {
        let f = |v: u8| (v as f32 / 255.0).powf(2.2);
        LinearColor { r: f(c.0[0]), g: f(c.0[1]), b: f(c.0[2]), a: c.0[3] as f32 / 255.0 }
    }
}

// TryFrom: a conversion that can fail.
impl TryFrom<&str> for Rgba8 {
    type Error = String;
    fn try_from(hex: &str) -> Result<Self, Self::Error> {
        let hex = hex.strip_prefix('#').ok_or("missing #")?;
        if hex.len() != 8 {
            return Err(format!("expected 8 hex digits, got {}", hex.len()));
        }
        let mut out = [0u8; 4];
        for i in 0..4 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
        }
        Ok(Rgba8(out))
    }
}

fn set_clear_color(c: impl Into<LinearColor>) {
    let c: LinearColor = c.into();
    println!("clear {c:?}");
}

fn main() {
    let orange = Rgba8::try_from("#ff8000ff").unwrap();
    let linear = LinearColor::from(orange);   // explicit
    let also: LinearColor = orange.into();     // same thing, type from context
    set_clear_color(orange);                   // generic over anything convertible
    println!("{linear:?} {also:?} {:?}", Rgba8::try_from("ff8000"));
}
```

Taking `impl Into<T>` in a parameter is the Rust way to get the convenience of
an implicit conversion: callers can pass either a `T` or anything that converts
to one. It is still visible in the signature.

Other common conversion traits:

| Trait | Use |
|---|---|
| `AsRef<T>` | Cheap reference conversion: `fn open(p: impl AsRef<Path>)` accepts `&str`, `String`, `PathBuf`… |
| `Borrow<T>` | Like `AsRef`, used by `HashMap::get` so a `HashMap<String, _>` can be queried with `&str` |
| `ToOwned` | Borrowed to owned: `&str` → `String`, `&[T]` → `Vec<T>` |
| `FromStr` | Parsing: `"42".parse::<i32>()` |
| `Default` | A default value, like a default constructor |

## Deref: smart pointers, not conversions

`Deref` overloads unary `*` and lets method calls see through a wrapper. It is
how `Box<T>`, `Rc<T>`, `String` (to `str`) and `Vec<T>` (to `[T]`) work:

```rust
use std::ops::Deref;

/// A Vec that is guaranteed to be sorted.
struct SortedVec(Vec<i32>);

impl SortedVec {
    fn new(mut v: Vec<i32>) -> Self {
        v.sort();
        SortedVec(v)
    }
}

impl Deref for SortedVec {
    type Target = [i32];      // read-only access to the elements as a slice
    fn deref(&self) -> &[i32] {
        &self.0
    }
}

fn main() {
    let s = SortedVec::new(vec![5, 1, 4]);
    println!("{} {:?} {:?}", s.len(), s.first(), s.binary_search(&4)); // slice methods
}
```

Note what is *not* implemented: `DerefMut`. Users can read the slice but cannot
get a `&mut [i32]` and break the sorted invariant.

When the compiler sees `&SortedVec` where `&[i32]` is expected, it inserts the
`deref` call (**deref coercion**). That is the only implicit conversion in Rust,
and it applies only to references. Use `Deref` for pointer-like wrappers. Do
not use it to fake inheritance (`struct Player { base: Entity }` with
`Deref<Target = Entity>`): it confuses readers and stops working as soon as
you need trait implementations.

## Display and Debug instead of `operator<<`

Printing is two traits:

- `Debug` (`{:?}`, pretty-printed with `{:#?}`) is for developers. Derive it on
  almost every type.
- `Display` (`{}`) is for users. Implement it by hand when a type has a natural
  textual form.

```rust
use std::fmt;

#[derive(Debug)]
struct Mat2([[f32; 2]; 2]);

impl fmt::Display for Mat2 {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let p = f.precision().unwrap_or(2);   // honor {:.3}
        for row in &self.0 {
            writeln!(f, "[{:>8.p$} {:>8.p$}]", row[0], row[1], p = p)?;
        }
        Ok(())
    }
}

fn main() {
    let m = Mat2([[1.0, 0.5], [-0.25, 2.0]]);
    print!("{m}");
    print!("{m:.4}");
    println!("{m:?}");
}
```

Implementing `Display` also gives you `.to_string()` for free.

## Summary

| C++ | Rust |
|---|---|
| `operator+` member or free function | `impl Add for T` |
| `operator+=` | `impl AddAssign for T` |
| `operator[]` | `Index` / `IndexMut` |
| Copy constructor | `Clone` (explicit); `Copy` (bitwise, implicit) |
| `operator==`, `operator<=>` | `PartialEq`/`Eq`, `PartialOrd`/`Ord`, usually derived |
| Converting constructor | `From` / `Into` (explicit call) |
| `explicit` constructor that can fail | `TryFrom` |
| `operator T()` | Not available; implement `From<YourType> for T` |
| `operator*`, `operator->` on smart pointers | `Deref` / `DerefMut` |
| `operator<<(std::ostream&, …)` | `Display`, `Debug` |

## Exercises

1. Add `Div<f32>`, `Sub`-assign and a `normalize` method to `Vec3`, and make
   `normalize` return `Option<Vec3>` for a zero vector.
2. Implement `Mul<Vec3> for Mat3` (a 3x3 matrix as `[[f32; 3]; 3]`) and
   `Mul<Mat3> for Mat3`.
3. Implement `FromStr` for `Rgba8` so `"#ff8000ff".parse::<Rgba8>()` works,
   reusing the `TryFrom` implementation.
