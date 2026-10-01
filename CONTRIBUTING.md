# Contributing

Every change goes through a pull request and is reviewed before it is merged. The pipeline runs the tests on Linux, Windows and macOS, the repository checks, CodeQL, and a secure development check of the repository itself.

## Changing a rule

1. Describe the change in docs/method.md first: what changes in the description, and why a web front end or an older version of a mobile app fails on it.
2. Add a test with two small, made-up descriptions where the result can be worked out by hand.
3. Text taken from a description goes through `safeText` before it reaches a change.
4. A rule id, once released, keeps its meaning: pipelines pass it to `--ignore`.

## Rules for the code

- No runtime dependencies. Node 22 or newer and nothing else.
- The tool reads the two files it is given and writes only to the screen. It opens no network connection, follows no `$ref` outside the file and runs nothing.
- Never commit a real company's API description, even as a fixture. Use made-up APIs on example.com and example.org.

## Before you open the pull request

```
npm test
npm run check
npm run example
```
