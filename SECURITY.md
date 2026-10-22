# Security Policies and Procedures

This document outlines security procedures and general policies for the
PassportKit project.

- [Disclosing a security issue](#disclosing-a-security-issue)
- [Vulnerability management](#vulnerability-management)
- [Scope](#scope)
- [Supported versions](#supported-versions)
- [Suggesting changes](#suggesting-changes)

## Disclosing a security issue

The PassportKit maintainers take all security issues in the project
seriously. Thank you for improving the security of PassportKit. We
appreciate your dedication to responsible disclosure and will make every
effort to acknowledge your contributions.

Report vulnerabilities by email to the
[Cisco Open security contact](mailto:oss-security@cisco.com). Do not open
public issues or pull requests for security problems, and do not use
GitHub's private vulnerability reporting.

Here are some helpful details to include in your report:

- a detailed description of the issue
- the steps required to reproduce the issue, or a redacted HTTP exchange
- versions of the project that may be affected by the issue
- if known, any mitigations for the issue

Never include real tokens, authorization codes, or credentials.

We will acknowledge the report within three (3) business days, and will
send a more detailed response within an additional three (3) business days
indicating the next steps in handling your report.

After the initial reply to your report, we will endeavor to keep you
informed of the progress towards a fix and full announcement, and may ask
for additional information or guidance.

## Vulnerability management

Reports are triaged by the Cisco Product Security Incident Response Team
(PSIRT) together with the maintainers, who validate the issue. For a valid
vulnerability, a handler coordinates the fix and release process, which
involves the following steps:

- confirming the issue
- determining affected versions of the project
- auditing code to find any potential similar problems
- preparing fixes for all releases under maintenance
- publishing a GitHub security advisory

## Scope

This policy covers the PassportKit library code. Vulnerabilities in a
specific authorization server or service should be reported to that
service's owner.

## Supported versions

Before 1.0, only the latest release receives security fixes.

## Suggesting changes

If you have suggestions on how this process could be improved please
submit an issue or pull request.
