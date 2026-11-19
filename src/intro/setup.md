# Toolchain setup

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- rustup, toolchains and targets (vs installing GCC/Clang/MSVC side by side)
- rust-analyzer in VS Code, CLion or Visual Studio
- Debugging with LLDB, GDB or Visual Studio; RenderDoc, Nsight and PIX still work
- `cargo new`, `cargo run`, `cargo build --release`: what each step does

</div>

Until it is written, the short version: install Rust with
[rustup](https://rustup.rs), then

```sh
cargo new hello && cd hello
cargo run
```
