# S2.3 performance evidence

## Measured clean candidate, 2026-11-17

Source cc24affd970b3f4fb478f58f1dceb218708f7753, local debug Windows build, 1920×1080. One five-second sample of the exact VELORA main process while YouTube was foreground measured **0.125 CPU seconds / 5 seconds** (2.5% of one logical core), **56,057,856 bytes working set**, **10,231,808 private bytes**, and 36 threads. This excludes WebView2/Edge child processes, is not whole-system idle CPU, and is not a release-build benchmark. The sandbox could not read the process identity; the successful read-only sample used the exact executable path outside the sandbox. The failed empty sample is not evidence.

Five accepted simulator receipts measured **23, 24, 53, 119, 115 ms**, median 53 ms, maximum 119 ms. The deliberately imposed 600 ms GUI release delay is excluded. This sample is too small for reliable percentiles and says nothing about USB/Bluetooth latency. Spatial failure omitted query metrics and reported dispatch 0: no actual zero-duration UIA result is claimed. Service-switch time, playback frame drops, long-run CPU, high DPI and secondary-display performance remain unmeasured.

The actual sanitized receipts and scope are linked from the Computer Use report. Configured bounds below remain engineering limits rather than measured guarantees.

No physical-controller latency, whole-system idle CPU, playback performance or service-switching percentile is invented. Measurements from the final candidate are recorded in delivery evidence, with their actual scope and sample size.

Configured engineering bounds:

| Work | Bound |
| --- | --- |
| Existing native input queue | 8 packets; nonblocking producer |
| Physical report sampling | 33 ms minimum unchanged sample interval |
| Stale action/report rejection | 200 ms; monotonic queue age independent of input source clock |
| Direction repeat | 320 ms first repeat, then 160 ms, accelerated to 110 ms |
| Stick thresholds | Left 0.35; right 0.25; finite values and bounded acceleration |
| Simulator | Single active native dispatch, monotonic sequence, 600 ms deliberate UI release delay |
| Caller wait | 700 ms before revoking unexecuted input; unknown outcome is not retried |
| UIA discovery | 256 nodes / 32 depth / 40 ms cooperative traversal |
| UIA action | 250 ms cooperative budget; provider connection/transaction timeout 100 ms |
| UIA cache | 500 ms maximum reused candidate age; stale identity/geometry failure invalidates |
| Evidence | At most 64 receipts; no page-content logging |

These are configured limits, not measured guarantees. Synchronous UIA provider calls can overrun cooperative checks; final authorization prevents a delayed provider result from automatically clicking another control. Home uses its existing independent mechanism. Native dispatch receipts measure work inside the worker; they exclude the simulator's deliberate 600 ms GUI delay and do not represent USB/Bluetooth DS4 latency.

There is no new permanent polling thread for candidate discovery, no tree scan on every keyboard/pointer action, no process-name enumeration for streaming ownership, no automatic retry after failure, and no unbounded native input queue. The existing pointer indicator hides on stale feed/focus loss. Simulator cursor state is per owned target/generation on the single native worker; physical pointer input remains based on the actual Windows cursor.
