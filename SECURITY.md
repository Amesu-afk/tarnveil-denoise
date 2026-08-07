# Security Policy

## Scope and expectations

This package runs untrusted audio through a neural network inside the browser. It does
not open sockets, does not read or write storage, and does not send anything anywhere:
the only network requests it makes are the two you configure — the model file and the
onnxruntime wasm runtime.

There is one maintainer and no support commitment. Fixes land when there is time, not on
a schedule.

## What counts as a vulnerability here

- code execution or memory corruption reachable from crafted audio input;
- the node sending audio anywhere other than the Web Audio graph it was connected to;
- the worker or worklet loading code from an origin other than the `ortBase` and
  `workerUrl` supplied by the host application.

## What does not

- **Poor suppression on some noise.** The model has measured limits and the README states
  them, including the one we could not fix: keyboard clicks under speech.
- Dropouts under CPU starvation. On overload the node reports `overrun` and opens a
  passthrough by design — audio keeps flowing unprocessed.
- Anything about the weights being reconstructible. They are published; nothing about the
  training data is secret, and the model is not a secret-holding component.

## Reporting

Open a private security advisory through GitHub on this repository. If you would rather
not use GitHub, open a normal issue saying only that you have something to report, with
no details, and wait to be contacted.

Please include a way to reproduce. For an audio-triggered issue, the input file matters
more than the description.
