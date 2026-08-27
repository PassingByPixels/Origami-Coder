# Security

## Supported version

Only the most recent Origami Coder release on the Visual Studio Marketplace is
supported. Older versions get no security fixes.

## Threat model

Origami Coder runs locally and gives the agent shell, file, and web tools. It does
**not** sandbox the agent — the permission prompts keep you aware of what the agent
does, they are not isolation. For real isolation, run the editor in a container or VM.

Server mode is opt-in. Set `ORIGAMI_SERVER_PASSWORD` to require HTTP Basic Auth;
without it the server runs unauthenticated and prints a warning. Securing it is the
user's responsibility.

Out of scope: access to a server you enabled, "escapes" from the permission system,
how your LLM provider handles your data, external MCP servers you configure, and
config files you edit yourself.

## Reporting a security issue

Report privately through the Origami Labs contact form:
<https://origamilabs.nl/support.html>. Do not open a public issue. Include the
version, the steps to reproduce, and the impact.
