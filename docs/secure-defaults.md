# Secure defaults

The default run is the safe run. Nothing below needs a flag, and none of it can be switched off.

## How the tool behaves by default

- **No network.** The tool reads the two files it is given and sends nothing anywhere. It does not fetch a `$ref` that names another file or an address, it does not contact the servers listed in the description, and it does not check for updates. It can run in a locked-down build job with no outbound access at all.
- **External references are refused, not skipped.** A `$ref` to another file or an address stops the run with exit code 2 and lists every such reference with the place it was found. Skipping them would compare an incomplete description and could report a clean result for a change hidden in the part that was skipped.
- **No dependencies.** Node 22 or newer and nothing else, so there is no third-party code in the path of a description that may hold internal paths and server addresses.
- **Nothing is executed.** No part of the input is run, evaluated or used as a path. JSON is read with `JSON.parse`; YAML is read by a small parser in this repository that only builds plain data: no tags, no custom types, no aliases.
- **YAML that is not understood is refused.** Anchors, aliases, tags, complex keys, several documents in one file and tabs in indentation stop the run with the line number. The parser never guesses, so a file is either read the way YAML reads it or not read at all.
- **Bounded input.** Files over 20 MB are refused before they are read. Nesting over 128 levels is refused. Chains of `$ref` stop after 32 steps. Schemas are compared to 64 levels. A description with more than 10,000 operations is refused. A run makes at most 500,000 schema comparisons. The report says when a limit was reached, so a cut is never silent.
- **Cycles end.** A schema that contains itself is compared once per operation and direction, and a `$ref` chain that comes back to itself ends at once. No description can make the tool loop.
- **Clean output.** Text from a description shown in a report has control characters removed and its length capped, so a hostile name cannot rewrite the terminal. Markdown cells escape pipes and line breaks. CSV cells are quoted as RFC 4180 says, and a cell that a spreadsheet would read as a formula gets a leading `'`.
- **Fails closed.** A missing file, a file over the limit, a file that is not OpenAPI 3.0 or 3.1, a description that holds no object, or a `$ref` that points to nothing stops the run with exit code 2 and the file name, instead of a clean report about nothing.
- **The gate is on.** Without any option, a breaking change makes the run exit with `1`. A pipeline that adds the tool is protected from the first run; there is no report-only mode to forget to turn off.
- **Assumes the stricter case.** When it is unclear whether a change hurts old clients, it is reported: a removed response property is breaking even if no client might read it; a request object that gets `additionalProperties: false` is breaking even when the old description did not say anything about extra fields, since an absent `additionalProperties` allows them.
- **Writes nothing to disk.** The report goes to the screen. Redirect it to a file, or to the job summary, only when you need to keep it.

## Running it in a pipeline safely

1. Take the old description from the protected branch, not from the pull request. `git show origin/main:openapi.yaml > openapi.main.yaml` reads the reviewed version; a pull request cannot change what it is compared against.
2. Run the check on the files only. The job needs read access to the repository and nothing else: no deploy keys, no tokens for the API, no network access to the servers in the description.
3. Use the tool from a pinned commit. `npx --yes github:INNERLUXES/api-break-check#<commit>` runs exactly the code that was reviewed, not whatever the default branch holds on the day.
4. Keep the default `--fail-on breaking`, and add `--fail-on warning` once the warnings of the current description are understood. A new `response-property-nullable` or `enum-value-added` is often what crashes an older mobile app.
5. Write the Markdown report to the job summary, so the reviewer sees the table next to the diff, and keep the exit code as the gate.
6. When a breaking change is intended, write down why in the pull request and pass `--ignore` with only the rule ids that are expected, for that run only. Do not keep a permanent ignore list in the pipeline: it hides the next change of the same kind.
7. Bundle a description that is split over several files in a step of its own, with your OpenAPI tooling, before this check. The bundling step is the only one that reads the other files, and it can be pinned and reviewed on its own.

## Releasing an API change safely

The tool tells you that a change breaks old clients; these are the usual ways to ship the change without breaking them.

1. **Add, do not change.** Add a new property or a new operation next to the old one, mark the old one `deprecated`, and keep serving both. The `deprecated` warning in the report is the reminder that the old one still has to go, later.
2. **Make new parameters and properties optional,** with a server-side default that matches what old clients expect. A required parameter can become required in a later version, once the old app versions are gone.
3. **Never narrow what old clients send.** Widen limits and enums in a request freely; narrow them only after the clients that send the old values are gone.
4. **Never surprise old clients with new values.** Before adding an enum value to a response, or making a value nullable, check that every supported app version handles an unknown value or a null. If not, send the new value only to clients that announce they understand it (a version header, a new endpoint).
5. **Version the breaking change.** When a change must break, put it under a new path or version (`/v2/orders`) and keep the old one running until usage data shows that no supported app version calls it.
6. **Set a support window for app versions,** and a minimum version that the API checks, so a breaking change can be released when the window has passed and old apps are asked to update instead of failing silently.

## Sharing a report safely

1. A report shows paths, parameter names, property names, enum values and security scheme names from the descriptions, exactly where a change was found. For a public API that is harmless. For an internal API it can show internal paths: share the report with the people who can see the description.
2. The report never shows server addresses, examples or descriptions from the files, and holds no credentials, since descriptions do not hold them. If a description does hold a secret (a key pasted into an example), the tool does not show it, but the description itself should be fixed.
3. Prefer the Markdown or text report over the raw descriptions when you ask another team whether a change affects them.

## Writing descriptions the tool can check well

1. Keep one description per API, bundled into one file, in the same repository as the code, and change it in the same pull request as the code.
2. Mark everything clients must send as `required`, and everything the server always returns as `required` in the response schema. A response property that is not required cannot be reported as `response-property-optional` when it is dropped from `required`, because it never was.
3. Write `nullable: true` (3.0) or `type: [..., "null"]` (3.1) wherever a value can be null. Then the tool can report when a value becomes nullable.
4. Use `enum` for every closed list of values in responses, so a new value is reported before an old app meets it.
5. Use `readOnly` and `writeOnly` on properties that only go one way, so required read-only properties are not reported as missing from old requests.
6. Give limits (`maxLength`, `maximum`) to request values, so narrowing them later is reported.
