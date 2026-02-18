# Skill: Codex Hub Roles

Use `/hub` launcher to start Codex in a coordination role:

- Orchestrator: `./hub --backend codex --role orchestrator`
- Reviewer: `./hub --backend codex --role reviewer`
- Assistant: `./hub --backend codex --role assistant`

What this skill enforces:
- auto runtime profile detection and `register_agent.runtime_profile`
- auth token propagation contract
- execution_mode-aware task routing (`repo|isolated|any`)
- artifact side-channel usage for large/binary handoff
