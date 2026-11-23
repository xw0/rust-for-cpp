# Networking, async and RPC

C++ has no standard networking. A typical engine uses BSD sockets or Winsock
directly, Asio for anything event-driven, a serializer (Protobuf, FlatBuffers
or a hand-written one), and a game transport such as ENet or
GameNetworkingSockets. Rust's standard library includes blocking TCP and UDP
sockets, and the rest comes from a small set of crates that most of the
ecosystem shares: **tokio** for async I/O, **serde** for serialization,
**tonic** for gRPC and **quinn** for QUIC.

This chapter covers:

- blocking TCP and UDP with `std::net`,
- framing messages and parsing untrusted bytes,
- serialization with serde,
- async Rust and tokio, compared with Asio and C++20 coroutines,
- running async networking next to a synchronous game loop,
- RPC: a typed protocol by hand, then gRPC with tonic.

## Blocking sockets with `std::net`

| C++ (BSD sockets) | Rust |
|---|---|
| `socket` + `bind` + `listen` | `TcpListener::bind(addr)` |
| `accept` | `listener.accept()` or `listener.incoming()` |
| `socket` + `connect` | `TcpStream::connect(addr)` |
| `send` / `recv` | The `Write` and `Read` traits |
| `close` / `closesocket` | `Drop` |
| `setsockopt(TCP_NODELAY)` | `stream.set_nodelay(true)` |
| `sockaddr_in`, `getaddrinfo` | `SocketAddr`, `ToSocketAddrs` |
| `errno`, `WSAGetLastError` | `io::Result` |

A line-based echo server and a client, in one program:

```rust
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::thread;

fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;   // port 0: the OS picks one
    let addr = listener.local_addr()?;

    let server = thread::spawn(move || -> std::io::Result<()> {
        let (stream, peer) = listener.accept()?;
        println!("server: connection from {peer}");
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut writer = stream;
        let mut line = String::new();
        while reader.read_line(&mut line)? > 0 {        // 0 bytes: the client closed
            writer.write_all(line.to_uppercase().as_bytes())?;
            line.clear();
        }
        Ok(())
    });

    let mut client = TcpStream::connect(addr)?;
    let mut replies = BufReader::new(client.try_clone()?);
    for msg in ["hello\n", "spawn player\n"] {
        client.write_all(msg.as_bytes())?;
        let mut reply = String::new();
        replies.read_line(&mut reply)?;
        print!("client: {reply}");
    }
    client.shutdown(Shutdown::Write)?;                  // like shutdown(fd, SHUT_WR)
    server.join().unwrap()
}
```

Every call returns `io::Result`, so a failed `connect` or a reset connection
is a value you handle with `?`, not an `errno` you forget to check. The socket
closes when the last handle to it is dropped (`try_clone` is `dup`), and
`TcpStream` implements the same `Read` and `Write` traits as files, so
`BufReader` and every other I/O adapter work on it.

A thread per connection is fine for tools, editors and servers with tens of
clients. For thousands of connections, use async I/O (below).

## Messages, not byte streams

TCP delivers a stream of bytes, not messages: one `read` can return half a
message or three of them. The usual fix is the one you would use in C++: put a
length in front of each message. Then the bytes inside the frame must be
decoded, and they come from the network, so every length and tag in them is
untrusted.

