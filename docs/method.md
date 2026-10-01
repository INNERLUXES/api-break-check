# Method

The tool answers one question: can a client that was built against the old description still use the API described by the new one? It reads both descriptions, matches their paths and operations, and compares what a client sends (parameters and request bodies) and what it receives (status codes and response bodies). The rules follow the [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) for what each field means.

## Two kinds of client

- **A web front end** is usually deployed with the API, or soon after it. It still breaks: a page that is open in a browser keeps running the old code until it is reloaded, a front end deployed from another repository can lag behind, and a cached bundle can be served for a while after a release. The window is short, but every user in it sees errors.
- **A mobile app** cannot be updated by the team. Each version that was ever installed keeps calling the API the way it did when it was built, until its user updates it. Store review delays a fix by days, and some users never update. A breaking change in the API is therefore a breaking change for every old version still in use, for as long as it is in use.

A change is **breaking** when an old client that follows the old description gets an error, loses data, or reads a value it cannot handle. It is a **warning** when old clients may fail depending on how they were written. It is **info** when old clients are not affected and the change is worth knowing about.

## Matching

1. **Paths.** Template parameter names are replaced by `{}` before paths are compared, so `/orders/{id}` and `/orders/{orderId}` are the same path: a client sends the same URL for both. When two paths of one description become the same path this way, the first is compared and the report notes the second.
2. **Operations.** The methods `get`, `put`, `post`, `delete`, `options`, `head`, `patch` and `trace` of each path item are compared one by one.
3. **Parameters.** Path-level and operation-level parameters are merged; an operation-level parameter replaces a path-level one with the same name and location. Query, header and cookie parameters are matched by location and name (header names without regard to case, as HTTP requires). Path parameters are matched by their position in the path template, so a renamed path parameter is the same parameter.
4. **Media types.** Request and response content is matched by media type, without regard to case.
5. **References.** Every local `$ref` (`#/components/...`, or any JSON pointer into the same file) is followed. `allOf` parts are merged into one schema before it is compared, so a schema built from a base and an extension is compared as a whole.

## The rules

