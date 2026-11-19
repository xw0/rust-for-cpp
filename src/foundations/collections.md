# Collections and strings

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- `Vec<T>` vs `std::vector`: growth, capacity, and why push can't invalidate your references
- `HashMap`, `BTreeMap`, `VecDeque`, `BinaryHeap` mapped to STL equivalents
- `String` and `&str` are UTF-8; `OsString`, `CString`, `Path`
- Slices `&[T]` as the universal span type
- Choosing containers for engine workloads; smallvec and arrayvec

</div>

*C++ starting point: STL containers, std::string.*
