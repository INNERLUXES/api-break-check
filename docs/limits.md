# Limits

## What a description cannot show

- **Behaviour changes.** The description can stay the same while the code changes what it does: a default page size that drops from 50 to 20, a sort order that flips, a field that now holds cents instead of units, a rate limit that gets stricter, a status that is set later in a flow. Old clients break, and no description diff can see it. Contract tests and recorded responses cover this; this tool does not.
- **Endpoints that are not in the description.** An endpoint the code serves but the description does not list (an internal route a mobile app found and uses, an old version kept for one client) is invisible. Removing it breaks those clients, and the tool reports nothing.
- **Drift between the description and the code.** The tool compares two descriptions, not two releases. A description that was not updated with the code, or that is written by hand and has fallen behind, gives a clean report for an API that has changed. Produce the description from the code, or test the code against it, so the two cannot drift apart.
- **Examples, descriptions and summaries.** `example`, `examples`, `description` and `summary` are not compared. A changed example can be a sign of a changed meaning, but it is not a contract.
- **Headers and links in responses.** Response headers, `links` and `callbacks` are not compared, nor are `webhooks` in 3.1.
- **Security schemes themselves.** The rule `security-changed` compares which schemes and scopes an operation requires. A change inside a scheme with the same name (an API key moved from a header to a query parameter, a new token address) is not reported.
- **Complex schemas.** `oneOf` and `anyOf` variants are compared by position, so reordering them gives misleading results, and an added or removed variant is not reported. `not`, `if` / `then` / `else`, `patternProperties`, `dependentRequired`, `pattern`, `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`, `minItems`, `maxItems` and `uniqueItems` are not compared. `discriminator` mappings are not checked.
- **Who uses what.** The tool cannot know whether any client still calls a removed operation. A breaking change to an endpoint that no app version uses any more is still reported; decide with your own usage data, and use `--ignore` for that run.
- **Server URLs.** A change in `servers` (a new base path, a new host) moves every endpoint for clients that read it from the description, but most clients have the address built in. It is not compared.

## What is read

- **OpenAPI 3.0 and 3.1** only. Swagger 2.0 is refused; convert it to OpenAPI 3 first.
- **One file per description.** A `$ref` to another file or to an address (`common.yaml#/Order`, `https://...`) is refused with a list of every such reference and where it is. Bundle a description that is split over several files into one file first, with the bundling command of your OpenAPI tooling, and compare the bundled files.
- **JSON** fully, as `JSON.parse` reads it.
- **YAML**: the subset that OpenAPI files use. That is block mappings and block sequences (including `- key: value` items), plain, single-quoted and double-quoted scalars (also over several lines), literal (`|`) and folded (`>`) block scalars with their chomping and indentation indicators, flow sequences and mappings (`[a, b]`, `{a: 1}`), comments, one leading `---` and a trailing `...`. Plain scalars follow the YAML 1.2 core schema: `true`, `false`, `null`, `~`, numbers; everything else is a string, and keys always stay strings. Anchors and aliases (`&a`, `*a`), tags (`!!str`), complex keys (`? `), several documents in one file, and tabs in indentation are refused with the line number, rather than read wrongly. A file that uses them can be converted to JSON first with any YAML tool, and the JSON compared.

## Size

- Files over 20 MB are refused before they are read.
- Objects and arrays nested more than 128 levels deep are refused.
- A chain of `$ref` that points to `$ref` is followed for 32 steps; a longer chain, or one that comes back to itself, is treated as an empty schema.
- Schemas are compared to a depth of 64 levels. Deeper parts are not compared, and the report says where it stopped.
- A description with more than 10,000 operations is refused.
- At most 500,000 schema comparisons are made in one run; past that, the report says the rest was not compared.

Every limit is reported, as an error or as a note, so a cut is never silent.
