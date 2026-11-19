// Diagram data for the chapters. Strings are English; translations live in
// theme/js/i18n-<lang>.js and are looked up by RFC.t() at render time.
(function () {
  "use strict";
  var RFC = window.RFC;
  var M = RFC.memviz, T = RFC.timeline;

  // Small helpers to keep the step lists readable.
  function vec(id, name, ty, len, cap, state) {
    return { id: id, name: name, type: ty, fields: ["ptr", "len " + len, "cap " + cap], state: state || "live" };
  }
  function ref(id, name, ty, state) {
    return { id: id, name: name, type: ty, fields: ["ptr"], state: state || "live" };
  }
  function block(id, cells, label, state) {
    return { id: id, cells: cells, label: label, state: state || "live" };
  }
  function frame(name, slots) { return { name: name, slots: slots }; }
  function own(a, b) { return { from: a, to: b, kind: "own" }; }
  function shr(a, b) { return { from: a, to: b, kind: "shared" }; }
  function mut(a, b) { return { from: a, to: b, kind: "mut" }; }
  function dang(a, b) { return { from: a, to: b, kind: "dangling" }; }

  // ------------------------------------------------------------------
  // Chapter: Ownership and moves
  // ------------------------------------------------------------------
  M.define("ownership-move", {
    title: "What a move does: C++ vs Rust",
    variants: [
      {
        label: "C++",
        language: "cpp",
        code: [
          "void demo() {",
          "    std::vector<int> a = {1, 2, 3};",
          "    std::vector<int> b = std::move(a);",
          "    printf(\"%zu\\n\", a.size()); // compiles",
          "}   // ~b() runs, then ~a() runs"
        ],
        steps: [
          {
            line: 1,
            frames: [frame("demo()", [vec("a", "a", "std::vector<int>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "int[3]")],
            arrows: [own("a", "h")],
            note: "`a` is three machine words on the stack (pointer, size, capacity) that own a buffer on the heap. Same picture as in Rust."
          },
          {
            line: 2,
            frames: [frame("demo()", [vec("a", "a", "std::vector<int>", 0, 0, "ub"), vec("b", "b", "std::vector<int>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "int[3]")],
            arrows: [own("b", "h")],
            note: "`std::move` is only a cast. The **move constructor** of `b` does the work: it copies the three words, then writes null/0 into `a` so that `a`'s destructor will not free the buffer a second time. `a` is still a live object."
          },
          {
            line: 3,
            frames: [frame("demo()", [vec("a", "a", "std::vector<int>", 0, 0, "ub"), vec("b", "b", "std::vector<int>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "int[3]")],
            arrows: [own("b", "h")],
            note: "Using `a` after the move compiles without a warning. The standard only promises a \"valid but unspecified\" state, so this prints 0 on common implementations, but nothing checks that you meant it."
          },
          {
            line: 4,
            frames: [frame("demo()", [vec("a", "a", "std::vector<int>", 0, 0, "ub"), vec("b", "b", "std::vector<int>", 3, 3, "dropped")])],
            heap: [block("h", ["1", "2", "3"], "int[3]", "freed")],
            arrows: [],
            note: "At the closing brace destructors run in reverse order: `~b()` frees the buffer..."
          },
          {
            line: 4,
            frames: [frame("demo()", [vec("a", "a", "std::vector<int>", 0, 0, "dropped"), vec("b", "b", "std::vector<int>", 3, 3, "dropped")])],
            heap: [block("h", ["1", "2", "3"], "int[3]", "freed")],
            arrows: [],
            note: "...and then `~a()` runs too, on the emptied vector. Two objects, two destructors, and the move constructor had to leave `a` in a state that makes the second one harmless."
          }
        ]
      },
      {
        label: "Rust",
        language: "rust",
        code: [
          "fn demo() {",
          "    let a = vec![1, 2, 3];",
          "    let b = a;",
          "    println!(\"{}\", a.len()); // error",
          "    println!(\"{}\", b.len());",
          "}   // b is dropped; a is not"
        ],
        steps: [
          {
            line: 1,
            frames: [frame("demo()", [vec("a", "a", "Vec<i32>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "[i32; 3]")],
            arrows: [own("a", "h")],
            note: "Same layout as `std::vector`: pointer, length and capacity on the stack, elements on the heap. `a` owns the buffer."
          },
          {
            line: 2,
            frames: [frame("demo()", [vec("a", "a", "Vec<i32>", 3, 3, "moved"), vec("b", "b", "Vec<i32>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "[i32; 3]")],
            arrows: [own("b", "h")],
            note: "A Rust move is a plain bitwise copy of the three words. No user code runs and `a` is **not** reset: its old bits are still there. Instead the compiler marks `a` as moved and will reject any further use of it."
          },
          {
            line: 3,
            error: "error[E0382]: borrow of moved value: `a`\n  |     let b = a;\n  |             - value moved here\n  |     println!(\"{}\", a.len());\n  |                    ^ value borrowed here after move",
            frames: [frame("demo()", [vec("a", "a", "Vec<i32>", 3, 3, "moved"), vec("b", "b", "Vec<i32>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "[i32; 3]")],
            arrows: [own("b", "h")],
            note: "Where C++ gave you an unspecified object, Rust gives you a compile error. There is no moved-from state to reason about, because there is no way to observe it."
          },
          {
            line: 4,
            frames: [frame("demo()", [vec("a", "a", "Vec<i32>", 3, 3, "moved"), vec("b", "b", "Vec<i32>", 3, 3)])],
            heap: [block("h", ["1", "2", "3"], "[i32; 3]")],
            arrows: [own("b", "h")],
            note: "Delete the bad line and the program compiles. `b` is now the only owner."
          },
          {
            line: 5,
            frames: [frame("demo()", [vec("a", "a", "Vec<i32>", 3, 3, "moved"), vec("b", "b", "Vec<i32>", 3, 3, "dropped")])],
            heap: [block("h", ["1", "2", "3"], "[i32; 3]", "freed")],
            arrows: [],
            note: "At the end of scope `b` is dropped and frees the buffer. Nothing runs for `a`: the compiler knows statically that it was moved out, so there is exactly one owner and exactly one free."
          }
        ]
      }
    ]
  });

  M.define("move-into-fn", {
    title: "Passing by value moves ownership into the callee",
    code: [
      "fn consume(v: Vec<u32>) {",
      "    println!(\"{}\", v.len());",
      "}   // v goes out of scope: buffer freed",
      "",
      "fn main() {",
      "    let ids = vec![7, 8, 9];",
      "    consume(ids);",
      "    // ids can no longer be used here",
      "}"
    ],
    steps: [
      {
        line: 5,
        frames: [frame("main()", [vec("ids", "ids", "Vec<u32>", 3, 3)])],
        heap: [block("h", ["7", "8", "9"], "[u32; 3]")],
        arrows: [own("ids", "h")],
        note: "`main` owns a vector."
      },
      {
        line: [6, 0],
        frames: [
          frame("main()", [vec("ids", "ids", "Vec<u32>", 3, 3, "moved")]),
          frame("consume()", [vec("v", "v", "Vec<u32>", 3, 3)])
        ],
        heap: [block("h", ["7", "8", "9"], "[u32; 3]")],
        arrows: [own("v", "h")],
        note: "Calling `consume(ids)` copies the three words into the parameter `v`. Ownership of the heap buffer moves with them, like passing a `std::unique_ptr` by value, but without writing `std::move` and without leaving a null behind."
      },
      {
        line: 1,
        frames: [
          frame("main()", [vec("ids", "ids", "Vec<u32>", 3, 3, "moved")]),
          frame("consume()", [vec("v", "v", "Vec<u32>", 3, 3)])
        ],
        heap: [block("h", ["7", "8", "9"], "[u32; 3]")],
        arrows: [own("v", "h")],
        note: "Inside the callee, `v` is an ordinary owned local."
      },
      {
        line: 2,
        frames: [
          frame("main()", [vec("ids", "ids", "Vec<u32>", 3, 3, "moved")]),
          frame("consume()", [vec("v", "v", "Vec<u32>", 3, 3, "dropped")])
        ],
        heap: [block("h", ["7", "8", "9"], "[u32; 3]", "freed")],
        arrows: [],
        note: "When `consume` returns, `v` is dropped and the buffer is freed, **inside the callee**. The caller does not get it back unless the function returns it."
      },
      {
        line: 7,
        frames: [frame("main()", [vec("ids", "ids", "Vec<u32>", 3, 3, "moved")])],
        heap: [block("h", ["7", "8", "9"], "[u32; 3]", "freed")],
        arrows: [],
        note: "Back in `main`, `ids` is statically known to be moved. Reading it would be error E0382, and at the end of `main` nothing is dropped for it."
      }
    ]
  });

  // ------------------------------------------------------------------
  // Chapter: Borrowing and references
  // ------------------------------------------------------------------
  M.define("borrow-basics", {
    title: "Shared and mutable borrows",
    code: [
      "let mut scores = vec![10, 20];",
      "let a = &scores;",
      "let b = &scores;",
      "println!(\"{} {}\", a[0], b[1]);",
      "let m = &mut scores;",
      "m.push(30);",
      "println!(\"{:?}\", scores);"
    ],
    steps: [
      {
        line: 0,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 2, 2)])],
        heap: [block("h1", ["10", "20"], "[i32; 2]")],
        arrows: [own("s", "h1")],
        note: "`scores` owns a buffer with room for exactly two elements."
      },
      {
        line: 1,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 2, 2, "borrowed"), ref("a", "a", "&Vec<i32>")])],
        heap: [block("h1", ["10", "20"], "[i32; 2]")],
        arrows: [own("s", "h1"), shr("a", "s")],
        note: "`a` is a shared reference: a plain pointer to `scores`, like a `const std::vector<int>*` that can never be null. While it is in use, nobody may modify `scores`."
      },
      {
        line: 2,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 2, 2, "borrowed"), ref("a", "a", "&Vec<i32>"), ref("b", "b", "&Vec<i32>")])],
        heap: [block("h1", ["10", "20"], "[i32; 2]")],
        arrows: [own("s", "h1"), shr("a", "s"), shr("b", "s")],
        note: "Any number of shared borrows may exist at the same time. Many readers are always safe."
      },
      {
        line: 3,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 2, 2, "borrowed"), ref("a", "a", "&Vec<i32>"), ref("b", "b", "&Vec<i32>")])],
        heap: [block("h1", ["10", "20"], "[i32; 2]")],
        arrows: [own("s", "h1"), shr("a", "s"), shr("b", "s")],
        note: "This is the **last use** of `a` and `b`. A borrow lasts until its last use, not until the end of the block."
      },
      {
        line: 4,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 2, 2, "frozen"), ref("a", "a", "&Vec<i32>", "dead"), ref("b", "b", "&Vec<i32>", "dead"), ref("m", "m", "&mut Vec<i32>")])],
        heap: [block("h1", ["10", "20"], "[i32; 2]")],
        arrows: [own("s", "h1"), mut("m", "s")],
        note: "Because `a` and `b` are no longer used, a **mutable** borrow is allowed. `&mut` is exclusive: while `m` is in use, `scores` cannot be read or written except through `m`."
      },
      {
        line: 5,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 3, 4, "frozen"), ref("a", "a", "&Vec<i32>", "dead"), ref("b", "b", "&Vec<i32>", "dead"), ref("m", "m", "&mut Vec<i32>")])],
        heap: [block("h1", ["10", "20"], "[i32; 2]", "freed"), block("h2", ["10", "20", "30", ""], "[i32; 4]")],
        arrows: [own("s", "h2"), mut("m", "s")],
        note: "`push` needs more room, so the vector reallocates: new buffer, copy, free the old one. This is safe only because the compiler has proved no other reference into the old buffer exists."
      },
      {
        line: 6,
        frames: [frame("main()", [vec("s", "scores", "Vec<i32>", 3, 4), ref("a", "a", "&Vec<i32>", "dead"), ref("b", "b", "&Vec<i32>", "dead"), ref("m", "m", "&mut Vec<i32>", "dead")])],
        heap: [block("h2", ["10", "20", "30", ""], "[i32; 4]")],
        arrows: [own("s", "h2")],
        note: "`m` is done, so `scores` is usable again. The rule the compiler enforces is simple: **either** many `&T` **or** one `&mut T`, never both at once."
      }
    ]
  });

  // ------------------------------------------------------------------
  // Chapter: Traits and generics
  // ------------------------------------------------------------------
  M.define("vtable", {
    title: "Where the vtable pointer lives",
    variants: [
      {
        label: "C++",
        language: "cpp",
        code: [
          "struct Shape { virtual float area() const = 0; };",
          "struct Circle : Shape { float r; /* ... */ };",
          "",
          "std::unique_ptr<Shape> s = std::make_unique<Circle>(1.0f);",
          "float a = s->area();"
        ],
        steps: [
          {
            line: 3,
            frames: [frame("main()", [{ id: "s", name: "s", type: "unique_ptr<Shape>", fields: ["ptr"] }])],
            heap: [block("obj", ["vptr", "", "r"], "Circle object (16 bytes)"), block("vt", ["dtor", "area"], "Circle vtable (static)")],
            arrows: [own("s", "obj"), { from: "obj", to: "vt", kind: "shared" }],
            note: "The pointer is one word. The **object** carries a hidden `vptr` as its first member, so every `Circle` is 16 bytes instead of 4, and it pays that cost even when it is never used polymorphically."
          },
          {
            line: 4,
            frames: [frame("main()", [{ id: "s", name: "s", type: "unique_ptr<Shape>", fields: ["ptr"] }])],
            heap: [block("obj", ["vptr", "", "r"], "Circle object (16 bytes)"), block("vt", ["dtor", "area"], "Circle vtable (static)")],
            arrows: [own("s", "obj"), { from: "obj", to: "vt", kind: "shared" }],
            note: "A virtual call loads the object's `vptr`, then the function pointer from the vtable, then calls it: two dependent loads, the first of them from the object itself."
          }
        ]
      },
      {
        label: "Rust",
        language: "rust",
        code: [
          "trait Shape { fn area(&self) -> f32; }",
          "struct Circle { r: f32 }",
          "",
          "let s: Box<dyn Shape> = Box::new(Circle { r: 1.0 });",
          "let a = s.area();"
        ],
        steps: [
          {
            line: 3,
            frames: [frame("main()", [{ id: "s", name: "s", type: "Box<dyn Shape>", fields: ["data", "vtable"] }])],
            heap: [block("obj", ["r"], "Circle (4 bytes)"), block("vt", ["drop", "size", "align", "area"], "vtable for Circle as Shape (static)")],
            arrows: [own("s", "obj"), { from: "s", to: "vt", kind: "shared" }],
            note: "`Box<dyn Shape>` is a **fat pointer**: one word points to the data, one to the vtable. The `Circle` itself is just its `f32`, with no hidden member, and is laid out exactly as it would be without any traits."
          },
          {
            line: 4,
            frames: [frame("main()", [{ id: "s", name: "s", type: "Box<dyn Shape>", fields: ["data", "vtable"] }])],
            heap: [block("obj", ["r"], "Circle (4 bytes)"), block("vt", ["drop", "size", "align", "area"], "vtable for Circle as Shape (static)")],
            arrows: [own("s", "obj"), { from: "s", to: "vt", kind: "shared" }],
            note: "A call loads the function pointer from the vtable (the pointer to which is already in a register) and passes the data pointer as `self`. The vtable also records size, alignment and the drop function, which is how `Box<dyn Shape>` can free an object whose type it does not know."
          }
        ]
      }
    ]
  });

  // ------------------------------------------------------------------
  // Chapter: Smart pointers
  // ------------------------------------------------------------------
  (function () {
    function rc(id, state) { return { id: id, name: id, type: "Rc<Mesh>", fields: ["ptr"], state: state || "live" }; }
    function box(n, state) { return block("h", ["s:" + n, "w:1", "mesh", "", ""], "RcBox<Mesh>: counts + value", state); }
    function arrows(ids) { return ids.map(function (i) { return own(i, "h"); }); }
    M.define("rc-count", {
      title: "Reference counting with Rc",
      code: [
        "let mesh = Rc::new(Mesh::load(\"rock\"));",
        "let a = Rc::clone(&mesh);",
        "let b = Rc::clone(&mesh);",
        "drop(a);",
        "drop(mesh);",
        "drop(b);   // last owner: Mesh is dropped"
      ],
      steps: [
        { line: 0, frames: [frame("main()", [rc("mesh")])], heap: [box(1)], arrows: arrows(["mesh"]),
          note: "`Rc::new` makes **one** allocation holding the strong count, the weak count and the value, like `std::make_shared`." },
        { line: 1, frames: [frame("main()", [rc("mesh"), rc("a")])], heap: [box(2)], arrows: arrows(["mesh", "a"]),
          note: "`Rc::clone` copies the pointer and increments the strong count. The `Mesh` is not copied. With `Rc` the increment is a plain add; `Arc` uses an atomic add." },
        { line: 2, frames: [frame("main()", [rc("mesh"), rc("a"), rc("b")])], heap: [box(3)], arrows: arrows(["mesh", "a", "b"]),
          note: "Three owners. Each can read the mesh through `&Mesh`, but none can get a `&mut Mesh`, because the others might be reading it." },
        { line: 3, frames: [frame("main()", [rc("mesh"), rc("a", "dropped"), rc("b")])], heap: [box(2)], arrows: arrows(["mesh", "b"]),
          note: "Dropping an `Rc` decrements the count." },
        { line: 4, frames: [frame("main()", [rc("mesh", "dropped"), rc("a", "dropped"), rc("b")])], heap: [box(1)], arrows: arrows(["b"]),
          note: "The original `mesh` handle is not special. Any owner can be the last one." },
        { line: 5, frames: [frame("main()", [rc("mesh", "dropped"), rc("a", "dropped"), rc("b", "dropped")])], heap: [box(0, "freed")], arrows: [],
          note: "The count reaches zero: `Mesh` is dropped and, since there are no `Weak` pointers left either, the allocation is freed." }
      ]
    });
  })();

  // ------------------------------------------------------------------
  // Chapter: Lifetimes
  // ------------------------------------------------------------------
  M.define("lifetime-dangling", {
    title: "A borrow that outlives its owner",
    code: [
      "let r;",
      "{",
      "    let s = String::from(\"frame\");",
      "    r = &s;",
      "}   // s is dropped here",
      "println!(\"{r}\");"
    ],
    steps: [
      {
        line: 0,
        frames: [frame("main()", [ref("r", "r", "&String", "uninit")])],
        heap: [],
        arrows: [],
        note: "`r` is declared but not initialized. Rust allows this, and refuses any read of `r` until it has been assigned on every path."
      },
      {
        line: 2,
        frames: [frame("main()", [ref("r", "r", "&String", "uninit")]), frame("inner block", [vec("s", "s", "String", 5, 5)])],
        heap: [block("h", ["f", "r", "a", "m", "e"], "[u8; 5]")],
        arrows: [own("s", "h")],
        note: "`s` lives in the inner block."
      },
      {
        line: 3,
        frames: [frame("main()", [ref("r", "r", "&String")]), frame("inner block", [vec("s", "s", "String", 5, 5, "borrowed")])],
        heap: [block("h", ["f", "r", "a", "m", "e"], "[u8; 5]")],
        arrows: [own("s", "h"), shr("r", "s")],
        note: "`r` borrows `s`. Because `r` is used later, on the last line, this borrow must stay valid until then."
      },
      {
        line: 4,
        frames: [frame("main()", [ref("r", "r", "&String")]), frame("inner block", [vec("s", "s", "String", 5, 5, "dropped")])],
        heap: [block("h", ["f", "r", "a", "m", "e"], "[u8; 5]", "freed")],
        arrows: [dang("r", "s")],
        note: "At the closing brace `s` is dropped and its buffer freed. `r` would now point at a dead stack slot. In C++ this compiles."
      },
      {
        line: [3, 5],
        error: "error[E0597]: `s` does not live long enough\n  |     let s = String::from(\"frame\");\n  |         - binding `s` declared here\n  |     r = &s;\n  |         ^^ borrowed value does not live long enough\n  | }\n  | - `s` dropped here while still borrowed\n  | println!(\"{r}\");\n  |           --- borrow later used here",
        frames: [frame("main()", [ref("r", "r", "&String")]), frame("inner block", [vec("s", "s", "String", 5, 5, "dropped")])],
        heap: [block("h", ["f", "r", "a", "m", "e"], "[u8; 5]", "freed")],
        arrows: [dang("r", "s")],
        note: "Rust rejects the program. The error names the three places that matter: where the borrow starts, where the owner dies, and where the borrow is used afterwards. Move the `println!` inside the block, or move `s` out of it, and it compiles."
      }
    ]
  });

  M.define("invalidation", {
    title: "Reference invalidation: the bug and the error",
    variants: [
      {
        label: "C++",
        language: "cpp",
        code: [
          "std::vector<int> v = {1, 2};",
          "int& first = v[0];",
          "v.push_back(3);        // reallocates",
          "printf(\"%d\\n\", first); // ???"
        ],
        steps: [
          {
            line: 0,
            frames: [frame("main()", [vec("v", "v", "std::vector<int>", 2, 2)])],
            heap: [block("h1", ["1", "2"], "int[2]")],
            arrows: [own("v", "h1")],
            note: "A full vector: size 2, capacity 2."
          },
          {
            line: 1,
            frames: [frame("main()", [vec("v", "v", "std::vector<int>", 2, 2), ref("f", "first", "int&")])],
            heap: [block("h1", ["1", "2"], "int[2]")],
            arrows: [own("v", "h1"), shr("f", "h1")],
            note: "`first` points straight into the heap buffer."
          },
          {
            line: 2,
            frames: [frame("main()", [vec("v", "v", "std::vector<int>", 3, 4), ref("f", "first", "int&")])],
            heap: [block("h1", ["1", "2"], "int[2]", "freed"), block("h2", ["1", "2", "3", ""], "int[4]")],
            arrows: [own("v", "h2"), dang("f", "h1")],
            note: "`push_back` reallocates and frees the old buffer. `first` still points at it. The compiler said nothing."
          },
          {
            line: 3,
            error: "No compile error. Undefined behavior at run time.\nAddressSanitizer: heap-use-after-free (if you happened to build with it)",
            frames: [frame("main()", [vec("v", "v", "std::vector<int>", 3, 4), ref("f", "first", "int&")])],
            heap: [block("h1", ["1", "2"], "int[2]", "freed"), block("h2", ["1", "2", "3", ""], "int[4]")],
            arrows: [own("v", "h2"), dang("f", "h1")],
            note: "Reading through `first` is a use-after-free. It usually prints 1, which is the worst outcome: it hides the bug until the allocator reuses that memory. Engines hit this with `std::vector<Entity>` and cached `Entity*` all the time."
          }
        ]
      },
      {
        label: "Rust",
        language: "rust",
        code: [
          "let mut v = vec![1, 2];",
          "let first = &v[0];",
          "v.push(3);",
          "println!(\"{first}\");"
        ],
        steps: [
          {
            line: 0,
            frames: [frame("main()", [vec("v", "v", "Vec<i32>", 2, 2)])],
            heap: [block("h1", ["1", "2"], "[i32; 2]")],
            arrows: [own("v", "h1")],
            note: "Same starting point."
          },
          {
            line: 1,
            frames: [frame("main()", [vec("v", "v", "Vec<i32>", 2, 2, "borrowed"), ref("f", "first", "&i32")])],
            heap: [block("h1", ["1", "2"], "[i32; 2]")],
            arrows: [own("v", "h1"), shr("f", "h1")],
            note: "`first` borrows from `v`. The compiler records that `v` is borrowed for as long as `first` is used, which is until line 4."
          },
          {
            line: [2, 3],
            error: "error[E0502]: cannot borrow `v` as mutable because it is also borrowed as immutable\n  |     let first = &v[0];\n  |                  - immutable borrow occurs here\n  |     v.push(3);\n  |     ^^^^^^^^^ mutable borrow occurs here\n  |     println!(\"{first}\");\n  |               ------- immutable borrow later used here",
            frames: [frame("main()", [vec("v", "v", "Vec<i32>", 2, 2, "borrowed"), ref("f", "first", "&i32")])],
            heap: [block("h1", ["1", "2"], "[i32; 2]")],
            arrows: [own("v", "h1"), shr("f", "h1")],
            note: "`push` takes `&mut self`, an exclusive borrow, while `first` is still alive. The program is rejected, so the dangling state from the C++ tab can never be reached. Notice the error names all three places involved."
          }
        ]
      }
    ]
  });

  T.define("vec-push", {
    title: "Where each borrow is alive",
    variants: [
      {
        label: "Rejected",
        code: [
          "let mut v = vec![1, 2];",
          "let first = &v[0];",
          "v.push(3);",
          "println!(\"{first}\");"
        ],
        bars: [
          { name: "v", kind: "owner", from: 0, to: 3 },
          { name: "first", kind: "shared", from: 1, to: 3 },
          { name: "push", kind: "mut", from: 2, to: 2 }
        ],
        conflict: [2],
        error: "error[E0502]: cannot borrow `v` as mutable because it is also borrowed as immutable",
        note: "The shared borrow `first` is alive from line 2 to its last use on line 4. `push` needs `&mut v` on line 3, inside that range: conflict."
      },
      {
        label: "Fix 1: copy the value",
        code: [
          "let mut v = vec![1, 2];",
          "let first = v[0];   // i32 is Copy",
          "v.push(3);",
          "println!(\"{first}\");"
        ],
        bars: [
          { name: "v", kind: "owner", from: 0, to: 3 },
          { name: "push", kind: "mut", from: 2, to: 2 }
        ],
        conflict: [],
        note: "`first` is now its own `i32`, not a reference. No borrow, no conflict. This is often what you meant in C++ too."
      },
      {
        label: "Fix 2: use it earlier",
        code: [
          "let mut v = vec![1, 2];",
          "let first = &v[0];",
          "println!(\"{first}\");  // last use",
          "v.push(3);            // fine"
        ],
        bars: [
          { name: "v", kind: "owner", from: 0, to: 3 },
          { name: "first", kind: "shared", from: 1, to: 2 },
          { name: "push", kind: "mut", from: 3, to: 3 }
        ],
        conflict: [],
        note: "Borrows end at their last use (\"non-lexical lifetimes\"). Reordering so the read happens first is enough."
      }
    ]
  });
})();
