# VR and AR with OpenXR

OpenXR is the Khronos standard API for virtual and augmented reality: headsets
(Meta Quest, Valve Index, Pico, Varjo), their controllers, hand tracking, and
the compositor that shows your rendered images in the headset. Like Vulkan, it
is a C API with a loader, extensions and explicit handles, and it is usually
used *together* with Vulkan (or D3D11/12, OpenGL): OpenXR provides the poses,
timing and swapchain images; your renderer draws into them.

Rust has two layers of bindings, maintained in the same repository
([openxrs](https://github.com/Ralith/openxrs)):

| Crate | Like | What it gives you |
|---|---|---|
| [openxr-sys](https://docs.rs/openxr-sys) | `openxr.h` | Raw C types, constants and function pointer types, generated from `xr.xml`. Everything is `unsafe`. |
| [openxr](https://docs.rs/openxr) | A thin C++ wrapper | Owned handles with `Drop`, `Result` errors, typed actions, a session generic over the graphics API. Re-exports `openxr-sys` as `openxr::sys`. |

This is the same split as ash ([Vulkan](vulkan.md)) versus a safe wrapper,
except that `openxr` is already a reasonably safe layer, so most code uses it
and only drops to `openxr::sys` for extensions it does not wrap.

This chapter covers:

- loading the runtime and creating an instance,
- connecting OpenXR to a Vulkan renderer,
- the session state machine and the frame loop,
- input with actions, and poses in spaces,
- projection and view matrices from OpenXR's FOV and pose,
- how the Rust types encode OpenXR's rules,
- using `openxr-sys` for unwrapped extensions, and building for Android (Quest).

The `openxr` crate's API changes between versions (it is at 0.19 at the time of
writing). The code below shows the shape of the API; the
[examples](https://github.com/Ralith/openxrs/tree/master/openxr/examples) in
the repository are a complete, maintained reference, including a full Vulkan
renderer (`vulkan.rs`).

## The OpenXR model in one table

If you have used the C API, the mapping is direct:

| OpenXR C | `openxr` crate | Notes |
|---|---|---|
| Loader (`openxr_loader.dll`/`.so`) | `xr::Entry` | `Entry::load()` (dynamic) or `Entry::linked()` (static) |
| `XrInstance` | `xr::Instance` | Owns the function table; cheap to clone (reference counted) |
| `XrSystemId` | `xr::SystemId` | A plain ID, not a handle: the headset |
| `XrSession` | `xr::Session<G>` | `G` is the graphics API: `xr::Vulkan`, `xr::D3D11`, `xr::OpenGL`, `xr::Headless` |
| `xrWaitFrame` / `xrBeginFrame` + `xrEndFrame` | `xr::FrameWaiter` / `xr::FrameStream<G>` | Two separate objects; see below |
| `XrSwapchain` | `xr::Swapchain<G>` | Images are `G::SwapchainImage` (a `VkImage` for Vulkan) |
| `XrActionSet`, `XrAction` | `xr::ActionSet`, `xr::Action<T>` | `T` is `bool`, `f32`, `xr::Vector2f`, `xr::Posef` or `xr::Haptic` |
| `XrSpace` | `xr::Space` | Reference spaces (`STAGE`, `LOCAL`, `VIEW`) and action spaces |
| `XrResult` | `Result<T, xr::sys::Result>` | `?` instead of `XR_FAILED(...)` checks |
| `xrDestroy*` | `Drop` | Children keep their parent alive |

## Loading and creating an instance

```rust,ignore
use openxr as xr;

// Load the system's OpenXR loader (the runtime is chosen by the loader:
// SteamVR, Meta Quest Link, Monado, ...).
let entry = unsafe { xr::Entry::load()? };

// Ask what the runtime supports, and enable what we need.
let available = entry.enumerate_extensions()?;
assert!(available.khr_vulkan_enable2, "runtime does not support Vulkan");
let mut extensions = xr::ExtensionSet::default();
extensions.khr_vulkan_enable2 = true;

let instance = entry.create_instance(
    &xr::ApplicationInfo {
        application_name: "my-vr-app",
        application_version: 0,
        engine_name: "my-engine",
        engine_version: 0,
        api_version: xr::Version::new(1, 0, 0),
    },
    &extensions,
    &[],                                  // API layers
)?;
let props = instance.properties()?;
println!("runtime: {} {}", props.runtime_name, props.runtime_version);

// The headset. Fails with ERROR_FORM_FACTOR_UNAVAILABLE if none is connected.
let system = instance.system(xr::FormFactor::HEAD_MOUNTED_DISPLAY)?;
```

Compared with C:

- `xr::ExtensionSet` is a struct with one `bool` field per known extension,
  plus `other: Vec<String>` for the rest. No string comparison loops, and a
  typo in an extension name is a compile error.
- Strings are `&str`. The crate converts them to the fixed-size `char` arrays
  OpenXR wants, and returns an error if one is too long.
- Every call returns `Result`, so a missing headset or an unsupported runtime
  reaches you through `?` with the exact `XrResult` code.

## Connecting to Vulkan

The Vulkan instance and device must be created **through OpenXR** (with
`XR_KHR_vulkan_enable2`), because the runtime needs to add its own extensions
and pick the physical device the headset is attached to. The `openxr` crate
wraps the calls and leaves the Vulkan objects as raw handles, which you then
hand to ash:

```rust,ignore
use ash::vk::{self, Handle};

// The runtime tells us which Vulkan versions it can work with.
let reqs = instance.graphics_requirements::<xr::Vulkan>(system)?;

let vk_entry = unsafe { ash::Entry::load()? };
let app_info = vk::ApplicationInfo::default().api_version(vk::make_api_version(0, 1, 2, 0));
let vk_instance_info = vk::InstanceCreateInfo::default().application_info(&app_info);

// OpenXR calls vkCreateInstance for us, adding the extensions it needs.
let vk_instance = unsafe {
    instance
        .create_vulkan_instance(
            system,
            std::mem::transmute(vk_entry.static_fn().get_instance_proc_addr),
            &vk_instance_info as *const _ as *const _,
        )?                                   // OpenXR error
        .map_err(vk::Result::from_raw)?      // Vulkan error
};
let vk_instance = unsafe {
    ash::Instance::load(vk_entry.static_fn(), vk::Instance::from_raw(vk_instance as _))
};

// The physical device that drives the headset.
let physical_device = vk::PhysicalDevice::from_raw(
    unsafe { instance.vulkan_graphics_device(system, vk_instance.handle().as_raw() as _)? } as _,
);
// ... create the logical device the same way, with create_vulkan_device ...

let (session, mut frame_waiter, mut frame_stream) = unsafe {
    instance.create_session::<xr::Vulkan>(
        system,
        &xr::vulkan::SessionCreateInfo {
            instance: vk_instance.handle().as_raw() as _,
            physical_device: physical_device.as_raw() as _,
            device: device.handle().as_raw() as _,
            queue_family_index,
            queue_index: 0,
        },
    )?
};
```

This is the most `unsafe` part of an OpenXR program, and it is unsafe for a
real reason: OpenXR and ash each have their own copy of the Vulkan handle
types, and the code converts between them through raw integers
(`as_raw`/`from_raw`). The compiler cannot check that the `VkDevice` you pass
really came from that `VkInstance`. Wrap this setup in one function that
returns your renderer's safe types, and the rest of the program never sees it.

The `G` parameter of `Session<G>` is the payoff: a `Session<xr::Vulkan>` only
produces swapchains whose images are `VkImage`s, and only accepts a Vulkan
`SessionCreateInfo`. Mixing graphics APIs is a type error, not a runtime crash.

## The session state machine

An OpenXR session moves through states the runtime controls: the user puts the
headset on or takes it off, opens the system menu, or another app takes focus.
You learn about it from events, and you must respond: begin the session when
it is `READY`, end it when it is `STOPPING`, exit on `EXITING` or
`LOSS_PENDING`. Here is the logic as plain Rust, with a stand-in for the
runtime's events:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
enum SessionState { Idle, Ready, Synchronized, Visible, Focused, Stopping, Exiting }

#[derive(Debug, Default)]
struct App { running: bool, should_render: bool, accepts_input: bool, quit: bool }

impl App {
    fn on_state_changed(&mut self, state: SessionState) {
        match state {
            SessionState::Ready => { self.running = true; println!("  -> session.begin()"); }
            SessionState::Stopping => { self.running = false; println!("  -> session.end()"); }
            SessionState::Exiting => self.quit = true,
            _ => {}
        }
        // VISIBLE: frames are shown. FOCUSED: frames are shown and we get input.
        self.should_render = matches!(state, SessionState::Visible | SessionState::Focused);
        self.accepts_input = state == SessionState::Focused;
    }
}

fn main() {
    use SessionState::*;
    let mut app = App::default();
    // The user starts the app, puts the headset on, opens the system menu,
    // closes it, then quits.
    for s in [Idle, Ready, Synchronized, Visible, Focused, Visible, Focused, Visible, Synchronized, Stopping, Idle, Exiting] {
        app.on_state_changed(s);
        println!("{s:?}: running={} render={} input={}", app.running, app.should_render, app.accepts_input);
        if app.quit { break; }
    }
}
```

With the real crate, the event loop at the top of each frame looks like this:

```rust,ignore
let mut event_buffer = xr::EventDataBuffer::new();
while let Some(event) = instance.poll_event(&mut event_buffer)? {
    match event {
        xr::Event::SessionStateChanged(e) => match e.state() {
            xr::SessionState::READY => {
                session.begin(xr::ViewConfigurationType::PRIMARY_STEREO)?;
                running = true;
            }
            xr::SessionState::STOPPING => {
                session.end()?;
                running = false;
            }
            xr::SessionState::EXITING | xr::SessionState::LOSS_PENDING => break 'main_loop,
            _ => {}
        },
        xr::Event::InstanceLossPending(_) => break 'main_loop,
        _ => {}
    }
}
```

`poll_event` borrows `event_buffer`, and the returned `xr::Event<'_>` borrows
it in turn. In C, the event structure is overwritten by the next
`xrPollEvent`, and reading a stale one is a silent bug; here, holding an event
across the next poll is a borrow error.

## The frame loop

Each frame has three steps. `wait` blocks until the runtime wants a new frame
and returns the **predicted display time**, the moment the frame will appear
in the headset. You render for that time, not for "now":

```rust,ignore
let view_type = xr::ViewConfigurationType::PRIMARY_STEREO;

// 1. Throttle to the headset's refresh rate and get the predicted display time.
let frame_state = frame_waiter.wait()?;
// 2. Tell the compositor we are starting to render.
frame_stream.begin()?;

if !frame_state.should_render {
    // Not visible (e.g. headset off): submit an empty frame.
    frame_stream.end(frame_state.predicted_display_time, blend_mode, &[])?;
    continue;
}

// Where are the eyes going to be at display time?
let (_flags, views) = session.locate_views(view_type, frame_state.predicted_display_time, &stage)?;

// Get a swapchain image to render into (one image with 2 array layers, one per eye).
let image_index = swapchain.acquire_image()?;
swapchain.wait_image(xr::Duration::INFINITE)?;
renderer.draw_stereo(images[image_index as usize], &views);   // your Vulkan code
swapchain.release_image()?;

// 3. Hand the image to the compositor, with the poses we rendered with.
let rect = xr::Rect2Di {
    offset: xr::Offset2Di { x: 0, y: 0 },
    extent: xr::Extent2Di { width: w as i32, height: h as i32 },
};
frame_stream.end(
    frame_state.predicted_display_time,
    blend_mode,
    &[&xr::CompositionLayerProjection::new().space(&stage).views(&[
        xr::CompositionLayerProjectionView::new()
            .pose(views[0].pose)
            .fov(views[0].fov)
            .sub_image(xr::SwapchainSubImage::new().swapchain(&swapchain).image_array_index(0).image_rect(rect)),
        xr::CompositionLayerProjectionView::new()
            .pose(views[1].pose)
            .fov(views[1].fov)
            .sub_image(xr::SwapchainSubImage::new().swapchain(&swapchain).image_array_index(1).image_rect(rect)),
    ])],
)?;
```

Why are `FrameWaiter` and `FrameStream` separate objects? OpenXR allows
`xrWaitFrame` to be called on one thread while another thread calls
`xrBeginFrame`/`xrEndFrame` for the previous frame; that pipelining is how
engines hide CPU latency. The crate gives each half its own owned value, both
`Send`, and both methods take `&mut self`. So you can move the waiter to a
different thread from the stream, but you cannot call `wait` from two threads
at once. The spec's "externally synchronized" rules become ownership, exactly
like command pools in the [Vulkan chapter](vulkan.md).

The swapchain follows the same idea: `acquire_image`, `wait_image` and
`release_image` take `&mut self`, so two threads cannot interleave them on one
swapchain.

## Input: actions and spaces

OpenXR input is abstract: you define *actions* ("grab", "teleport", "hand
pose"), and *suggest* bindings to physical inputs for each controller type
("interaction profile"). The runtime may remap them. In the crate, the action's
value type is a type parameter, so you cannot read a pose action as a float:

```rust,ignore
let action_set = instance.create_action_set("gameplay", "Gameplay", 0)?;
let left = instance.string_to_path("/user/hand/left")?;
let right = instance.string_to_path("/user/hand/right")?;

let grab = action_set.create_action::<f32>("grab", "Grab", &[left, right])?;
let hand_pose = action_set.create_action::<xr::Posef>("hand_pose", "Hand pose", &[left, right])?;

// Suggested bindings for the generic controller profile every runtime supports.
instance.suggest_interaction_profile_bindings(
    instance.string_to_path("/interaction_profiles/khr/simple_controller")?,
    &[
        xr::Binding::new(&grab, instance.string_to_path("/user/hand/left/input/select/click")?),
        xr::Binding::new(&grab, instance.string_to_path("/user/hand/right/input/select/click")?),
        xr::Binding::new(&hand_pose, instance.string_to_path("/user/hand/left/input/grip/pose")?),
        xr::Binding::new(&hand_pose, instance.string_to_path("/user/hand/right/input/grip/pose")?),
    ],
)?;
session.attach_action_sets(&[&action_set])?;

// A pose action becomes a space you can locate relative to another space.
let left_hand = hand_pose.create_space(session.clone(), left, xr::Posef::IDENTITY)?;
let stage = session.create_reference_space(xr::ReferenceSpaceType::STAGE, xr::Posef::IDENTITY)?;

// Each frame:
session.sync_actions(&[(&action_set).into()])?;
let squeeze = grab.state(&session, left)?;            // xr::ActionState<f32>
if squeeze.is_active && squeeze.current_state > 0.8 {
    let loc = left_hand.locate(&stage, frame_state.predicted_display_time)?;
    if loc.location_flags.contains(xr::SpaceLocationFlags::POSITION_VALID) {
        world.grab_at(loc.pose.position);
    }
}
```

Notice `location_flags`: a pose can be invalid (controller out of tracking
range) or only orientation-valid. The flags make that explicit, and a Rust
helper returning `Option<Posef>` turns "forgot to check the flag" into a type
error for the rest of your engine.

## From FOV and pose to matrices

OpenXR describes each eye with a **pose** (position plus orientation
quaternion, in the space you asked for) and an **asymmetric field of view**:
four angles in radians, left and down negative. Your renderer needs a view
matrix and a projection matrix. This is the part every XR renderer writes, and
it is plain math you can run here.

The projection follows the OpenXR SDK's `xr_linear.h`, for Vulkan or wgpu clip
space (y pointing down, depth from 0 to 1):

```rust
#[derive(Clone, Copy, Debug)]
pub struct Fov { pub angle_left: f32, pub angle_right: f32, pub angle_up: f32, pub angle_down: f32 }

#[derive(Clone, Copy, Debug)]
pub struct Posef { pub orientation: [f32; 4], pub position: [f32; 3] } // quaternion x, y, z, w

type Mat4 = [[f32; 4]; 4];   // column-major, like GLSL/WGSL and glam

/// Asymmetric perspective projection for Vulkan clip space (y down, z in 0..1).
pub fn projection(fov: Fov, near: f32, far: f32) -> Mat4 {
    let (l, r) = (fov.angle_left.tan(), fov.angle_right.tan());
    let (u, d) = (fov.angle_up.tan(), fov.angle_down.tan());
    let w = r - l;
    let h = d - u;                 // negative: flips y, because Vulkan's y points down
    [
        [2.0 / w, 0.0, 0.0, 0.0],
        [0.0, 2.0 / h, 0.0, 0.0],
        [(r + l) / w, (u + d) / h, -far / (far - near), -1.0],
        [0.0, 0.0, -(far * near) / (far - near), 0.0],
    ]
}

/// Rotate v by the unit quaternion q.
fn rotate(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let [x, y, z, w] = q;
    let t = [2.0 * (y * v[2] - z * v[1]), 2.0 * (z * v[0] - x * v[2]), 2.0 * (x * v[1] - y * v[0])];
    [
        v[0] + w * t[0] + (y * t[2] - z * t[1]),
        v[1] + w * t[1] + (z * t[0] - x * t[2]),
        v[2] + w * t[2] + (x * t[1] - y * t[0]),
    ]
}

/// The view matrix is the inverse of the eye's pose: rotate by the conjugate,
/// after translating by -position.
pub fn view(pose: Posef) -> Mat4 {
    let [x, y, z, w] = pose.orientation;
    let inv = [-x, -y, -z, w];
    let cols = [rotate(inv, [1.0, 0.0, 0.0]), rotate(inv, [0.0, 1.0, 0.0]), rotate(inv, [0.0, 0.0, 1.0])];
    let t = rotate(inv, pose.position);
    [
        [cols[0][0], cols[0][1], cols[0][2], 0.0],
        [cols[1][0], cols[1][1], cols[1][2], 0.0],
        [cols[2][0], cols[2][1], cols[2][2], 0.0],
        [-t[0], -t[1], -t[2], 1.0],
    ]
}

fn transform(m: &Mat4, p: [f32; 3]) -> [f32; 3] {
    let mut o = [0.0f32; 4];
    for row in 0..4 {
        o[row] = m[0][row] * p[0] + m[1][row] * p[1] + m[2][row] * p[2] + m[3][row];
    }
    [o[0] / o[3], o[1] / o[3], o[2] / o[3]]
}

fn main() {
    // A typical left eye: the field of view extends further outward (left) than toward the nose.
    let fov = Fov { angle_left: -0.94, angle_right: 0.77, angle_up: 0.87, angle_down: -0.96 };
    let proj = projection(fov, 0.05, 100.0);

    // The eye 1.6 m above the floor, 3 cm left of center, turned 90° to the left (about +y).
    let half = std::f32::consts::FRAC_PI_4;
    let pose = Posef { orientation: [0.0, half.sin(), 0.0, half.cos()], position: [-0.03, 1.6, 0.0] };
    let view = view(pose);

    // A point 2 m to the left of the eye, at eye height, is straight ahead after turning left.
    let p = [-2.03, 1.6, 0.0];
    let eye_space = transform(&view, p);
    println!("eye space: {:?}", eye_space.map(|v| (v * 1000.0).round() / 1000.0));
    println!("clip/NDC:  {:?}", transform(&proj, eye_space));
    // The left edge of the FOV at 1 m maps to x = -1:
    println!("left edge: {:?}", transform(&proj, [-(0.94f32.tan()), 0.0, -1.0]));
}
```

With glam, the same projection is a `Mat4::from_cols_array_2d(&projection(...))`
and the view is `Mat4::from_rotation_translation(q, p).inverse()`; the
hand-written version is shown so you can see exactly what OpenXR's numbers
mean. Two pitfalls that are not Rust-specific but cost everyone a day:

- OpenXR's FOV is **not symmetric**. A symmetric `perspective(fovy, aspect)`
  looks almost right and makes users feel sick.
- `angle_down` and `angle_left` are negative. Clip-space y is down in Vulkan
  and up in OpenGL; use the GL variant of the formula (`h = u - d`, depth
  -1..1) for OpenGL.

## How the types encode the rules

| OpenXR rule | How the `openxr` crate expresses it |
|---|---|
| Destroy children before the parent | Handles hold an `Arc` of their instance/session; `Drop` destroys them |
| A session uses exactly one graphics API | `Session<G>`, `Swapchain<G>`, `FrameStream<G>` are generic over `G` |
| `xrWaitFrame` and `xrBeginFrame` are externally synchronized | Separate `FrameWaiter` and `FrameStream`, methods take `&mut self` |
| Event data is overwritten by the next poll | `Event<'a>` borrows the `EventDataBuffer` |
| Actions have a fixed value type | `Action<T>`; `state()` returns `ActionState<T>` |
| String paths must be interned | `xr::Path`, created by `instance.string_to_path` |
| Structs need `type` and `next` | Builders such as `CompositionLayerProjection::new()` fill them in |

What it does **not** check: valid usage that depends on runtime state (calling
`locate_views` before the session is running returns an error), and anything
on the graphics side, which is your renderer's job. The validation layer
(`XR_APILAYER_LUNARG_core_validation`) works with Rust programs as with C++.

## Dropping to `openxr-sys`

When you need an extension the safe crate does not wrap yet, use the raw
function pointers. `openxr::sys` has every type and function pointer type from
`openxr.h`; you load the function with `xrGetInstanceProcAddr` and call it in
`unsafe`, exactly as in C:

```rust,ignore
use openxr as xr;
use openxr::sys;

/// XrResult codes below zero are errors.
fn check(r: sys::Result) -> Result<(), sys::Result> {
    if r.into_raw() >= 0 { Ok(()) } else { Err(r) }
}

// Load an extension function by name (here: XR_FB_display_refresh_rate).
let mut raw: Option<sys::pfn::VoidFunction> = None;
check(unsafe {
    (entry.fp().get_instance_proc_addr)(
        instance.as_raw(),
        c"xrRequestDisplayRefreshRateFB".as_ptr(),
        &mut raw,
    )
})?;
let request_refresh_rate: sys::pfn::RequestDisplayRefreshRateFB =
    unsafe { std::mem::transmute(raw.expect("function not found")) };

// SAFETY: the session is live, and the extension was enabled at instance creation.
check(unsafe { request_refresh_rate(session.as_raw(), 90.0) })?;
```

Before writing this, check `instance.exts()`: many extensions (hand tracking,
passthrough, refresh rate, foveation) already have typed wrappers or at least
loaded function tables there, so you can call `(fp.request_display_refresh_rate)(...)`
without the `transmute`. Treat any raw call the way you treated FFI in
[FFI with C and C++](../systems/ffi.md): one small function, a `SAFETY` comment
stating the preconditions, a safe signature on the outside.

## Building for Meta Quest (Android)

Standalone headsets run Android, so the target is
`aarch64-linux-android` (see [Toolchain setup](../intro/setup.md)). The pieces:

- **Loader**: Quest uses the Khronos standard Android loader. Enable the
  crate's `linked` feature and ship `libopenxr_loader.so` in the APK, or use
  `Entry::load()` and bundle it as a library.
- **App glue**: the [android-activity](https://docs.rs/android-activity)
  crate provides the `android_main` entry point and the lifecycle events
  (winit uses it on Android too). OpenXR needs the Java VM and activity
  pointers on Android: pass them through `xr::Entry::initialize_android_loader()`
  and the session's Android create info, as the crate's examples show.
- **Packaging**: [xbuild](https://github.com/rust-mobile/xbuild) or
  `cargo-apk` builds the APK; add the VR intent categories and the
  `com.oculus.intent.category.VR` (and the Khronos
  `org.khronos.openxr.intent.category.IMMERSIVE_HMD`) to the manifest.

Bevy users can skip most of this: the `bevy_mod_openxr` project integrates
OpenXR with Bevy's wgpu renderer and handles the session and frame loop.

## Summary

| C / C++ | Rust |
|---|---|
| `openxr.h`, `openxr_platform.h` | `openxr-sys` (raw), re-exported as `openxr::sys` |
| Hand-written C++ wrapper / OpenXR-Hpp | `openxr` crate |
| `XR_FAILED(result)` checks | `Result<T, sys::Result>` and `?` |
| `xrDestroy*` in reverse order | `Drop`; children keep parents alive |
| `XrSession` + `XrGraphicsBinding*` | `Session<xr::Vulkan>` etc. |
| `xrWaitFrame` / `xrBeginFrame` / `xrEndFrame` | `FrameWaiter::wait`, `FrameStream::begin`/`end` |
| Event buffer reused by `xrPollEvent` | `Event<'_>` borrowing `EventDataBuffer` |
| `xrGetInstanceProcAddr` for extensions | `instance.exts()`, or `sys::pfn` + `transmute` |
| `xr_linear.h` math | glam, or the few lines above |

## Exercises

1. In the session-state example, add a `LossPending` state that quits like
   `Exiting`, and make `on_state_changed` return a `Command` enum
   (`Begin`, `End`, `Quit`, `Nothing`) instead of printing. Why is that easier
   to test?
2. Write the OpenGL variant of `projection` (y up, depth -1..1) and check with
   `transform` that the near and far planes map to -1 and 1.
3. Write `fn locate_valid(loc: &xr::SpaceLocation) -> Option<xr::Posef>` (with
   your own stand-in types if you do not have the crate) that returns a pose
   only when both the position and orientation are valid. Where in a game would
   you call it?
