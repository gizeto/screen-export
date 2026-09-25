# Agent instructions

- Use generic placeholders such as `GroupA`, `GroupB`, and `GroupName` in tests and committed fixtures. Do not use real release-group names. Sanitize examples when turning them into regression tests.
- Run `node --test tests/*.test.cjs` after behavior changes. Tests must run in Node with an in-memory DOM and mocked browser APIs and transfers. Do not use Chrome or another browser in tests.
- Do not contact slow.pics during development or testing unless the user explicitly authorizes new live requests. Use mocked responses instead.
