# Security policy

Flowpeek scans source locally and should not require repository credentials or
target execution. Please report suspected security vulnerabilities privately.

## Reporting

For the public repository, use GitHub's **Report a vulnerability** flow when it
is available. If the repository does not expose that flow, do not create a
public issue containing exploit details, credentials, private paths, or source
content. Contact the repository owner through their GitHub profile and request
a private reporting channel.

Include a minimal reproduction, affected Flowpeek version or commit, operating
system, Node version, impact, and suggested mitigation. Do not attach real
secrets or private repository contents.

## Scope

Relevant reports include unsafe filesystem behavior, archive/export leakage,
credential exposure, unexpected target execution, local-server exposure beyond
the documented loopback boundary, dependency vulnerabilities, and MCP actions
that exceed their declared authority.

The response and disclosure timeline is set by the repository owner. This
policy does not claim a security SLA or a public release approval.
