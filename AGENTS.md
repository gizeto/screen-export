# Agent instructions

- Keep docs and comments concise; include only information that helps readers understand or use the project, and avoid repeating details already clear from the code or interface.
- Prefer the simplest code that meets the current requirements. Reuse existing patterns and avoid abstractions, configuration, or special cases without a concrete need.
- Use generic names such as `GroupA` in tests and fixtures; sanitize real examples.
- After behavior changes, run `node --test tests/*.test.cjs`. Use Node, an in-memory DOM, and mocked browser APIs and transfers; no browser tests.
- Do not contact image-hosting or tracker URLs without explicit user permission.
- Add torrent-tracker domains to code only when strictly necessary.
