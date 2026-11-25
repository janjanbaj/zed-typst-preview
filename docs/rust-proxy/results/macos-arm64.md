# Native proxy trial on macOS ARM64

Five alternating Node/Rust pairs used Node 26.3.0, a release Rust build, Tinymist 0.14.10 / Typst 0.14.2, and the same public Markdown fixture of roughly 100 KiB. Each session fetched Tinymist's HTML over loopback, waited one second, and sent 30 unsaved full edits and real completion requests. It sampled RSS every fifth request and again half a second after closing the document.

| Median across five sessions | Node | Rust |
|---|---:|---:|
| Idle proxy RSS | 69.9 MiB | 3.1 MiB |
| Highest sampled proxy RSS during edits | 102.1 MiB | 4.0 MiB |
| Proxy RSS after closing the fixture | 99.9 MiB | 4.0 MiB |
| Idle Tinymist RSS | 98.0 MiB | 98.8 MiB |
| Preview HTTP ready, sampled at 100 ms intervals | 118.4 ms | 118.6 ms |
| Median completion round trip | 4.04 ms | 2.26 ms |
| p95 completion round trip | 12.47 ms | 8.25 ms |

The raw rows record RSS in KiB and latency in milliseconds. [Raw data](macos-arm64-rss.jsonl)

To repeat after building the release binary:

```sh
PROXY_TEST_BINARY="$PWD/target/release/typst-preview-proxy" \\
  TINYMIST_TEST_BINARY="/absolute/path/to/tinymist" \\
  node scripts/benchmark-proxy.mjs
```

This is a short local RSS trial. The release gate calls for physical footprint, longer workloads, repeated open/close cycles, and manual Zed and browser verification. Browser WebSocket behavior and other operating systems remain to be verified before considering a default switch.