```rust
use std::io::{self, Read, Write};

#[derive(Debug, PartialEq)]
enum Msg {
    Move { entity: u32, x: f32, y: f32 },
    Chat(String),
}

#[derive(Debug, PartialEq)]
enum DecodeError { Truncated, UnknownTag(u8), BadUtf8 }

/// Reads little-endian values from a byte slice, failing instead of overrunning.
struct Reader<'a> { buf: &'a [u8] }

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.buf.len() < n {
            return Err(DecodeError::Truncated);
        }
        let (head, rest) = self.buf.split_at(n);
        self.buf = rest;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, DecodeError> { Ok(self.take(1)?[0]) }
    fn u16(&mut self) -> Result<u16, DecodeError> { Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
    fn u32(&mut self) -> Result<u32, DecodeError> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn f32(&mut self) -> Result<f32, DecodeError> { Ok(f32::from_bits(self.u32()?)) }
}

impl Msg {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Msg::Move { entity, x, y } => {
                out.push(1);
                out.extend_from_slice(&entity.to_le_bytes());
                out.extend_from_slice(&x.to_le_bytes());
                out.extend_from_slice(&y.to_le_bytes());
            }
            Msg::Chat(text) => {
                out.push(2);
                let len = u16::try_from(text.len()).expect("chat message too long");
                out.extend_from_slice(&len.to_le_bytes());
                out.extend_from_slice(text.as_bytes());
            }
        }
    }

    fn decode(buf: &[u8]) -> Result<Msg, DecodeError> {
        let mut r = Reader { buf };
        match r.u8()? {
            1 => Ok(Msg::Move { entity: r.u32()?, x: r.f32()?, y: r.f32()? }),
            2 => {
                let len = r.u16()? as usize;
                let bytes = r.take(len)?;
                let text = std::str::from_utf8(bytes).map_err(|_| DecodeError::BadUtf8)?;
                Ok(Msg::Chat(text.to_string()))
            }
            tag => Err(DecodeError::UnknownTag(tag)),
        }
    }
}

const MAX_FRAME: usize = 64 * 1024;

fn write_frame(w: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).expect("frame too large");
    w.write_all(&len.to_le_bytes())?;
    w.write_all(payload)
}

fn read_frame(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;                            // loops until 4 bytes arrive
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {                                // a hostile length must not allocate 4 GB
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0; len];
    r.read_exact(&mut payload)?;
    Ok(payload)
}

fn main() -> io::Result<()> {
    // A Vec<u8> and a &[u8] stand in for the socket: they implement Write and Read too.
    let mut wire = Vec::new();
    for msg in [Msg::Move { entity: 7, x: 1.5, y: -2.0 }, Msg::Chat("gg".into())] {
        let mut payload = Vec::new();
        msg.encode(&mut payload);
        write_frame(&mut wire, &payload)?;
    }

    let mut input = &wire[..];
    while !input.is_empty() {
        let payload = read_frame(&mut input)?;
        println!("{:?}", Msg::decode(&payload));
    }

    // Hostile or corrupt input is an error value, never a buffer overrun.
    println!("{:?}", Msg::decode(&[1, 7, 0]));          // truncated
    println!("{:?}", Msg::decode(&[9]));                // unknown tag
    println!("{:?}", Msg::decode(&[2, 2, 0, 0xff, 0xfe])); // not UTF-8
    Ok(())
}
```

<div class="rfc-callout rfc-trap">
<span class="rfc-callout-title">C++ habit to unlearn</span>

`auto* p = reinterpret_cast<const MovePacket*>(buf);` is fast and common in C++
netcode, and it is undefined behavior if the buffer is misaligned or too
short, it depends on the compiler's padding and the machine's byte order, and
it trusts every field the sender wrote. In Rust, slicing is bounds-checked and
`from_le_bytes` fixes the byte order. If you do want a zero-copy view of a
`#[repr(C)]` struct, `bytemuck::try_from_bytes` checks the size and alignment
first ([Values, types and layout](../foundations/values-and-types.md)). Either
way, validate the values, not just the size: an entity id from the network
can still be out of range.

</div>

