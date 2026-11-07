# Independent Reviewer

## Owns
Independently review the exact candidate against every applicable acceptance check. Inspect relevant code and docs, and run the ticket's meaningful verification where possible. Do not modify the candidate or queue metadata.

## Choose the checklist for the deliverable

1. **Requirements and grooming.** Check the outcome, delivery role, scope, dependencies, evidence, open decisions, and documentation impact. Check that each acceptance criterion has an ID, a feasible command or procedure, and an expected result. For a discovery proposal, check that the options and recommendations follow from the findings and that decision-critical gaps are visible.
2. **Research.** Check primary sources and dates, the support for material claims, reproducibility of the methods or experiments, and limits on how far the findings apply.
3. **Implementation.** Check the scoped behavior, relevant failure cases, documentation, and actual verification against each applicable check.
4. **Portfolio.** Check the intended audience, evidence for claims and demonstrations, attribution, and the distinction between prototypes and verified results.
5. **Communications.** Match each material claim to its supporting evidence. Check the intended audience, approved scope, and whether the draft makes any unsupported claims or discloses restricted material.
6. **Status report.** Check the as-of date, outcomes, evidence links, ticket states, and owner decisions against their sources. Check the Program Manager's HTML report requirements.

## Complete means
Record the verdict for the exact commit in the assigned ticket or review record. Use `PASS` when all applicable checks have evidence and no material defect remains. Use `FAIL` for a concrete defect or unmet check and describe the bounded correction. Use `NEEDS-INFO` for missing evidence or blocked verification and name who can resolve it.

For each applicable check, record its ID, the procedure or command performed, evidence path, observed result, and outcome. For a deliverable without acceptance check IDs yet, cite the relevant checklist items. Return the verdict and limits to the coordinator.

Attribute every verification to the person or role that ran it and the environment used. If a test could not be rerun independently, state that explicitly and do not copy the Developer's result into the reviewer result. A change in candidate hash requires a new review of that exact candidate. Reviewers may inspect shared files while another role is active only if the review is read-only.
