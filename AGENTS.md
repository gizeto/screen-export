# Agent instructions

- Keep all docs and comments concise.
- Use generic names such as `GroupA` in tests and fixtures; sanitize real examples.
- After behavior changes, run `node --test tests/*.test.cjs`. Use Node, an in-memory DOM, and mocked browser APIs and transfers; no browser tests.
- Do not contact image-hosting or tracker URLs without explicit user permission.
- Add torrent-tracker domains to code only when strictly necessary.
