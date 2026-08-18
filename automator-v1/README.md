# Automator V1 — Tab-Based Local Prototype

Automator V1 connects explicitly assigned ChatGPT conversations into a strict PM -> specialist -> PM workflow.

## What changed in v0.2.0

- Agents are user-created instead of fixed roles.
- Every specialist has a permanent `agent_id`, display name, description, and assigned ChatGPT conversation.
- Exactly one PM is supported in V1 and uses `agent_id: pm`.
- The side panel lists open ChatGPT tabs and lets the owner assign a specific conversation to an agent.
- Conversation URL is the durable identity; Chrome tab ID is only the temporary live connection.
- Reconciliation reconnects an agent if the same saved conversation reopens under a new Chrome tab ID.
- PM dispatch uses strict JSON with `target_agent_id`.
- Specialist completion uses strict JSON with `action: TASK_RESULT`.
- The task stores `createdByAgentId`, `assignedToAgentId`, and `returnToAgentId`, so specialist results automatically return to PM.
- Automator relays the full specialist response to PM, not only the JSON summary.
- A specialist result is rejected if it comes from the wrong agent or references the wrong/unknown task.
- Invalid JSON/schema output is rejected and Automator asks the same chat to correct its machine-readable block.
- A finished specialist response without a valid result block is shown as `RESPONSE_NO_VALID_RESULT`; it is not treated as completion.
- One active task per specialist is enforced in V1.
- Owner gates remain durable and return the owner's PASS/FAIL plus comment to PM.
- Global Pause holds unprocessed assistant output so it can be reconciled after Resume.
- The recovery alarm is checked/recreated whenever the extension service worker starts, so V1 does not depend on an in-memory timer surviving suspension or browser restart.

## Install locally

1. Unzip the package.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `automator-v1` folder.
6. Pin/open **Automator V1**. Clicking the extension icon opens the side panel.

## Initial setup

1. Create/open a dedicated ChatGPT conversation for the PM.
2. Paste `prompts/PM-V1-INSTRUCTIONS.txt` into that PM conversation as its working contract.
3. Create/open each specialist ChatGPT conversation.
4. Paste `prompts/AGENT-V1-INSTRUCTIONS.txt` into each specialist conversation, plus that agent's actual role/scope instructions.
5. In Automator's side panel:
   - create the PM (`Type = Project Manager`);
   - assign the PM conversation;
   - create each specialist with a unique agent ID, name, description, and assigned ChatGPT conversation.
6. Tell the PM the exact specialist agent IDs it may use. The IDs are visible on every Automator agent card.

## Routing protocol

PM -> specialist:

```text
<<AUTOMATOR>>
{
  "action": "DISPATCH_TASK",
  "task_id": "TEST-001",
  "target_agent_id": "qa_reviewer",
  "assignment": "Review the work and report the result."
}
<<END_AUTOMATOR>>
```

Automator records:

```text
created_by = pm
assigned_to = qa_reviewer
return_to = pm
```

Specialist -> Automator:

```text
<<AUTOMATOR>>
{
  "action": "TASK_RESULT",
  "task_id": "TEST-001",
  "status": "COMPLETE",
  "summary": "QA completed."
}
<<END_AUTOMATOR>>
```

The specialist does not specify `return_to`. Automator reads `TEST-001`, verifies that the responding specialist is the one assigned to the task, then sends the full response back to the stored PM.

## Owner gates

PM may create either `REQUEST_OWNER_APPROVAL` or `REQUEST_OWNER_ACTION`. The gate stays in `WAITING_FOR_OWNER` until the owner presses PASS or FAIL in the side panel. Automator then returns the result to PM; PM decides what happens next.

## Important V1 constraints

- V1 assumes one PM.
- V1 allows one active assignment per specialist.
- Agents do not route directly to one another.
- Automator only acts on a completed assistant response containing a valid `<<AUTOMATOR>> ... <<END_AUTOMATOR>>` JSON block.
- ChatGPT DOM selectors can change. The content-script adapter may need maintenance if ChatGPT changes its page structure.
- File/attachment transfer between ChatGPT conversations is not automated in this version; V1 relays the textual assistant response.

## Recommended first test

Use three conversations only:

1. PM
2. Developer
3. QA

Run:

```text
PM -> Developer -> PM -> QA -> PM -> OWNER GATE -> PM
```

Do not add more automation until that loop behaves correctly and survives tab closure/reopening and extension service-worker suspension.
