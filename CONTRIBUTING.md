# Contributing

This repository is a one-way mirror of the denoise directory in the TarnVeil monorepo. Changes submitted here are applied upstream and exported with contributor authorship preserved. There is one maintainer; response times vary.

## Useful contributions

- Reproduce the recorder on Firefox/Safari and report browser, OS, hardware, sample rate, startup/failure messages and an audio comparison you have permission to share.
- Improve integration examples for a specific bundler or WebRTC capture flow.
- Report model failures on held-out recordings with input/output and exact pipeline/model version.
- Improve accessibility and cleanup in the local recorder.

Ideas about training or click removal are welcome with an evaluation plan. Avoid claiming improvements from one fixture or generator score. Real microphone A/B testing is needed before promoting new weights.

## Checks

```sh
npm ci
npm run typecheck
npm test
npm run check:package
```

For quality changes, also run the benchmark on Node >=24 and attach results and model hash. Do not include private recordings, credentials or downloaded weights in a pull request. See SECURITY.md for private security reports.
