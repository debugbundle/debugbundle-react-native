# React Native 3.1 candidate

Version 3.1.0 is an unpublished candidate. Rebuild the native binary with the
coordinated Android 3.1.0 and Swift 3.1.0 foundations before enabling the new
evidence options. Existing capture methods and their return values are unchanged.
An older native binary keeps ordinary error capture and disables unproven optional
evidence. This document does not establish release or device qualification.

The current iOS wrapper provides a bounded JSON-string carrier for canonical
events. React Native's object conversion can remove nested nulls; the string
carrier preserves required nullable stack, cause and device fields. Android's
existing canonical map carrier preserves nested nulls and numeric values.
The JavaScript client prefers the string method when present and retains both
older canonical-object and legacy-native fallbacks. New methods are optional on
the structural `DebugBundleClient` interface so existing custom implementations
continue to typecheck; the returned concrete client and facade provide them.

## Evidence and delivery proof

`captureExceptionEvidence` defaults to true, but structured details are emitted
only when the native bridge reports complete-path support. Set it to false to
retain the ordinary outer error without structured details.
`captureRecoveryObservations` defaults to false. Enable it explicitly to capture
recovery observations. Native minimal policy or an explicit diagnostic disable
still prevents them. These options do not depend on probes or analytics.

The read-only `evidenceCapabilities` client/facade property reports the effective
intersection of JS options, native support, and the verified downstream path.
The optional configuration value with the same name pins a verified complete
path: `{ version: 1, features: [...] }`. Supported features are
`exception_evidence_v1`, `resource_observations_v1`, `recovery_v1`, and
`evidence_provenance_v1`. Unknown versions, duplicate or unknown features, and
extra descriptor fields disable support. A JS pin cannot make an old native
bridge preserve new evidence. Native config refresh and ingestion acknowledgements
carry proof; capture does not make a discovery request.

## Explicit operation and recovery APIs

Both the facade and instance client expose `beginOperation()`,
`withOperationContext(callback)`, and `captureRecovery(observation)`.
An operation returns `{ operationId, evidenceScope, close() }`. Close it in a
`finally` block. Nested synchronous operations restore their parent; closing a
parent revokes its children. Reinitialization revokes existing scopes.

`withOperationContext` closes the implicit scope when the callback returns,
including when it returns a promise. It does not provide asynchronous context
propagation. Across `await`, retain the opaque `evidenceScope` value and pass it
explicitly to each capture; do not leave an implicit scope open across unrelated
tasks. At most 32 implicit scopes can nest.

```ts
const client = createDebugBundleClient({
  projectToken: "YOUR_PROJECT_TOKEN",
  captureRecoveryObservations: true,
});
const operation = client.beginOperation();
const evidenceScope = operation.evidenceScope;
operation.close(); // Use explicit ownership across asynchronous application work.
const failureRef = createApplicationUuidV4();
const attemptId = createApplicationUuidV4();

client.captureException(error, { failureRef, evidenceScope, session_id: sessionId });
client.captureRecovery({
  failureRef, evidenceScope, attemptId, state: "attempt_started",
  operation: "reload", correlation: { session_id: sessionId },
});
// After the application's request completes:
client.captureRecovery({
  failureRef, evidenceScope, attemptId, state: "attempt_completed", statusCode: 200,
  correlation: { session_id: sessionId },
});
// Send recovery_observed only after the application confirms semantic recovery.
```

Use your application's UUID v4 generator for each new failure and retry attempt;
references must not contain user, URL, or resource identifiers. Correlation must
match the original service, environment, scope, trace, and session. A page scope
also requires a nonempty session; the string `"0"` is valid. Null trace only
matches null trace. Recovery may arrive before the original failure, but its event
time must be at or after that failure and no more than five minutes later.

Recovery states are `attempt_started`, `attempt_completed`, `attempt_failed`,
`recovery_observed`, and `failure_persisted`. HTTP 200 and attempt completion do
not establish application recovery. Optional fields are `operation` (64 UTF-8
bytes), `statusCode` (100–599), and finite nonnegative `durationMs`. There is no
arbitrary data extension. These observations cannot change incident lifecycle.

## Runtime limits and compatibility

Hermes/JSC engines without native `Error.isError` retain the outer error and
report cause traversal as unsupported. With that intrinsic, own native `cause`
data properties can be followed; accessors and custom stack formatters are not
invoked. Aggregate traversal remains unsupported because portable JS cannot prove
that an aggregate array is free of proxy traps. Stack parsing supports V8, Hermes
and JSC text and labels available traces `runtime_reported`; absent traces remain
unavailable. No native throw-site trace is invented.

Ordinary graphs use at most eight nodes, four causal edges in a path, 32 frames
per node, and the shared 32-KiB combined addition limit. The JS fatal handler uses
at most two nodes, eight total frames, and 4 KiB of combined additions and skips
application `beforeSend`; it still calls the previously installed error handler.
This does not add a process signal or native crash handler.

Diagnostic accounting limits one SDK instance to 50 windows, five attempts and
20 observations per failure, and 64 KiB of metadata plus pending observations.
Pending bridge calls prevent expired windows from renewing. Native SDKs retain
their own accounting during offline queue ownership. Dropped or acknowledged
observations do not refund attempt/observation allowances.

Existing 64-KiB bridge events and bounded native call queues remain enforced.
Before-send callbacks may replace any valid canonical field, including event kind
and SDK metadata. Invalid/throwing callbacks retain the protected original; valid
oversized or unsafe replacements are withheld. Final privacy, capability, policy,
scope and byte checks apply to the replacement. Unchanged JS device placeholders
are hydrated by the native worker; explicitly replaced device metadata is retained.
Older bridge methods remain available.
