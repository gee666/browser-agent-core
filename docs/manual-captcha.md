# Manual CAPTCHA handoff

CAPTCHA solving is human-only. The core offers a decision to detect a challenge and hand control to the user, not to solve or bypass it.

## Decisions

Normal LLM decisions use the parameter-free action `{ "action": { "manual_captcha": {} } }`. The `captcha` action name is accepted as an alias. The system prompt lists this action before browser input actions and requires it when a CAPTCHA or human-verification challenge blocks progress, even when the task asks for automated solving.

Jev offers `MANUAL_CAPTCHA` in the first text action question and the optional screenshot-stage question. The normal LLM classification fallback has the same choice in its JSON schema. Selection maps directly to `manual_captcha`. It does not invoke a parameter helper, DOM investigation, an executor or completion verification.

Detection is a model decision, not a guarantee that every challenge will be recognized. Normal vision mode and Jev screenshot escalation can provide an image to the decision model to recognize a blocker. Once the manual decision is selected, there are no further model requests in that run. There is no CAPTCHA-solving model, answer schema or automated solving stage.

## Terminal result

`agent.run()` normally returns a done-message string or `null`. A manual CAPTCHA handoff instead returns this structured terminal result and emits the same fields through `onStatus` and `bridge.sendStatus`:

```javascript
{
  state: 'paused',
  terminal: true,
  reason: 'manual_captcha',
  manualRequired: true,
  success: false,
  blocked: true,
  message: 'CAPTCHA detected. Automation is paused for a human to solve it in the browser. After solving it, explicitly start a new task to continue.',
  handoff: {
    type: 'manual_captcha',
    screenshot: 'data:image/jpeg;base64,...', // or null when unavailable
    screenshotCaptured: true,
    screenshotError: null, // fixed user-facing explanation when unavailable
    screenshotPrivacy: 'For human review only. May contain private page data. Do not send to a CAPTCHA-solving model.',
  },
}
```

Status events also retain the core's normal metadata, such as iteration and timestamp. Staged mode retains its existing task and URL redaction.

The handoff takes a fresh screenshot even when vision is disabled. It compresses the image without numbered element overlays. This capture is for the user report only and is never attached to a subsequent model request or raw debug turn. Screenshot failure still returns `paused`, with `screenshot: null`, `screenshotCaptured: false` and a fixed explanation. Native cancellation during capture returns the existing `stopped` outcome instead of publishing a handoff.

Model-provided manual-action parameters are ignored, including text or proposed answers. A manual signal takes precedence over any additional action keys in the same response so no input can run alongside it.

## Embedding contract

Treat `paused` as a terminal manual outcome, not as success, failure requiring a retry, or an active background job. Preserve `handoff` for the user to inspect. Screenshots may contain sensitive page content. They are not redacted diagnostics and must not be sent to a challenge-solving model or service.

The run ends and releases its cancellation listener. There is no polling loop or automatic resume. `addSteer()` returns `false` while paused and cannot change the status back to running. The user must solve the CAPTCHA directly in the browser and explicitly start a new task. A new `run()` resets the paused flag and reads fresh page state.

The core does not persist screenshots or create report URLs. The embedding runtime owns report presentation, retention and access controls.
