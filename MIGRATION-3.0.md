# React Native 3.0 migration

React Native 2.0 remains the published compatibility baseline. Version 3 uses the hardened Swift3 and Android3 native SDKs with the same installation flow and bridge APIs; no collector or extra service is needed. Install/rebuild the native binary when upgrading and verify both native dependency versions before publishing the wrapper.

Optional `beforeSend` callbacks run after capture returns on the JavaScript event loop. They must return promptly: closures retain application state and cannot be transparently moved to isolated workers. Hook side effects are no longer synchronous with capture. Valid replacements, null drops and protected-original fallback for thrown/invalid hooks remain supported. Final values receive privacy protection and level checks again before native handoff.

Privacy-safe pending preparation and native calls share a 256-call/4-MiB cap. Low-priority work may use224 calls/3MiB, reserving space for errors and exceptions. Both the protected original and final bridge snapshot stay charged until the bridge settles. Under pressure a pending hook or valid expanded replacement can be discarded; it never causes a return to pre-hook application content. SDK-owned queues stay bounded if the native bridge stalls. Explicit flush lets prior deferred preparations reach the bridge before requesting the native flush.

The existing canonical and legacy native bridge methods remain supported. Context, probes, JavaScript error identity and native offline/ACK behavior remain available. Swift3 and Android3 document background persistence and safe custom-exception projection separately.
