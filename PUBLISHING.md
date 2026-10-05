# npm publication

Version 0.4.0 is prepared; the registry package is not published yet. First create an npm account yourself and enable the account protection required by npm. Do not put tokens in this repository.

From a clean clone, on Node >=24:

```sh
npm ci
npm run typecheck
npm test
npm run check:package
npm login
npm publish --access public
```

Complete any browser/2FA prompt yourself. Check that the account owns the package name; an available-looking name is not a reservation. After publication verify `npm view tarnveil-denoise@0.4.0 version`, install it in a fresh project, run the asset command and process a recording. Then replace the pending-publication text in both READMEs with the registry install command.

CI uploads the tested tarball as an Actions artifact. Model weights remain the verified v0.3.0 GitHub release asset. The package is Apache-2.0; its bundled ONNX Runtime resources include MIT notices.
