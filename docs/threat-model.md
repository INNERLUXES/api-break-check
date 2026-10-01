# Threat model

## What the tool touches

- It reads the two files named on the command line, and only those. A `$ref`, a server address or any other value inside a description is data, never something to open or fetch.
- It writes only to the screen (standard output and standard error).
- It opens no network connection and runs nothing from the files it reads.

## What the input may hold

An OpenAPI description is often written by another team, taken from a pull request, or produced by a build step, so the tool treats it as possibly hostile. A description can also hold internal details: private paths, internal server addresses, the names of security schemes and scopes. They appear in the report only where a change is found.

## What could go wrong, and what stops it

| Risk | Control |
| --- | --- |
| A `$ref` makes the tool fetch an address (to reach an internal service, or to leak that a check ran) | Only references inside the same file are followed. Any other `$ref` stops the run with exit code 2 and a list of the references; nothing is fetched or opened |
| A `$ref` reads a file from the disk | Same: a file reference is refused, never opened |
| A JSON pointer reaches outside the document (`#/constructor`, `#/__proto__`) | Pointers follow own properties only; anything else is a reference that points to nothing, which stops the run |
| A YAML key such as `__proto__` changes the prototype of an object | Every parsed key is stored as a plain own property; `allOf` merging skips `__proto__` |
| A schema that contains itself makes the comparison loop forever | Each pair of schemas reached through a `$ref` is compared once per operation and direction; chains of `$ref` stop after 32 steps or when they come back to themselves |
| Shared schemas make the work grow exponentially | The same once-per-operation rule, a depth limit of 64 levels, and a ceiling of 500,000 schema comparisons per run, with a note when it is reached |
| A huge or deeply nested file exhausts memory or the stack | Files over 20 MB are refused before they are read; nesting over 128 levels is refused; the YAML parser counts its depth; the nesting and reference walks use no recursion |
| A description with very many operations slows the run | More than 10,000 operations per description is refused |
| A name in the description rewrites the terminal through escape sequences | Text from a description has control characters removed and its length capped before it reaches a change |
| A name breaks a Markdown table | Pipes and line breaks are escaped in every table cell |
| A CSV report runs a formula when opened in a spreadsheet | Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`; every cell is quoted as RFC 4180 says |
| YAML that the parser does not understand is read wrongly, and a breaking change is missed | Anchors, aliases, tags, complex keys, several documents and tabs in indentation are refused with the line number; tests compare the YAML copy of the example with the JSON original |
| A breaking change is reported as safe | Each rule has tests with hand-written descriptions; the worked example checks the full report on every pipeline run |
| A broken file gives a misleading clean report | A file that is not OpenAPI 3.0 or 3.1, that holds no object, or that has a `$ref` pointing to nothing stops the run with exit code 2 and the file name |

## Out of scope

Whether the description matches the code, how the descriptions were produced and who may read them, and the API itself. docs/limits.md lists what a description cannot show.
