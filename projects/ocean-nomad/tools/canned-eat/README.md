# canned_eat

Ocean Nomad 2.11.0 dev, Unity Editor. Mission composition over the existing inventory skill; it does not define a second click motor.

Register locally through `factory.mjs#prepareCannedEatMission`, or the common `qa.prepareMissions(['canned_eat'])` catalog. Run only for a current applicable human task through `qa.runPipeline`. Registration sends no Unity commands. Required observation and input run on actual use.

The bounded route selects the quest through its current label and ordinary paging when needed, closes the cheat panel and known dialog, selects Canned, sends one Use, closes inventory, and requires a fresh Done for the same quest instance plus the quantity delta. Missing food, LongUnlock, unknown input outcome or an unexpected error stop the task. Sent Use is never retried.

The human accepted the visible route on 2026-10-29: 9.967 seconds of execution. Reusable packaging, cancellation and cycle integration have separate offline checks; this is not a new live timing or a full onboarding result. See `ON-QUEST-CANNED-EAT-001` for evidence scope.

Machine paths, parameters, raw logs and results belong in an ignored task directory. Old instance IDs, quantities, authorization and completion are never restored from Git.
