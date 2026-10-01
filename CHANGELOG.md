# Changes

## 1.0.0

First release.

- Compares two OpenAPI 3.0 or 3.1 descriptions, read from JSON or from the YAML that OpenAPI files use (block mappings and sequences, plain and quoted scalars, block scalars, flow collections, comments).
- Twenty-five rules, from removed paths and new required parameters to narrowed request limits, closed request objects, changed credentials and response values that can now be null.
- Paths matched with their template parameter names normalised, so `/orders/{id}` and `/orders/{orderId}` are the same path.
- Local `$ref` followed, `allOf` merged, schemas that contain themselves compared without looping; a `$ref` to another file or an address is refused and listed, never fetched.
- Reports as text, Markdown, JSON and CSV; `--fail-on` and `--ignore` for a pipeline gate.
- Bounded input: files over 20 MB refused, nesting over 128 levels refused, `$ref` chains over 32 steps stopped, schemas compared to 64 levels, at most 10,000 operations per description.
- Release packages come with a CycloneDX SBOM, SHA-256 checksums and a build provenance attestation.
