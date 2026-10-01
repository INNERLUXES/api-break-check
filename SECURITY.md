# Security

## Reporting a problem

Write to info@innerluxes.dev with the subject line "api-break-check security", or use private vulnerability reporting on this repository. Please do not open a public issue for a vulnerability.

Include two small made-up descriptions (example.com addresses, no real API names, keys or tokens) that show the problem, what you expected and what happened.

## Scope

In scope:

- a description that makes the tool open a network connection, read a file it was not given, or run something
- a `$ref` to another file or an address that is followed instead of refused
- an input that makes the tool hang, overflow the stack or use unbounded memory
- a name or value from a description that breaks a Markdown table, injects a formula into a CSV report, or rewrites the terminal through control characters
- a breaking change that is reported as safe, or not reported at all, when the rule for it in docs/method.md says it should be
- a YAML file that is read differently from the way YAML reads it, instead of being refused

Out of scope: changes that a description cannot show (docs/limits.md lists them), and how the descriptions were written or stored.

Read [docs/threat-model.md](docs/threat-model.md) for the rest.
