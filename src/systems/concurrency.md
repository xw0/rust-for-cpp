# Threads, locks and Send/Sync

<div class="rfc-planned">

**This chapter is planned.** It will cover:

- `std::thread::spawn` and scoped threads
- `Send` and `Sync`: data races as compile errors
- `Mutex<T>` owns the data it protects (vs std::mutex next to the data)
- Atomics and memory ordering (same model as C++11)
- Channels, and data parallelism with rayon (job systems)

</div>

*C++ starting point: std::thread, std::mutex, std::atomic.*
