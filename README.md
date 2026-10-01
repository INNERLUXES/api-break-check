# api-break-check

Compares two versions of an OpenAPI description and lists the changes that break the clients you already shipped.

One API usually serves more than one client: a web front end that is deployed together with the API, and mobile apps that are not. A web page picks up the new code on the next load. An app on a phone keeps calling the API the way it did on the day it was installed, until its user updates it, and some users never do. A removed field, a new required parameter or a renamed value then breaks those apps with no warning in the API's own tests. This tool reads the old and the new OpenAPI description (3.0 or 3.1, JSON or YAML), compares them operation by operation, and reports every change an older client would trip over.

- Every change has a rule id, a severity (breaking, warning, info), a location (method, path and the place inside it) and a plain message.
- `/orders/{id}` and `/orders/{orderId}` are the same path: renaming a path parameter is not a change.
- Local `$ref` (`#/components/...`) are followed, with protection against schemas that contain themselves. A `$ref` to another file or an address is refused and listed, never fetched.
- It reads the two files you give it and nothing else. It opens no network connection and runs nothing.
- Plain JavaScript, no dependencies; the same two files always give the same report.

```
npm test
```

```
ℹ tests 46
ℹ pass 46
ℹ fail 0
```

## Quick start

Requires Node 22 or newer. There is nothing to install.

```
git clone https://github.com/INNERLUXES/api-break-check.git
cd api-break-check
node bin/api-break-check.js examples/v1.json examples/v2.json
```

Or without a clone:

```
npx --yes github:INNERLUXES/api-break-check old.yaml new.yaml
```

`examples/v1.json` and `examples/v2.json` are two versions of a made-up orders API on api.example.com. The second one renames a path parameter, removes a path and an operation, adds a required parameter, tightens some limits, changes the credentials of one operation and changes the order response:

```
api-break-check: examples/v1.json (Orders API 1.4.0) -> examples/v2.json (Orders API 2.0.0)
20 change(s): 11 breaking, 6 warning, 3 info

BREAKING  enum-value-removed            GET /orders  query parameter status
                                        value(s) "cancelled" no longer accepted; older clients still send them

BREAKING  constraint-narrowed           GET /orders  query parameter limit
                                        maximum lowered from 100 to 50; values that older clients send may now be rejected

BREAKING  param-required-added          GET /orders  query parameter region
                                        new required parameter; older clients do not send it

BREAKING  security-changed              POST /orders  security
                                        changed from bearerAuth to bearerAuth + deviceKey; older clients that use bearerAuth are refused

BREAKING  additional-properties-closed  POST /orders  request body application/json
                                        additionalProperties is now false; older clients that send other fields are rejected

BREAKING  request-property-required     POST /orders  request body application/json: channel
                                        new required property; older clients do not send it

BREAKING  constraint-narrowed           POST /orders  request body application/json: items[].sku
                                        maxLength lowered from 64 to 32; values that older clients send may now be rejected

BREAKING  response-property-removed     GET /orders/{id}  response 200 application/json: note
                                        removed from the response; older clients that read it get nothing

BREAKING  operation-removed             DELETE /orders/{id}
                                        operation removed; older clients that call it get an error

BREAKING  media-type-removed            GET /orders/{id}/receipt  response 200 application/pdf
                                        media type removed; older clients that ask for it get another type or 406 Not Acceptable

BREAKING  path-removed                  /customers/{customerId}/orders
                                        path removed with GET; older clients that call it get an error

WARNING   enum-value-added              GET /orders  response 200 application/json: orders[].status
                                        new value(s) "refunded"; older clients that handle every known value may fail on an unknown one

WARNING   response-property-optional    GET /orders/{id}  response 200 application/json: currency
                                        no longer required: the server may leave it out, and older clients that expect it may fail

WARNING   enum-value-added              GET /orders/{id}  response 200 application/json: status
                                        new value(s) "refunded"; older clients that handle every known value may fail on an unknown one

WARNING   response-property-nullable    GET /orders/{id}  response 200 application/json: total
                                        can now be null; older clients may not handle a null value

WARNING   format-changed                GET /orders/{id}  response 200 application/json: items[].quantity
                                        format changed from int32 to int64; check that older clients can read the new format

WARNING   deprecated                    GET /orders/{id}/receipt  operation
                                        now deprecated; clients should move off it before it is removed

INFO      param-added                   GET /orders  query parameter sort
                                        new optional parameter

INFO      response-property-added       GET /orders/{id}  response 200 application/json: trackingUrl
                                        new property in the response

INFO      path-added                    /orders/{id}/returns
                                        new path with POST

GATE: FAIL - 11 breaking change(s)
```

