# Rust for C++ Programmers

You have written C and C++ for years. You know what lives on the stack and what
lives on the heap, you have chased a dangling pointer through a debugger at 2 AM,
you have called OpenGL or Vulkan through a C API, and you know how a large
project is compiled, linked and held together with CMake. You do not need
another tutorial that explains what a pointer is.

This book teaches Rust **starting from what you already know**. Every chapter
begins with the C++ you would write, shows the Rust equivalent, and spends its
time on the places where your C++ intuition helps and, more importantly, where
it misleads you.

## What makes this book different

- **C++ first.** RAII vs `Drop`, `std::move` vs Rust moves, `std::mutex` vs
  `Mutex<T>`, CMake vs Cargo, templates vs generics, `shared_ptr` vs `Arc`.
- **Interactive memory diagrams.** Ownership, borrowing and lifetimes are
  explained with step-through diagrams of the stack and the heap, so you can
  watch exactly what a move or a borrow does.
- **Code you can run in the page.** Every Rust example has a ▶ button that
  compiles and runs it on the official [Rust Playground](https://play.rust-lang.org),
  and a link that opens it there so you can inspect the assembly.
- **Graphics and engine programming.** After the general chapters, Part III
  applies everything to the problems you actually have: handles and arenas,
  ECS and the borrow checker, SIMD, OpenGL and Vulkan FFI, wgpu, and a small
  renderer.

## Who this is for

You should be comfortable with:

- C: the stack and the heap, pointers, manual memory management, file I/O, C
  APIs such as OpenGL and Vulkan, and basic computer architecture (caches,
  alignment, what a cache line is);
- C++: classes, constructors and destructors, operator overloading, templates
  as a user, and the STL (containers, `std::thread`, `std::mutex`, streams);
- building large projects: compilers, linkers, static and dynamic libraries,
  CMake.

You do **not** need modern C++ expertise. If you are not sure what an rvalue
reference is or have never written a template metaprogram, that is fine: where
Rust borrows an idea from modern C++, this book explains the idea from scratch.

## How the book is organized

- **Getting started**: how to read the book and how to set up the toolchain.
- **Part I: The language, from C++**: Cargo, types, ownership, borrowing,
  lifetimes, enums, errors, traits, collections, closures, smart pointers and
  modules.
- **Part II: Systems programming**: concurrency, memory layout and
  performance, `unsafe`, FFI with C and C++, macros, testing and tooling.
- **Part III: Graphics and engine programming**: handles and arenas, ECS,
  math and SIMD, OpenGL, Vulkan, wgpu, the game loop, assets and build
  scripts, hot reloading, and a case study.

## Status

All chapters are written in English, and every runnable example is compiled
and tested on each build. The Chinese translation is in progress: chapter
titles and the interface are translated, and the chapter text follows.
Corrections and suggestions are welcome; see
[Contributing](appendix/contributing.md).

## License

The text and diagrams are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): you may copy,
translate, adapt and redistribute them, including commercially, as long as you
credit this book and link to it. Code (examples and the site's scripts) is
under the [MIT license](https://opensource.org/license/mit). See
[Contributing and translating](appendix/contributing.md).
