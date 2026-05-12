# Tests

This directory contains the Vitest test suite.

## Structure

```text
tests/
```

## Extending

1. Write adversarial black-box tests against public interfaces.
2. Do not assert on private implementation details.
3. Cover provider failures, selection edge cases, and conversation handoff behavior when those
   features are implemented.
