<!-- pi-ci-standard:validation:start -->
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with `pi-ci init`):

- Run `mise run check` while iterating; fix all failures before continuing.
- Run `mise run ci` before declaring work complete; it must pass.
- GitHub Actions calls only `mise run ci`. Never add language-specific check commands to workflows.
<!-- pi-ci-standard:validation:end -->
