# Lifetimes

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- Lifetimes are a compile-time proof, not a runtime thing
- Elision rules: why most functions need no annotations
- Structs that hold references (views, spans, parsers)
- `'static`, string literals and leaked allocations
- Interactive: watching a borrow outlive its owner, step by step
- Common error messages decoded (E0499, E0502, E0505, E0597, E0716)

</div>

*C++ starting point: Dangling pointers, iterator invalidation.*
