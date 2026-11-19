# Vulkan with ash

Vulkan was designed to be explicit: you create every object, you synchronize
every access, and you destroy everything in the right order. That makes it a
natural fit for Rust's ownership model, and also the place where you feel most
clearly what Rust can check and what it cannot. This chapter uses
[ash](https://docs.rs/ash), the most widely used Vulkan binding, which is a
thin, `unsafe`, one-to-one mapping of the C API.

This chapter covers:

- what ash is, and how it maps to `vulkan.h`,
- create-info structs, `p_next` chains, and how lifetimes check them,
- designing safe wrappers: what to make safe and what to leave `unsafe`,
- resource lifetime with frames in flight, and deletion queues,
- the higher-level alternatives (vulkano, wgpu).

## ash in one page

ash is generated from `vk.xml`, the same registry that produces `vulkan.h`.
Every function and struct is there, under predictable names:

| C | ash |
|---|---|
| `VkBufferCreateInfo` | `vk::BufferCreateInfo` |
| `VK_BUFFER_USAGE_VERTEX_BUFFER_BIT` | `vk::BufferUsageFlags::VERTEX_BUFFER` |
| `VK_FORMAT_R8G8B8A8_SRGB` | `vk::Format::R8G8B8A8_SRGB` |
| `vkCreateBuffer(device, &info, NULL, &buf)` | `device.create_buffer(&info, None)` returns `VkResult<vk::Buffer>` |
| `vkCmdDraw(cmd, 3, 1, 0, 0)` | `device.cmd_draw(cmd, 3, 1, 0, 0)` |
| `vkGetDeviceProcAddr` tables | `ash::Device` holds the loaded function pointers |
| Extension functions | `ash::khr::swapchain::Device::new(&instance, &device)` |

Almost every call is `unsafe`, because the Vulkan spec lists "valid usage"
rules that a binding cannot check: a buffer must not be destroyed while a
command buffer that uses it is pending, an image must be in the right layout,
and so on. ash's job is to make the calls convenient and typed; correctness is
still on you, plus the validation layers.

A minimal instance:

```rust,ignore
use ash::vk;

let entry = unsafe { ash::Entry::load()? };          // loads libvulkan / vulkan-1.dll

let app_info = vk::ApplicationInfo::default()
    .application_name(c"my-engine")
    .api_version(vk::API_VERSION_1_3);

let layers = [c"VK_LAYER_KHRONOS_validation".as_ptr()];
let create_info = vk::InstanceCreateInfo::default()
    .application_info(&app_info)
    .enabled_layer_names(&layers);

let instance = unsafe { entry.create_instance(&create_info, None)? };
// ... later, after everything created from it is destroyed:
unsafe { instance.destroy_instance(None) };
```

Compared with C:

- `vk::...::default()` fills in `sType` and zeroes the rest. You never write
  `VK_STRUCTURE_TYPE_...` by hand.
- Builder methods take slices and set both the pointer and the count:
  `.enabled_layer_names(&layers)` sets `ppEnabledLayerNames` and
  `enabledLayerCount` together, so they cannot disagree.
- Errors come back as `Result<T, vk::Result>`, so `?` propagates
  `VK_ERROR_OUT_OF_DEVICE_MEMORY` instead of an `if (res != VK_SUCCESS)` after
  every call.
- `c"..."` is a C string literal (`&CStr`, null-terminated), the type Vulkan
  wants for names.

## Lifetimes on create-info structs

The classic C bug with create-info structs is a dangling pointer: you point
`pQueueFamilyIndices` at a temporary array, the array dies, and the call reads
garbage. ash's builder structs carry a lifetime parameter,
`vk::BufferCreateInfo<'a>`, which records "this struct borrows something for
`'a`". The compiler then rejects the dangling version.

Here is the same idea in a few lines you can run, with a stand-in for an ash
struct:

```rust
use std::marker::PhantomData;

// Like ash's vk::BufferCreateInfo<'a>: raw pointers inside, a lifetime outside.
#[derive(Default)]
struct BufferCreateInfo<'a> {
    size: u64,
    queue_family_index_count: u32,
    p_queue_family_indices: *const u32,
    _marker: PhantomData<&'a ()>,
}

impl<'a> BufferCreateInfo<'a> {
    fn size(mut self, size: u64) -> Self { self.size = size; self }
    fn queue_family_indices(mut self, indices: &'a [u32]) -> Self {
        self.queue_family_index_count = indices.len() as u32;
        self.p_queue_family_indices = indices.as_ptr();
        self
    }
}

fn create_buffer(info: &BufferCreateInfo) {
    // A real binding would pass `info` to vkCreateBuffer, which reads the pointer.
    let families = unsafe {
        std::slice::from_raw_parts(info.p_queue_family_indices, info.queue_family_index_count as usize)
    };
    println!("buffer of {} bytes shared by queue families {:?}", info.size, families);
}

fn main() {
    let families = vec![0u32, 2];
    let info = BufferCreateInfo::default().size(4096).queue_family_indices(&families);
    create_buffer(&info);
}
```

And the bug, which compiles in C and C++:

```rust,compile_fail
# use std::marker::PhantomData;
# #[derive(Default)]
# struct BufferCreateInfo<'a> { p: *const u32, n: u32, _m: PhantomData<&'a ()> }
# impl<'a> BufferCreateInfo<'a> {
#     fn queue_family_indices(mut self, i: &'a [u32]) -> Self { self.p = i.as_ptr(); self.n = i.len() as u32; self }
# }
# fn create_buffer(_: &BufferCreateInfo) {}
fn main() {
    let info = {
        let families = vec![0u32, 2];
        BufferCreateInfo::default().queue_family_indices(&families)
    };                       // error[E0597]: `families` does not live long enough
    create_buffer(&info);
}
```

The same mechanism checks `p_next` chains. In ash, `push_next` takes
`&'a mut T` where `T` must implement the marker trait for that chain (for
example `ExtendsPhysicalDeviceFeatures2`), so you can only chain structs the
spec allows, and they must outlive the struct they extend:

```rust,ignore
let mut features13 = vk::PhysicalDeviceVulkan13Features::default()
    .dynamic_rendering(true)
    .synchronization2(true);
let mut features12 = vk::PhysicalDeviceVulkan12Features::default()
    .buffer_device_address(true)
    .descriptor_indexing(true);

let queue_info = [vk::DeviceQueueCreateInfo::default()
    .queue_family_index(graphics_family)
    .queue_priorities(&[1.0])];
let extensions = [ash::khr::swapchain::NAME.as_ptr()];

let device_info = vk::DeviceCreateInfo::default()
    .queue_create_infos(&queue_info)
    .enabled_extension_names(&extensions)
    .push_next(&mut features13)        // checked: PhysicalDeviceVulkan13Features extends DeviceCreateInfo
    .push_next(&mut features12);

let device = unsafe { instance.create_device(physical_device, &device_info, None)? };
```

Lifetimes check **memory** validity, which is exactly the part of Vulkan
usage that is a C problem rather than a GPU problem. They do not check GPU
validity rules; the validation layers still do that.

## What to make safe

A safe Vulkan wrapper that rules out every misuse is a large project
([vulkano](https://docs.rs/vulkano) is one, and it pays for it with runtime
tracking). An engine usually takes a middle path. Here is a reasonable split:

| Concern | Make it safe with | Leave `unsafe` / validated by layers |
|---|---|---|
| Object destroyed exactly once | `Drop` on owning wrappers | |
| Children destroyed before parent (buffer before device) | Child holds an `Arc` of the device | |
| Create-info pointer validity | ash lifetimes | |
| Freed while the GPU still uses it | Deletion queue keyed by frame | |
| Thread rules (external synchronization) | `&mut` for externally synchronized objects (command pools, queues) | |
| Image layouts, barriers | | Render graph or careful code + validation |
| Descriptor contents matching shaders | Reflection at load time | Validation |

The first two rows are the classic C++ "destroy in reverse order" problem, and
in Rust they come for free from `Arc` and `Drop`:

```rust
use std::sync::Arc;

// Stand-ins for ash::Device and vk::Buffer.
struct RawDevice;
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct RawBuffer(u64);

struct DeviceShared {
    raw: RawDevice,
}
impl Drop for DeviceShared {
    fn drop(&mut self) {
        println!("vkDestroyDevice");   // runs only after every Arc is gone
        let _ = &self.raw;
    }
}

#[derive(Clone)]
pub struct Device(Arc<DeviceShared>);

pub struct Buffer {
    device: Device,      // keeps the device alive as long as this buffer exists
    raw: RawBuffer,
}

impl Device {
    pub fn new() -> Device {
        println!("vkCreateDevice");
        Device(Arc::new(DeviceShared { raw: RawDevice }))
    }
    pub fn create_buffer(&self, id: u64) -> Buffer {
        println!("vkCreateBuffer -> {id}");
        Buffer { device: self.clone(), raw: RawBuffer(id) }
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        println!("vkDestroyBuffer({:?})", self.raw);
        let _ = &self.device.0.raw;    // a real wrapper calls self.device.raw.destroy_buffer(...)
    }
}

fn main() {
    let device = Device::new();
    let vertex = device.create_buffer(1);
    let index = device.create_buffer(2);
    drop(device);                       // the device is NOT destroyed yet...
    println!("dropped our device handle");
    drop(vertex);
    drop(index);                        // ...it is destroyed after the last buffer
}
```

The order of destruction is now a property of the data structure, not of the
order of lines in a shutdown function. `Arc` costs an atomic increment per
created object, which is nothing compared with `vkCreateBuffer`.

## Frames in flight

The hardest lifetime in Vulkan is not a CPU lifetime at all. When you drop a
`Buffer` on the CPU, the GPU may still be executing a command buffer, recorded
one or two frames ago, that reads it. Destroying it immediately is a
use-after-free on the GPU, and `Drop` alone cannot know.

The standard solution, in C++ and in Rust, is a **deletion queue**: dropping
a resource defers its destruction until the frame that last used it has
finished on the GPU (its fence has signaled). With `N` frames in flight, a
resource dropped during frame `f` is safe to destroy when frame `f` completes,
which you know when you wait on that frame's fence at the start of frame
`f + N`:

```rust
use std::cell::RefCell;
use std::rc::Rc;

const FRAMES_IN_FLIGHT: u64 = 2;

#[derive(Debug)]
#[allow(dead_code)] // the ids are only printed
enum Garbage { Buffer(u64), Image(u64) }

#[derive(Default)]
struct DeletionQueue {
    pending: Vec<(u64, Garbage)>,   // (frame in which it was dropped, object)
}

impl DeletionQueue {
    /// Call after waiting on the fence of `completed_frame`.
    fn collect(&mut self, completed_frame: u64) {
        self.pending.retain(|(frame, obj)| {
            if *frame <= completed_frame {
                println!("  destroy {obj:?} (dropped in frame {frame})");
                false
            } else {
                true
            }
        });
    }
}

struct Renderer {
    frame: u64,
    garbage: Rc<RefCell<DeletionQueue>>,
}

struct Buffer {
    id: u64,
    renderer_frame: u64,
    garbage: Rc<RefCell<DeletionQueue>>,
}

impl Drop for Buffer {
    fn drop(&mut self) {
        // Not destroyed now: the GPU may still be reading it.
        self.garbage.borrow_mut().pending.push((self.renderer_frame, Garbage::Buffer(self.id)));
    }
}

impl Renderer {
    fn begin_frame(&mut self) {
        self.frame += 1;
        println!("frame {}", self.frame);
        if self.frame > FRAMES_IN_FLIGHT {
            // Here a real renderer waits on the fence of frame (frame - N).
            let completed = self.frame - FRAMES_IN_FLIGHT;
            self.garbage.borrow_mut().collect(completed);
        }
    }
    fn create_buffer(&self, id: u64) -> Buffer {
        Buffer { id, renderer_frame: self.frame, garbage: self.garbage.clone() }
    }
}

fn main() {
    let mut r = Renderer { frame: 0, garbage: Default::default() };
    r.begin_frame();
    let temp = r.create_buffer(7);
    r.garbage.borrow_mut().pending.push((r.frame, Garbage::Image(3)));
    drop(temp);                       // dropped in frame 1
    for _ in 0..3 {
        r.begin_frame();              // destroyed at the start of frame 3
    }
}
```

The simplification here is that a buffer records the frame in which it was
*created*; a real renderer records the last frame in which it was *used*,
usually by bumping a counter when a command buffer references it. Some engines
use a reference count instead: command buffers hold an `Arc` to every resource
they use and drop those references when their fence signals, so the resource's
`Drop` runs at the right time automatically. wgpu does exactly this
internally.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

Command pools and command buffers are "externally synchronized" in Vulkan: only
one thread may use them at a time. Map that to `&mut`: if recording requires
`&mut CommandBuffer`, the compiler guarantees one recorder at a time, and you
give each worker thread its own pool. Queues likewise: `queue_submit` taking
`&mut Queue` (or a `Mutex<Queue>`) turns a spec rule into a type rule.

</div>

## Memory allocation

Allocating a `VkDeviceMemory` per buffer does not scale, so C++ engines use
VulkanMemoryAllocator. In Rust the common choices are the
[gpu-allocator](https://docs.rs/gpu-allocator) crate (pure Rust, used by many
projects, also supports D3D12) and [vk-mem](https://docs.rs/vk-mem) (bindings
to VMA itself). Both return allocations that you free explicitly, and both fit
the owning-wrapper pattern above: the allocation lives in the `Buffer`
wrapper and is freed in its `Drop` (or its deletion-queue entry).

## Shaders

Vulkan takes SPIR-V. Options for producing it from a Rust build:

- Compile GLSL or HLSL with `glslc`/`dxc` from `build.rs` and embed the result
  with `include_bytes!` ([Assets and build](assets-and-build.md) shows how).
- Use [shaderc](https://docs.rs/shaderc) (bindings to the same compiler) at
  build or run time.
- Use [naga](https://docs.rs/naga), the pure-Rust shader translator from the
  wgpu project, to convert WGSL or GLSL to SPIR-V.
- Write shaders in Rust with [rust-gpu](https://github.com/Rust-GPU/rust-gpu),
  an experimental compiler backend that emits SPIR-V.

`include_bytes!` gives a `&[u8; N]` with no alignment guarantee, but SPIR-V
must be read as `u32` words. `ash::util::read_spv` copies it into a
correctly aligned `Vec<u32>`.

## Higher-level options

| Crate | Level | Use it when |
|---|---|---|
| ash | Raw Vulkan, `unsafe` | You want full control and are writing your own abstraction layer |
| vulkano | Safe Vulkan with runtime tracking | You want Vulkan concepts but checked, and can accept some overhead |
| wgpu | Safe WebGPU-style API over Vulkan, Metal, D3D12, GL, WebGPU | You want portability and safety; [next chapter](wgpu.md) |

Many Rust renderers start on wgpu and only drop to ash where they need a
feature wgpu does not expose (mesh shaders, ray tracing, specific extensions).

## Summary

| C++ | Rust |
|---|---|
| `vulkan.h`, volk | ash (`Entry`, `Instance`, `Device` hold function tables) |
| `sType = VK_STRUCTURE_TYPE_...` | `vk::Struct::default()` |
| Pointer + count fields | Slice-taking builder methods |
| `if (res != VK_SUCCESS)` | `Result<T, vk::Result>` and `?` |
| Dangling `pNext` / array pointers | Rejected by the struct's lifetime parameter |
| Reverse-order shutdown function | `Arc<Device>` in children, `Drop` |
| Deletion queue | Same pattern; `Drop` enqueues |
| VMA | gpu-allocator, vk-mem |
| "Externally synchronized" in the spec | `&mut` or `Mutex` in the wrapper's API |

## Exercises

1. In the `Arc<Device>` example, add an `Image` type that also holds a
   `Device`. Put a few buffers and images into a `Vec<Box<dyn std::any::Any>>`,
   drop the device handle, then remove the elements in a random order. When
   is `vkDestroyDevice` printed?
2. Change the deletion-queue example so that `Buffer` records the last frame it
   was used in (add a `fn use_in_frame(&self, frame: u64)` with a `Cell<u64>`).
   Use the buffer in frame 2, drop it in frame 2, and check that it is
   destroyed at the start of frame 4.
3. Read the `push_next` signature in ash's documentation for
   `vk::DeviceCreateInfo`. Which trait bound prevents you from chaining a
   `vk::ImageViewUsageCreateInfo` onto a device create info?
