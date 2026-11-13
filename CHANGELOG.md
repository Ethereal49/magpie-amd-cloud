# Changelog

## 0.1.0 - 2026-11-13

- Initial release of `magpie-amd-cloud`.
- Adds two providers in one plugin: `amd-cloud` (AMD Radeon Cloud, CN) and `amd-cloud-lab` (AMD TokenLab, international).
- API key sign-in for both sites, live chat-model catalog fetch with static fallbacks, direct OpenAI-compatible chat completions.
- CN site: rolling 24h quota window via `/v1/usage` with pts display.
- International site: local point-consumption estimate from response `usage.cost`, profile-page guidance for authoritative balance and renewal.
- Zero runtime dependencies; Node test suite included.
