## Description:

Systematic code review patterns covering security, performance, maintainability, correctness, and testing, with severity levels, structured feedback guidance, review process, and anti-patterns to avoid.

This skill is ready for commercial/non-commercial use.

## Publisher:

[wpank](https://clawhub.ai/user/wpank)

### License/Terms of Use:


## Use Case:

Developers and engineering teams use this skill to review pull requests, establish review standards, train reviewers, and produce structured feedback across security, performance, correctness, maintainability, and testing.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: Mutable remote npx installation commands can change after review.

Mitigation: Avoid running the documented npx install commands unless the package and source are trusted at execution time; prefer a pinned installer version and immutable source commit, or inspect and manually copy the reviewed files.

## Reference(s):

- [ClawHub skill page](https://clawhub.ai/wpank/skills/code-review)

## Skill Output:

**Output Type(s):** [text, markdown, guidance]

**Output Format:** [Markdown guidance with structured checklists, severity labels, and example review comments]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [Produces review prompts and recommendations; it does not execute code or call external tools.]

## Skill Version(s):

1.0.0 (source: server release metadata; artifact frontmatter version 1.0)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
