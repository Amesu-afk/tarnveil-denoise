# Changelog

## 0.4.1

- Keep the English README at the package root and move the Russian translation to docs, so npm selects the English file.
- Allow Node 18 or newer for package installation and the asset command; check the packed package on Node 18, 20, 22 and 24.
- Put links to TarnVeil and the audio demo near the start of both READMEs.

The audio processing code and model weights are unchanged.

## 0.4.0

- Compiled npm package: ESM, declarations, bundled Worker/AudioWorklet and matching ONNX Runtime 1.29.0 resources.
- Asset preparation CLI verifies the v54 model SHA-256; weights remain a separate download.
- Runnable microphone/file recorder example and a packed-consumer build check.
- Correct latency, mixed-fixture labels, narrow benchmark claims and production Vite instructions in both READMEs.
- Worker reuse respects model/runtime/module URLs; disposal is idempotent and failed workers are discarded.
- Reproducible v54 WAV demo renderer with model/input hashes.

The model remains smartnet-v54-psa from release v0.3.0. This is a packaging/documentation release, not new weights.