Point a fuzzer at decoders like `Msg::decode`: they take `&[u8]`, which is
exactly what cargo-fuzz feeds them
([Testing chapter](testing-and-tooling.md#property-tests-and-fuzzing)).

## Serialization with serde

Writing `encode` and `decode` by hand is tedious and easy to get out of step.
**serde** generates both from a derive, the way an engine's reflection system
generates serializers from `UPROPERTY` or a custom macro. serde itself is
format-independent; a separate crate provides each format:

| Crate | Format | Typical use |
|---|---|---|
| `postcard` | Compact binary, variable-length integers | Game messages, save data, embedded |
| `serde_json` | JSON | Tools, web APIs, config, debugging |
| `rmp-serde` | MessagePack | Interop with other languages |
| `prost` | Protobuf (with its own derive, not serde) | gRPC and cross-language schemas |

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
postcard = { version = "1", features = ["alloc"] }
serde_json = "1"
```

```rust,ignore
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
enum Msg {
    Move { entity: u32, x: f32, y: f32 },
    Chat(String),
}

fn main() -> Result<(), postcard::Error> {
    let m = Msg::Move { entity: 7, x: 1.5, y: -2.0 };
    let bytes = postcard::to_allocvec(&m)?;          // 10 bytes
    let back: Msg = postcard::from_bytes(&bytes)?;   // malformed input is an Err, never UB
    assert_eq!(m, back);
    println!("{} bytes; as JSON: {}", bytes.len(), serde_json::to_string(&m).unwrap());
    Ok(())
}
```

Binary formats like postcard are not self-describing: the bytes contain no
field names, so a client and server built from different versions of `Msg`
disagree silently. Version your protocol explicitly (a version number in the
handshake), and use Protobuf when the schema must evolve across releases or
languages.

## Async Rust

A thread per connection costs a stack and a context switch per client. The
alternative is the one Asio uses: an event loop over epoll, kqueue or IOCP,
with many tasks sharing a few threads. In Rust, you write those tasks as
`async fn`:

| C++ (Asio, C++20 coroutines) | Rust (tokio) |
|---|---|
| `asio::io_context` | `tokio::runtime::Runtime` |
| `asio::awaitable<T>` | `impl Future<Output = T>`, from an `async fn` |
| `co_await` | `.await` |
| `asio::co_spawn` | `tokio::spawn` |
| `asio::steady_timer` | `tokio::time::sleep`, `tokio::time::timeout` |
| A strand | A task that owns the state, fed by a channel |
| `io_context.run()` on N threads | The multi-threaded runtime (the default) |

The async echo server, one task per connection:

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
```

```rust,ignore
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[tokio::main]                      // builds a runtime and runs main on it
async fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:4000").await?;
    loop {
        let (stream, peer) = listener.accept().await?;
        tokio::spawn(async move {   // a task, not a thread
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let reply = format!("{}\n", line.to_uppercase());
                if write.write_all(reply.as_bytes()).await.is_err() {
                    break;
                }
            }
            println!("{peer} disconnected");
        });
    }
}
```

The code has the same shape as the blocking version. The differences that
matter to a C++ programmer:

- **Futures are lazy.** An `async fn` compiles to a state machine, like a C++
  coroutine, but calling it only builds the state machine. Nothing runs until
  it is `.await`ed or spawned, and the compiler warns about a future you never
  use.
- **The runtime is a library.** The language defines `async`, `.await` and the
  `Future` trait; the executor and the I/O reactor come from a crate. tokio is
  the default choice; most networking crates, including tonic and quinn, are
  built on it.
- **`tokio::spawn` needs `Send + 'static`**, for the same reason as
  `thread::spawn`: the task can move between worker threads and outlive the
  caller. A future that holds an `Rc`, or a `std::sync::MutexGuard`, across an
  `.await` is not `Send`, and the spawn is a compile error
  ([Threads, locks and Send/Sync](concurrency.md)).
- **Never block inside a task.** `std::thread::sleep`, a blocking file read or
  a long computation stalls every task on that worker thread, just as it would
  stall an `io_context` thread. Use `tokio::time::sleep`, `tokio::fs`, or move
  the work to `tokio::task::spawn_blocking` or rayon.
- **Cancellation is dropping.** Dropping a future cancels it at the `.await`
  where it is suspended, and the destructors of everything it holds run.
  `tokio::time::timeout` and `tokio::select!` are built on this. Code between
  two `.await`s always runs to completion, so keep invariants intact at every
  `.await`.
- **Async spreads.** You can only `.await` inside `async` code. At the
  boundary between synchronous and async code, `Runtime::block_on` runs a
  future to completion, and channels pass data across.

## Networking next to the game loop

A game loop is synchronous and paced by frames, and it should stay that way.
The usual structure runs the async runtime on its own thread and connects it to
the game thread with channels. The game drains what arrived each frame and
never awaits:

```rust,ignore
use std::sync::mpsc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

fn main() {
    let (events_tx, events_rx) = mpsc::channel::<String>();

    // The network thread owns the runtime.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:4000").await.unwrap();
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                let tx = events_tx.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stream).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        // std's unbounded send never blocks, so it is fine in a task.
                        if tx.send(format!("{peer}: {line}")).is_err() {
                            break;      // the game has shut down
                        }
                    }
                });
            }
        });
    });

    // The game thread.
    loop {
        while let Ok(msg) = events_rx.try_recv() {
            println!("{msg}");          // apply to the world
        }
        // update(); render();
        std::thread::sleep(Duration::from_millis(16));
    }
}
```

For the other direction, a `tokio::sync::mpsc::UnboundedSender` can be used
from the game thread without a runtime, and the network task receives with
`.await`. This is the same split many C++ engines make with a network thread
and lock-free queues, with the compiler checking that only `Send` data crosses
it.

## UDP for real-time games

State replication usually goes over UDP, because a lost packet should not
delay every packet after it. As in C++, you build sequence numbers,
acknowledgements and reliability on top. `std::net::UdpSocket` is the plain
socket:

```rust
use std::net::UdpSocket;
use std::time::Duration;

/// True if sequence number `a` is newer than `b`, allowing for wraparound.
fn newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

fn main() -> std::io::Result<()> {
    let server = UdpSocket::bind("127.0.0.1:0")?;
    let client = UdpSocket::bind("127.0.0.1:0")?;
    client.connect(server.local_addr()?)?;             // fixes the peer, as in C

    // Snapshots of one entity's position. Packet 2 arrives after packet 3.
    for (seq, x) in [(1u16, 0.0f32), (3, 2.0), (2, 1.0), (4, 3.0)] {
        let mut pkt = [0u8; 6];
        pkt[..2].copy_from_slice(&seq.to_le_bytes());
        pkt[2..].copy_from_slice(&x.to_le_bytes());
        client.send(&pkt)?;
    }

    server.set_read_timeout(Some(Duration::from_secs(1)))?;
    let mut latest: Option<u16> = None;
    let mut buf = [0u8; 1500];                         // one MTU
    for _ in 0..4 {
        let (n, from) = server.recv_from(&mut buf)?;
        if n != 6 {
            continue;                                  // malformed: drop it
        }
        let seq = u16::from_le_bytes([buf[0], buf[1]]);
        let x = f32::from_le_bytes(buf[2..6].try_into().unwrap());
        if latest.map_or(true, |l| newer(seq, l)) {
            latest = Some(seq);
            println!("apply snapshot {seq} from {from}: x = {x}");
        } else {
            println!("drop stale snapshot {seq}");
        }
    }
    println!("newer(1, 65535) = {}", newer(1, 65535));  // wrapped, still newer
    Ok(())
}
```

`wrapping_sub` states the intent that C++ leaves to unsigned overflow rules.
In Rust, a plain `a - b` on `u16` panics on overflow in debug builds, so
sequence arithmetic must say that it wraps.

You rarely need to write the reliability layer yourself:

| Need | C++ | Rust |
|---|---|---|
| Client/server game transport, reliable and unreliable channels | ENet, yojimbo | [renet](https://docs.rs/renet) |
| QUIC: encrypted, multiplexed streams plus unreliable datagrams | msquic, GameNetworkingSockets | [quinn](https://docs.rs/quinn) |
| Prediction, interpolation and replication for Bevy | (engine-specific) | [lightyear](https://docs.rs/lightyear) |
| Browser clients (WebRTC data channels) | libdatachannel | [matchbox](https://docs.rs/matchbox_socket) |
| Steam networking and lobbies | Steamworks SDK | [steamworks](https://docs.rs/steamworks) bindings |

## RPC

In an engine, RPC shows up between the editor and a running game, between game
servers and backend services, and in remote debug consoles. The choices:

| Approach | Use when |
|---|---|
| Your own request and response enums over TCP | Both ends are your Rust code and the protocol is small |
| gRPC with [tonic](https://docs.rs/tonic) | Other languages are involved, or the schema must evolve |
| [tarpc](https://docs.rs/tarpc) | Rust on both ends; the service is a trait, with no schema file |
| HTTP + JSON with [axum](https://docs.rs/axum) | Web tools, dashboards, anything a browser calls |

### A typed protocol by hand

The core of RPC is a request type, a response type and a function that maps
one to the other. With enums, the server's `match` must handle every request,
so adding a request without implementing it is a compile error rather than an
unhandled opcode in a `switch`. This example uses a text encoding so it runs
without dependencies; in real code, derive serde and send postcard frames as
shown above.

```rust
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::str::{FromStr, SplitWhitespace};

#[derive(Debug)]
enum Request { Spawn { x: f32, y: f32 }, Despawn(u32), Count }

#[derive(Debug)]
enum Response { Spawned(u32), Ok, Count(usize), Error(String) }

fn arg<T: FromStr>(words: &mut SplitWhitespace) -> Result<T, String> {
    let word = words.next().ok_or("missing argument")?;
    word.parse().map_err(|_| format!("bad argument `{word}`"))
}

impl Request {
    fn to_line(&self) -> String {
        match self {
            Request::Spawn { x, y } => format!("spawn {x} {y}\n"),
            Request::Despawn(id) => format!("despawn {id}\n"),
            Request::Count => "count\n".to_string(),
        }
    }
    fn parse(line: &str) -> Result<Request, String> {
        let mut w = line.split_whitespace();
        match w.next() {
            Some("spawn") => Ok(Request::Spawn { x: arg(&mut w)?, y: arg(&mut w)? }),
            Some("despawn") => Ok(Request::Despawn(arg(&mut w)?)),
            Some("count") => Ok(Request::Count),
            other => Err(format!("unknown request {other:?}")),
        }
    }
}

impl Response {
    fn to_line(&self) -> String {
        match self {
            Response::Spawned(id) => format!("spawned {id}\n"),
            Response::Ok => "ok\n".to_string(),
            Response::Count(n) => format!("count {n}\n"),
            Response::Error(e) => format!("error {e}\n"),
        }
    }
    fn parse(line: &str) -> Result<Response, String> {
        let mut w = line.split_whitespace();
        match w.next() {
            Some("spawned") => Ok(Response::Spawned(arg(&mut w)?)),
            Some("ok") => Ok(Response::Ok),
            Some("count") => Ok(Response::Count(arg(&mut w)?)),
            Some("error") => Ok(Response::Error(w.collect::<Vec<_>>().join(" "))),
            other => Err(format!("unknown response {other:?}")),
        }
    }
}

// ---- Server: the game side.
struct World { next_id: u32, alive: Vec<u32> }

fn handle(world: &mut World, req: Request) -> Response {
    match req {                         // a new Request variant fails to compile here
        Request::Spawn { .. } => {
            world.next_id += 1;
            world.alive.push(world.next_id);
            Response::Spawned(world.next_id)
        }
        Request::Despawn(id) => match world.alive.iter().position(|&e| e == id) {
            Some(i) => { world.alive.swap_remove(i); Response::Ok }
            None => Response::Error(format!("no entity {id}")),
        },
        Request::Count => Response::Count(world.alive.len()),
    }
}

fn serve(stream: TcpStream) -> io::Result<()> {
    let mut world = World { next_id: 0, alive: Vec::new() };
    let mut writer = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let resp = match Request::parse(&line?) {
            Ok(req) => handle(&mut world, req),
            Err(e) => Response::Error(e),   // bad input gets an answer, not a crash
        };
        writer.write_all(resp.to_line().as_bytes())?;
    }
    Ok(())
}

// ---- Client: the editor side.
struct Client { writer: TcpStream, reader: BufReader<TcpStream> }

impl Client {
    fn call(&mut self, req: &Request) -> io::Result<Response> {
        self.writer.write_all(req.to_line().as_bytes())?;
        let mut line = String::new();
        self.reader.read_line(&mut line)?;
        Response::parse(&line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

fn main() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let server = std::thread::spawn(move || serve(listener.accept()?.0));

    let stream = TcpStream::connect(addr)?;
    let mut client = Client { reader: BufReader::new(stream.try_clone()?), writer: stream };
    for req in [Request::Spawn { x: 1.0, y: 2.0 }, Request::Spawn { x: 0.0, y: 0.0 },
                Request::Despawn(1), Request::Despawn(9), Request::Count] {
        println!("{req:?} -> {:?}", client.call(&req)?);
    }
    client.writer.write_all(b"teleport 3\n")?;        // what a buggy or hostile client sends
    let mut line = String::new();
    client.reader.read_line(&mut line)?;
    print!("raw: {line}");

    client.writer.shutdown(Shutdown::Write)?;
    server.join().unwrap()
}
```

### gRPC with tonic

When the other end is C++, C#, Python or Go, use a schema. tonic implements
gRPC on tokio, and its code generator turns a `.proto` file into Rust types
and a service trait. The same `.proto` file generates the C++ side, so this is
a common way to add Rust tools to a C++ engine.

```text
editor-rpc/
├── Cargo.toml
├── build.rs
├── proto/editor.proto
└── src/main.rs
```

```protobuf
// proto/editor.proto
syntax = "proto3";
package editor;

service Editor {
  rpc Spawn (SpawnRequest) returns (SpawnReply);
}

message SpawnRequest { float x = 1; float y = 2; }
message SpawnReply { uint32 entity = 1; }
```

```toml
[dependencies]
tonic = "0.14"
tonic-prost = "0.14"
prost = "0.14"
tokio = { version = "1", features = ["full"] }

[build-dependencies]
tonic-prost-build = "0.14"
```

```rust,ignore
// build.rs: runs protoc at build time (see the Assets chapter on build scripts)
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::compile_protos("proto/editor.proto")?;
    Ok(())
}
```

```rust,ignore
// src/main.rs
use std::sync::atomic::{AtomicU32, Ordering};
use tonic::{transport::Server, Request, Response, Status};

pub mod editor {
    tonic::include_proto!("editor");    // the generated types and traits
}
use editor::editor_client::EditorClient;
use editor::editor_server::{Editor, EditorServer};
use editor::{SpawnReply, SpawnRequest};

#[derive(Default)]
struct EditorService { next_id: AtomicU32 }

#[tonic::async_trait]
impl Editor for EditorService {
    async fn spawn(&self, req: Request<SpawnRequest>) -> Result<Response<SpawnReply>, Status> {
        let SpawnRequest { x, y } = req.into_inner();
        if !x.is_finite() || !y.is_finite() {
            return Err(Status::invalid_argument("position must be finite"));
        }
        let entity = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(Response::new(SpawnReply { entity }))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:50051".parse()?;
    tokio::spawn(Server::builder().add_service(EditorServer::new(EditorService::default())).serve(addr));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;   // let the server start

    let mut client = EditorClient::connect("http://127.0.0.1:50051").await?;
    let reply = client.spawn(SpawnRequest { x: 1.0, y: 2.0 }).await?.into_inner();
    println!("spawned entity {}", reply.entity);
    Ok(())
}
```

The handler takes `&self`, not `&mut self`, because requests run concurrently
on several worker threads. Shared state therefore needs atomics or a `Mutex`,
and the compiler enforces it: the service must be `Send + Sync`. In gRPC C++
the same rule exists, but only in the documentation. The code generator needs
`protoc`; install it from your package manager, or add the
`protoc-bin-vendored` crate and point `PROTOC` at it in `build.rs`.

<div class="rfc-callout rfc-engine">
<span class="rfc-callout-title">Engine note</span>

- **One crate, two binaries.** A dedicated server is usually the game crate
  built without rendering, using a Cargo feature or a separate binary target
  ([Cargo, crates and the build](../foundations/cargo.md)).
- **Send handles, not pointers.** Generational handles contain no addresses,
  so they make good network entity ids
  ([Handles and arenas](../engine/handles-and-arenas.md)).
- **Never trust the client.** Every decoder returns `Result`, every length is
  checked against a maximum, and every value is validated before it reaches
  the simulation. Fuzz the decoders.
- **Keep the transport out of the simulation.** Prediction, interpolation
  and lag compensation belong in gameplay code that runs at a fixed tick. The
  network thread only moves bytes and messages.

</div>

## Summary

| C++ | Rust |
|---|---|
| BSD sockets, Winsock | `std::net::{TcpListener, TcpStream, UdpSocket}` |
| `close`, `closesocket` | `Drop` |
| `errno`, `WSAGetLastError` | `io::Result` and `?` |
| `reinterpret_cast` on a packet buffer | Bounds-checked parsing with `from_le_bytes`, or `bytemuck` |
| Protobuf, FlatBuffers, hand-written serializers | serde with postcard or serde_json; prost for Protobuf |
| Asio and C++20 coroutines | tokio and `async`/`.await` |
| `co_spawn` | `tokio::spawn`, which requires `Send + 'static` |
| Network thread with lock-free queues | Runtime thread with channels |
| ENet, GameNetworkingSockets | renet, quinn, steamworks |
| gRPC C++ | tonic |

## Exercises

1. Change the blocking echo server to accept connections in a loop and spawn a
   thread for each. Connect two clients at the same time.
2. Add a `Teleport { entity: u32, x: f32, y: f32 }` request to the typed
   protocol. Which functions fail to compile until you handle it?
3. Call `Msg::decode` on every prefix of a valid packet and check that it
   never panics. Then turn it into a cargo-fuzz target.
4. Port the echo server to tokio, then wrap each `next_line().await` in
   `tokio::time::timeout` so that idle clients are disconnected after ten
   seconds.
