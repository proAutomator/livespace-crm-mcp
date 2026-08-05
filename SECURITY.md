# Security Policy

## Reporting a vulnerability

Please report security issues privately to **kuba@proautomator.pl**.
Do not open a public issue for vulnerabilities. You will get an acknowledgement
within a few days; please allow reasonable time for a fix before disclosure.

## Scope

This project is an **unofficial** MCP server that talks to the Livespace CRM
API using credentials supplied by the operator. Vulnerabilities in Livespace
itself should be reported to Livespace S.A., not here.

## Supported versions

The project is in early development (pre-1.0). Only the latest release / main
branch receives fixes.

## Security design

The threat model and the concrete security requirements the implementation
must satisfy are documented in [docs/security.md](docs/security.md).
