# VAAYU Mobile Client — Phase A Transport Core Implementation

## Scope

This artifact implements the Phase A frontend transport overhaul only. It does not modify backend domain logic, frozen P1–P19 certification records, or the FINAL software production gate.

## Implemented

1. **Unified WebSocket transport**
   - `WebSocketClient` is now the single mobile WebSocket implementation.
   - The former competing implementations were consolidated.
   - `ResilientWebSocketClient` remains only as a source-level compatibility typedef and is not a second implementation.

2. **Correct JSON serialization**
   - Outbound frames use `jsonEncode()`.
   - Room join/leave and heartbeat messages therefore travel as valid JSON.

3. **Reconnect and room continuity**
   - Bounded exponential reconnect delay: 1s → 2s → 4s → ... → 30s maximum.
   - Full jitter is applied to reduce synchronized reconnect storms.
   - Room intent is retained locally and replayed after reconnect.

4. **Heartbeat**
   - The transport emits an application-level `{"action":"ping"}` heartbeat every 25 seconds while connected.
   - `pong` is recognized by the event decoder and remains available to higher-level reliability logic.

5. **Typed inbound event pipeline**
   - `WebSocketEventDecoder` converts wire JSON into typed events.
   - `WebSocketEventRouter` fans events into the appropriate stream.

6. **Projection integration**
   - `trip_state_update` / `order_updated` events enter the existing monotonic `ProjectionStore`.
   - `driver_location_ping` is deliberately kept on a separate location stream so high-frequency GPS does not consume the trip-state version domain.
   - `offer_dispatched` has its own stream.

7. **Application wiring**
   - `VaayuContainer` subscribes the WebSocket message stream to the event router.
   - The router is now part of the container dependency graph.

8. **Phase A tests added**
   - Valid JSON serialization and room intent retention.
   - Typed decoding for trip state, driver location, offer, and pong.
   - Routing verification that GPS does not mutate trip-state version.

## Verification boundary

The source environment used for this implementation does not contain the Flutter/Dart executable, so `flutter test` and `dart analyze` could not be executed locally in this environment. The added tests are therefore source-reviewed but not runtime-executed here.

Before merging into the development branch, run:

```text
flutter pub get
flutter analyze
flutter test
```

Then run the existing live WebSocket integration vectors against the actual VAAYU backend.

## Deliberate non-scope

Phase A does **not** implement Phase B multi-trip projection storage, Phase C durable offline persistence/token refresh, or Phase E consumer/driver UI. Those remain separate execution phases.
