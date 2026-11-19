# Cargo, crates and the build

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- One tool for build, dependencies, tests, benchmarks and docs
- Crates as the unit of compilation (vs translation units); why there are no headers
- Cargo.toml vs CMakeLists.txt, features vs #ifdef / CMake options
- Debug and release profiles, LTO, codegen-units, opt-level per dependency
- Static and dynamic linking, cdylib/staticlib, what ends up in the binary
- Workspaces for large codebases (vs add_subdirectory)

</div>

*C++ starting point: CMake, the linker, package managers.*
