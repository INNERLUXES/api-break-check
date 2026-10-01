# 1. Compare descriptions, not traffic

## Context

There are two ways to find out whether a new API release breaks old clients. One is to record real traffic, or run the old clients' test suites, against the new release and see what fails. The other is to compare the old and the new OpenAPI description. Traffic shows what clients really do, including calls the description does not list, but it needs a running copy of the new release, real or recorded requests (which hold user data and tokens), and network access from the check. It also only covers the calls that happened to be recorded: a screen that few users open, or an app version that is rarely used, is easily missed.

## Decision

The tool compares two description files. It never sends a request, never replays traffic, and never fetches a `$ref` from another file or an address.

## Consequences

The check runs in any pipeline, on the pull request itself, before anything is deployed, with no network access and no user data. It covers every operation in the description, not only the ones that were called, and the same two files always give the same report. It cannot see what is not in the description: behaviour changes, undocumented endpoints, and a description that has drifted from the code, which docs/limits.md lists. Teams that need those use contract tests or recorded responses next to this check; this check is the cheap first gate that catches the common breaks (a removed field, a new required parameter, a renamed value) at review time.
