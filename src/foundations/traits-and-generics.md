# Traits and generics

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- Traits as interfaces and as constraints (like concepts, checked at definition)
- Static dispatch (monomorphization, like templates) vs `dyn Trait` (vtable)
- Interactive: where the vtable pointer lives in a fat pointer vs in the object
- Associated types and constants
- No inheritance: composition and trait default methods instead
- Orphan rule and coherence: why you can't specialize anything for anything

</div>

*C++ starting point: Virtual functions, templates, concepts.*