| Id | Severity | Why it breaks a client |
| --- | --- | --- |
| `path-removed` | breaking | Every call an old client makes to the path now gets an error, usually 404. A screen that depends on it stops working in every app version that calls it |
| `operation-removed` | breaking | The same for one method of a path: the call gets 404 or 405 Method Not Allowed |
| `param-required-added` | breaking | Old clients do not know the parameter, so they never send it, and the server rejects every one of their requests. This holds for query, header, path and cookie parameters |
| `param-made-required` | breaking | Old clients that left the optional parameter out, which is allowed by the old description, are now rejected |
| `param-removed` | breaking / warning | Old clients still send the parameter. A server that rejects unknown parameters refuses the request; one that ignores them silently drops what the client asked for (a filter, a page size). A removed required parameter is breaking, because every old request carries it; a removed optional one is a warning |
| `type-changed` | breaking | In a request, old clients still send the old type and the server rejects it. In a response, old clients parse the new type as the old one: a string where a number was read crashes a strictly typed app, and JavaScript code does arithmetic on text. A request type that is widened (an integer where a number is now allowed, or a second accepted type) is not reported, nor is a response type that is narrowed |
| `format-changed` | warning | The type is the same but its format is not: `int32` to `int64` overflows a 32-bit integer in an old app, `date` to `date-time` fails a strict date parser. Many clients ignore the format, so this is a warning |
| `enum-value-removed` | breaking / warning | In a request, old clients still send the removed value and are rejected (breaking). In a response, old clients simply never see the value again; screens that wait for it may never change (warning) |
| `enum-value-added` | warning | A response can now hold a value that old clients do not know. A mobile app that maps each value to a screen, or a `switch` without a default branch, fails on the unknown value. A response enum that is removed altogether is reported the same way, since any value can now arrive |
| `enum-added` | breaking | A request value that was free text is now limited to a list. Old clients may send values that are not on it |
| `request-body-required` | breaking | Old clients that send no body, which the old description allowed, are rejected. This also covers an operation that had no body and now requires one |
| `request-property-required` | breaking | A new required property in a request body is never sent by old clients; an existing property that became required is left out by those that treated it as optional. Properties marked `readOnly` are skipped, since clients do not send them |
| `response-status-removed` | breaking / warning | A removed success code (2xx) means old clients get an answer they treat as a failure, or read a body in a shape they do not expect (breaking). A removed error code is a warning: the server now answers that case with another code, and old clients may not handle it |
| `response-property-removed` | breaking | Old clients still read the property. They get nothing where a value was promised: an empty field on a screen, a crash on a missing value in a strictly typed app. Properties marked `writeOnly` are skipped |
| `response-property-nullable` | warning | A value that could not be null now can be: `nullable: true` in 3.0, or `"null"` in the type list in 3.1. Old apps that read it as a plain string or number may crash on null |
| `response-property-optional` | warning | The property is no longer in `required`, so the server may leave it out. Old clients that expect it fail when it is missing |
| `media-type-removed` | breaking | In a request, old clients still send the removed type and get 415 Unsupported Media Type. In a response, old clients that ask for it with `Accept` get 406 Not Acceptable or a body they cannot read |
| `security-changed` | breaking | The operation now needs credentials where it needed none, or credentials of another kind, or more scopes. Old clients do not send them and get 401 or 403. The effective requirement is the operation's own `security`, or the top-level one when the operation has none. Adding an alternative, or dropping the requirement, does not break anyone and is not reported |
| `constraint-narrowed` | breaking | In a request, a lower `maxLength` or `maximum`, or a higher `minLength` or `minimum` (or one of them added where there was none), rejects values that were valid before. An old app with the old limit in its form lets users enter them |
| `additional-properties-closed` | breaking | A request object that accepted extra properties (`additionalProperties` absent, `true` or a schema) now has `additionalProperties: false`. Old clients that send fields the new description does not list, such as a field that was removed, are rejected |
| `deprecated` | warning | An operation or a parameter is now marked `deprecated`. Nothing breaks yet, but it will be removed: clients should move off it, and the team can count how many app versions still use it before removing it |
| `path-added` | info | A new path. Old clients do not call it |
| `operation-added` | info | A new method on an existing path |
| `param-added` | info | A new optional parameter. Old clients do not send it and get the default |
| `response-property-added` | info | A new property in a response. Old clients ignore it, unless they reject unknown properties: such clients are rare, but they exist |

## How schemas are compared

1. Both schemas are resolved (a `$ref` is followed) and their `allOf` parts are merged.
2. The direction decides what is safe. In a **request** the new schema must accept everything the old one accepted. In a **response** the old client must understand everything the new schema allows.
3. Types are compared as sets (`type: string` in 3.0, `type: [string, "null"]` in 3.1); `null` is handled as nullability, not as a type. An integer counts as a number. When the type changes in a breaking way, the schema below it is not compared further, since every part of it changed with it.
4. Properties are compared by name: required ones in a request, removed, optional and new ones in a response. Then every property present in both is compared in the same way, as are array `items`, a schema under `additionalProperties`, and `oneOf` and `anyOf` variants in the same position.
5. A schema that contains itself, directly or through other schemas, is compared once. Each pair of schemas reached through a `$ref` is compared once per operation and direction, at the first place it is found. This ends cycles, and it keeps a shared schema such as an address, used for both billing and shipping, from being reported twice in one operation. Each operation that uses it reports it again, since each is a separate call that breaks.
6. Comparison stops 64 levels deep, and the report says where.

## Severity and the gate

`--fail-on breaking`, the default, makes the run exit with `1` when any breaking change is found. `--fail-on warning` also fails on warnings. Info never fails a run. `--ignore` leaves out the named rules from the report and from the gate, for a release where a breaking change is intended.

The method has no randomness and no network access: the same two files always give the same report, and any change in the report comes from a change in the files.
