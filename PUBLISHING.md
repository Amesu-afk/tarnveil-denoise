# npm publication

Use an npm account with publishing access and two-factor authentication enabled. Do not put tokens in this repository.

From a clean clone, on Node >=24:

```sh
npm ci
npm run typecheck
npm test
npm run check:package
npm run check:node -- tarnveil-denoise-<version>.tgz
npm login
npm publish ./tarnveil-denoise-<version>.tgz --access public
```

Complete any browser/2FA prompt yourself. For later releases, increment package.json and package-lock.json together, update CHANGELOG.md and verify the clean tarball. After publication verify the exact version with `npm view`, install it in a fresh project, run the asset command and process a recording. Publish the matching source commit and release notes on GitHub.

README.md is the English npm page. Keep other translations in docs, with language links in both files. After publication, check that npm reports readmeFilename as README.md.

The installed package and asset command support Node >=18. The Vite example needs Node >=22.12; the benchmark needs Node >=24. CI checks the packed package on Node 18, 20, 22 and 24 separately from the source build.

CI uploads the tested tarball as an Actions artifact. Model weights remain the verified v0.3.0 GitHub release asset. The package is Apache-2.0; its bundled ONNX Runtime resources include MIT notices.
