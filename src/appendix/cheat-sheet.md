# C++ to Rust cheat sheet

<div class="rfc-planned">

**This page is planned.** It will collect the summary tables from every
chapter into one quick reference.

</div>

| C++ | Rust | Chapter |
|---|---|---|
| RAII, destructor | `Drop` | [Ownership](../foundations/ownership.md) |
| `std::move(x)` | `let y = x;` | [Ownership](../foundations/ownership.md) |
| Copy constructor | `Clone` / `Copy` | [Ownership](../foundations/ownership.md) |
| `const T&` / `T&` | `&T` / `&mut T` | [Borrowing](../foundations/borrowing.md) |
| `std::span`, `std::string_view` | `&[T]`, `&str` | [Borrowing](../foundations/borrowing.md) |
| `T*` that may be null | `Option<&T>` | [Borrowing](../foundations/borrowing.md) |
| `std::unique_ptr<T>` | `Box<T>` | [Smart pointers](../foundations/smart-pointers.md) |
| `std::shared_ptr<T>` / `std::weak_ptr<T>` | `Rc<T>`/`Arc<T>`, `Weak<T>` | [Smart pointers](../foundations/smart-pointers.md) |
| Object pool + raw pointers | `Arena<T>` + `Handle<T>` | [Handles and arenas](../engine/handles-and-arenas.md) |
| `std::vector<T>` | `Vec<T>` | [Collections](../foundations/collections.md) |
| `std::unordered_map<K, V>` | `HashMap<K, V>` | [Collections](../foundations/collections.md) |
| `std::variant` | `enum` | [Enums](../foundations/enums-and-match.md) |
| exceptions | `Result<T, E>` and `?` | [Errors](../foundations/errors.md) |
| virtual functions | `dyn Trait` | [Traits](../foundations/traits-and-generics.md) |
| templates | generics with trait bounds | [Traits](../foundations/traits-and-generics.md) |
| `std::mutex` + data | `Mutex<T>` | [Concurrency](../systems/concurrency.md) |
| CMake + vcpkg/Conan | Cargo | [Cargo](../foundations/cargo.md) |
