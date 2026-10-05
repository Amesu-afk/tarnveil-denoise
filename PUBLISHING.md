# npm publication

Use an npm account with publishing access and two-factor authentication enabled. Do not put tokens in this repository.

From a clean clone, on Node >=24:

```sh
npm ci
npm run typecheck
npm test
npm run check:package
npm login
npm publish --access public
```

Complete any browser/2FA prompt yourself. For later releases, increment package.json and package-lock.json together, update CHANGELOG.md and verify the clean tarball. After publication verify the exact version with `npm view`, install it in a fresh project, run the asset command and process a recording. Publish the matching source commit and release notes on GitHub.

CI uploads the tested tarball as an Actions artifact. Model weights remain the verified v0.3.0 GitHub release asset. The package is Apache-2.0; its bundled ONNX Runtime resources include MIT notices.