The exit code is `1`, because breaking changes were found.

## Usage

```
api-break-check [options] <old-spec> <new-spec>
```

The first file is the description the clients were built against, the second is the one you are about to ship. Each can be JSON or YAML (`.yaml` or `.yml`; a file that starts with `{` is read as JSON).

```
--format <name>      text, markdown, json or csv (default: text)
--fail-on <level>    exit with 1 when a change is at this level or above: breaking or warning (default: breaking)
--ignore <ids>       leave out changes with these rule ids, separated by commas; can repeat
--help               show the usage
--version            show the version
```

## Rules

| Id | Severity | What it reports |
| --- | --- | --- |
| `path-removed` | breaking | A path was removed with all its operations |
| `operation-removed` | breaking | An operation (method) was removed from a path |
| `param-required-added` | breaking | A new required query, header, path or cookie parameter |
| `param-made-required` | breaking | An optional parameter became required |
| `param-removed` | breaking / warning | A parameter was removed; a warning when it was optional |
| `type-changed` | breaking | The type of a parameter, body or property changed in a way old clients cannot follow |
| `format-changed` | warning | The format changed, such as `int32` to `int64` |
| `enum-value-removed` | breaking / warning | An enum value was removed: breaking in a request, a warning in a response |
| `enum-value-added` | warning | A response can hold a value that old clients do not know |
| `enum-added` | breaking | A request value that was free is now limited to a list |
| `request-body-required` | breaking | The request body became required, or a required one was added |
| `request-property-required` | breaking | A request property is new and required, or became required |
| `response-status-removed` | breaking / warning | A response status code was removed: breaking for 2xx, a warning for others |
| `response-property-removed` | breaking | A response property was removed |
| `response-property-nullable` | warning | A response value can now be null |
| `response-property-optional` | warning | A response property is no longer required |
| `media-type-removed` | breaking | A media type was removed from a request body or a response |
| `security-changed` | breaking | An operation now needs credentials, or different ones |
| `constraint-narrowed` | breaking | A request value got a lower `maxLength` or `maximum`, or a higher `minLength` or `minimum` |
| `additional-properties-closed` | breaking | A request object no longer accepts extra properties |
| `deprecated` | warning | An operation or a parameter is now deprecated: clients should move off it |
| `path-added` | info | A new path |
| `operation-added` | info | A new operation on an existing path |
| `param-added` | info | A new optional parameter |
| `response-property-added` | info | A new response property |

[docs/method.md](docs/method.md) gives each rule and why it breaks a web front end or an older version of a mobile app.

## Formats

- `text`: for a terminal, breaking changes first.
- `markdown`: one table, for a pull request comment or the job summary. Pipes and line breaks in names from the description are escaped, so a name cannot break the table.
- `json`: the whole report, for other tools.
- `csv`: one row per change, quoted as RFC 4180 says. A cell that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet does not run it as a formula.

## Exit codes

`0` no change at the `--fail-on` level, `1` at least one such change (by default: a breaking change), `2` a usage or input error (a missing file, a file over 20 MB, a description that is not OpenAPI 3.0 or 3.1, a `$ref` to another file or an address, a `$ref` that points to nothing).

## In a pipeline

Compare the description on `main` with the one in the pull request, and fail the job when the pull request breaks existing clients:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    fetch-depth: 0
- name: The description on main
  run: git show origin/main:openapi.yaml > openapi.main.yaml
- name: Check for breaking changes
  run: |
    npx --yes github:INNERLUXES/api-break-check --format markdown openapi.main.yaml openapi.yaml >> "$GITHUB_STEP_SUMMARY"
```

The step summary shows the table; the exit code fails the job. When a breaking change is intended (a new major version, an endpoint that no client uses any more), say so in the pull request and pass `--ignore` with the rule id for that run. Add `--fail-on warning` to stop on warnings too.

If the description is split over several files, bundle it into one file first; the tool does not read the other files.

## Limits

A description says what the API promises, not what the code does. A change in behaviour with the same description, an endpoint that is not in the description, a description that has drifted from the code, and examples are not visible to the tool. [docs/limits.md](docs/limits.md) lists these, with the YAML that is read and the size limits.

## Background

- How web front ends, mobile apps and the API behind them are built and changed together: [full-stack development](https://innerluxes.dev/web-development/full-stack).

## License

MIT
