# Skill: Claude Hub Roles

Use `/hub` launcher to start Claude in a coordination role:

- Orchestrator: `./hub --backend claude --role orchestrator`
- Reviewer: `./hub --backend claude --role reviewer`
- Assistant: `./hub --backend claude --role assistant`

What this skill enforces:
- auto runtime profile detection and `register_agent.runtime_profile`
- auth token propagation contract
- execution_mode-aware task routing (`repo|isolated|any`)
- artifact side-channel guidance gated by `artifact_tickets`: bridge-launched Claude sessions return
  structured handoffs and `/tmp` paths, and only a hub-connected bridge/operator with
  `artifact_tickets: true` uses upload/download ticket tools
