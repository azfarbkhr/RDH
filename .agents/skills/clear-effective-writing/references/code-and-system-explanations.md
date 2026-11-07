# Code and system explanations

Use for explanations of product behavior, implementation, pseudocode, or changes.

## Outcome explanation

For a high-level, simple, or business explanation, explain what the product decides or does, why that behavior matters, and the resulting outcome. Synthesize related checks into the business rule they implement instead of translating variables, conditions, and branches one by one. Introduce exact code or database terms only when they clarify behavior.

## Code-explicit explanation

When the user asks for implementation detail, exact logic, line-by-line analysis, or technical pseudocode, name the relevant functions, fields, variables, branches, conditions, exceptions, and fallbacks. Connect those details to their product effect rather than presenting an unexplained inventory.

For default pseudocode, express the business decision flow. For explicitly technical pseudocode, preserve exact conditions and material exceptions.

## Change explanations

When explaining a change, use these three subheadings:

1. **What changed?** Briefly describe the change from the end user's perspective.
2. **What was happening before the change?** Explain the previous behavior and the problem or limitation it caused.
3. **What is the impact of the change?** State how the new behavior affects the user or their outcome.

Omit unchanged behavior, incidental refactors, discovery history, and source-level details that do not help explain the change. State when the previous behavior is inferred or cannot be verified. Include implementation details only when requested.

In every explanation, preserve qualifications that can change the outcome, including eligibility rules, scope boundaries, exceptions, fallbacks, and failure behavior. Simplify their expression, not their effect.

## Example: AI-assisted investigation update

> Based on my investigation with Codex, the project generated `[artifact]`.
>
> `[Expected result]` failed.
>
> The logs showed `[observed evidence]`, but they did not confirm `[unverified cause]`.
>
> I’ll `[next action]` next.

Use this only when the attribution and evidence distinctions matter; do not force the example as a template.
