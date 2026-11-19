# Smart pointers and interior mutability

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- `Box<T>` vs `std::unique_ptr`
- `Rc`/`Arc` vs `shared_ptr` (and why Rc is cheaper)
- `Weak` and reference cycles
- `Cell`, `RefCell`: moving the borrow check to run time
- Interactive: reference counts and the heap

</div>

*C++ starting point: unique_ptr, shared_ptr, weak_ptr, mutable.*
