<hafiz hash="2a419aa54af6" role="manager">
# Atlas [atlas] active
Overview: Atlas plans and tracks parcel deliveries for regional carriers: ingest carrier data, plan routes, run the fleet and show customers where their parcel is.
Topology:
- Ingest: Parsers, Validation, Event store
- Routing: Planner, Constraints, Optimiser
- Fleet: Telemetry, Dispatch, Maintenance
- Portal: Accounts, Tracking page, Reports
Constraints:
- EU hosting only
- Every service owns its schema
Decisions:
- Messaging: Services talk through the event bus; no synchronous calls across areas. Why: Areas deploy independently. `dec-atlas-1`

## Ingest [ingest] active
Purpose: Ingest area for shipment events so that downstream services never see duplicates.
Scope:
- in: shipment events
- out: tracking links
Interface:
- provides `putShipmentEvents(tenant)` (event)
- provides `getCustomerAccounts(tenant)` (http)
Constraints: Idempotent on retries

### Parsers [ingest-parsers] done
Outcome: Parsers shipped; index on (tenant, ts) halves the scan time.
Interface delta: none
Pointers: PR #100 (github.com/atlas/app/pull/100)
Interface:
- provides `listDepotSchedules(tenant)` (fn)
- provides `getTrackingLinks(since)` (fn)

#### Dedupe depot schedules [ingest-parsers-1] done · dependency
Outcome: Dedupe depot schedules is live; batch size above 500 trips the upstream rate limit.
Interface delta: adds listDepotSchedules(id)
Pointers: PR #201 (github.com/atlas/app/pull/201)
Interface:
- provides `streamDepotSchedules(tenant)` (event)
- provides `streamRoutePlans(since)` (http)

#### Reconcile tracking links [ingest-parsers-2] done · dependency
Outcome: Reconcile tracking links is live; the tracking page polls every 2 s; switch to server-sent events.
Interface delta: adds putTrackingLinks(id)
Pointers: PR #202 (github.com/atlas/app/pull/202)
Interface:
- provides `putTrackingLinks(since)` (event)
- provides `putCustomerAccounts(tenant)` (fn)

#### Expose tracking links [ingest-parsers-3] done
Outcome: Expose tracking links is live; the legacy depot feed repeats rows after midnight.
Interface delta: none
Pointers: PR #203 (github.com/atlas/app/pull/203)
Interface:
- provides `listTrackingLinks(id)` (fn)
- provides `getCarrierManifests(id)` (http)

### Validation [ingest-validation] active
Purpose: Validation for stop windows so that customers see accurate ETAs.
Scope:
- in: shipment events
- out: fuel reports
Interface:
- provides `streamShipmentEvents(tenant)` (event)
- provides `listTrackingLinks(tenant)` (event)

#### Batch route plans [ingest-validation-1] active · focus
Depends on: ingest-parsers-1, ingest-parsers-2
Purpose: Batch route plans for carrier manifests so that the nightly batch finishes before 05:00.
Scope:
- in: route plans
- out: vehicle pings
Interface:
- provides `putRoutePlans(since)` (event)
- provides `getStopWindows(since)` (http)
Steps:
- [x] s1 Throttle fuel reports
- [~] s2 Index route plans
- [ ] s3 Cache tracking links
- [ ] s4 Expose delivery proofs
Acceptance:
- route plans round-trip test passes
- No PII in logs
Decisions:
- Batch route plans approach: Expose vehicle pings in the database. Why: The nightly batch finishes before 05:00. `dec-ingest-validation-1`
Progress:
- question: Carrier timestamps arrive without zone offsets; normalise at the edge
- question: Consumer lag spikes when the snapshot job runs; move it off-peak
- done: The tracking page polls every 2 s; switch to server-sent events
- question: Carrier sandbox rejects batches with mixed tenants

#### Expose delivery proofs [ingest-validation-2] done
Depends on: ingest-parsers-1
Outcome: Expose delivery proofs is live; carrier sandbox rejects batches with mixed tenants.
Interface delta: none
Pointers: PR #205 (github.com/atlas/app/pull/205)
Interface:
- provides `listDeliveryProofs(since)` (http)
- provides `streamRoutePlans(id)` (event)

#### Index stop windows [ingest-validation-3] done
Outcome: Index stop windows is live; schema v2 drops the depot code; map it from the stop id.
Interface delta: none
Pointers: PR #206 (github.com/atlas/app/pull/206)
Interface:
- provides `streamStopWindows(tenant)` (fn)
- provides `getShipmentEvents(since)` (http)

### Event store [ingest-event-store] planned
#### Index shipment events [ingest-event-store-1] planned

#### Batch delivery proofs [ingest-event-store-2] planned · dependency
Interface:
- provides `streamDeliveryProofs(since)` (event)
- provides `putDepotSchedules(since)` (event)
Status: 0/4 steps done

#### Reconcile delivery proofs [ingest-event-store-3] planned · dependency
Interface:
- provides `listDeliveryProofs(id)` (fn)
- provides `putDepotSchedules(id)` (fn)
Status: 0/5 steps done

## Routing [routing] active
Purpose: Routing area for carrier manifests so that planners get answers within a second.
Scope:
- in: carrier manifests
- out: depot schedules
Interface:
- provides `getCarrierManifests(since)` (fn)
- provides `putTrackingLinks(since)` (event)
Constraints: Backwards-compatible schema changes only

### Planner [routing-planner] active
Purpose: Planner for vehicle pings so that the nightly batch finishes before 05:00.
Scope:
- in: stop windows
- out: depot schedules
Interface:
- provides `putStopWindows(since)` (event)
- provides `getDeliveryProofs(id)` (event)
Constraints: Backwards-compatible schema changes only

#### Dedupe vehicle pings [routing-planner-1] active · focus
Depends on: ingest-parsers-1, ingest-parsers-2
Purpose: Dedupe vehicle pings for route plans so that planners get answers within a second.
Scope:
- in: vehicle pings
- out: shipment events
Interface:
- provides `getVehiclePings(tenant)` (event)
- provides `getStopWindows(tenant)` (http)
Steps:
- [x] s1 Cache fuel reports
- [~] s2 Dedupe carrier manifests
- [ ] s3 Validate route plans
- [ ] s4 Index carrier manifests
Acceptance:
- vehicle pings round-trip test passes
- p95 under 200 ms
Decisions:
- Dedupe vehicle pings approach: Validate route plans in the database. Why: Customers see accurate ETAs. `dec-routing-planner-1`
Progress:
- changed: The tracking page polls every 2 s; switch to server-sent events
- found: ETA drift is mostly dwell time at depots, not travel time
- found: Index on (tenant, ts) halves the scan time
- question: Consumer lag spikes when the snapshot job runs; move it off-peak
- found: The geocoder returns 0,0 for unknown postcodes; treat as missing
- question: Schema v2 drops the depot code; map it from the stop id
- done: Carrier sandbox rejects batches with mixed tenants
- changed: Retry storms when the broker restarts; add jitter
Open threads:
- Shipment events edge cases `thr-routing-planner-1`: schema v2 drops the depot code; map it from the stop id?

#### Dedupe shipment events [routing-planner-2] active · focus
Depends on: ingest-event-store-2, ingest-event-store-3
Purpose: Dedupe shipment events for tracking links so that the nightly batch finishes before 05:00.
Scope:
- in: shipment events
- out: route plans
Interface:
- provides `listShipmentEvents(id)` (event)
- provides `putTrackingLinks(tenant)` (http)
Steps:
- [x] s1 Reconcile depot schedules
- [~] s2 Reconcile customer accounts
- [ ] s3 Throttle tracking links
- [ ] s4 Expose tracking links
- [ ] s5 Throttle vehicle pings
Acceptance:
- shipment events round-trip test passes
- Backwards-compatible schema changes only
Decisions:
- Dedupe shipment events approach: Index customer accounts in the worker. Why: The nightly batch finishes before 05:00. `dec-routing-planner-2`
Progress:
- question: The geocoder returns 0,0 for unknown postcodes; treat as missing
- changed: ETA drift is mostly dwell time at depots, not travel time
- found: Carrier timestamps arrive without zone offsets; normalise at the edge
- question: Carrier sandbox rejects batches with mixed tenants
- question: The tracking page polls every 2 s; switch to server-sent events
- done: The legacy depot feed repeats rows after midnight
- changed: Retry storms when the broker restarts; add jitter
- done: Schema v2 drops the depot code; map it from the stop id

#### Validate route plans [routing-planner-4] done
Outcome: Validate route plans is live; two carriers reuse manifest numbers across years.
Interface delta: none
Pointers: PR #214 (github.com/atlas/app/pull/214)
Interface:
- provides `listRoutePlans(since)` (http)
- provides `streamShipmentEvents(since)` (event)

### Constraints [routing-constraints] active
#### Batch carrier manifests [routing-constraints-1] active

#### Validate fuel reports [routing-constraints-2] done
Depends on: ingest-event-store-2
Outcome: Validate fuel reports is live; schema v2 drops the depot code; map it from the stop id.
Interface delta: adds streamFuelReports(since)
Pointers: PR #216 (github.com/atlas/app/pull/216)
Interface:
- provides `listFuelReports(id)` (http)
- provides `getCarrierManifests(tenant)` (event)

#### Index route plans [routing-constraints-3] done
Outcome: Index route plans is live; the geocoder returns 0,0 for unknown postcodes; treat as missing.
Interface delta: adds listRoutePlans(tenant)
Pointers: PR #217 (github.com/atlas/app/pull/217)
Interface:
- provides `streamRoutePlans(since)` (event)
- provides `getVehiclePings(since)` (http)

### Optimiser [routing-optimiser] planned
#### Validate customer accounts [routing-optimiser-1] planned
#### Cache shipment events [routing-optimiser-2] planned
#### Batch tracking links [routing-optimiser-3] planned
#### Throttle stop windows [routing-optimiser-4] planned
## Fleet [fleet] active

### Telemetry [fleet-telemetry] done
Outcome: Telemetry shipped; carrier sandbox rejects batches with mixed tenants.
Interface delta: none
Pointers: PR #121 (github.com/atlas/app/pull/121)
Interface:
- provides `listFuelReports(tenant)` (http)
- provides `streamTrackingLinks(since)` (fn)

#### Reconcile shipment events [fleet-telemetry-1] done
Depends on: ingest-validation-2
Outcome: Reconcile shipment events is live; retry storms when the broker restarts; add jitter.
Interface delta: adds getShipmentEvents(since)
Pointers: PR #222 (github.com/atlas/app/pull/222)
Interface:
- provides `getShipmentEvents(tenant)` (http)
- provides `listFuelReports(tenant)` (event)

#### Index fuel reports [fleet-telemetry-2] done
Outcome: Index fuel reports is live; the tracking page polls every 2 s; switch to server-sent events.
Interface delta: adds streamFuelReports(id)
Pointers: PR #223 (github.com/atlas/app/pull/223)
Interface:
- provides `putFuelReports(since)` (http)
- provides `getShipmentEvents(since)` (event)

#### Throttle fuel reports [fleet-telemetry-3] done
Depends on: routing-planner-1
Outcome: Throttle fuel reports is live; the geocoder returns 0,0 for unknown postcodes; treat as missing.
Interface delta: none
Pointers: PR #224 (github.com/atlas/app/pull/224)
Interface:
- provides `putFuelReports(since)` (fn)
- provides `listRoutePlans(id)` (http)

#### Expose carrier manifests [fleet-telemetry-4] done
Depends on: ingest-parsers-3
Outcome: Expose carrier manifests is live; index on (tenant, ts) halves the scan time.
Interface delta: none
Pointers: PR #225 (github.com/atlas/app/pull/225)
Interface:
- provides `putCarrierManifests(tenant)` (fn)
- provides `streamTrackingLinks(id)` (event)

### Dispatch [fleet-dispatch] active
#### Cache depot schedules [fleet-dispatch-1] planned
#### Expose customer accounts [fleet-dispatch-2] active
#### Cache route plans [fleet-dispatch-3] blocked
### Maintenance [fleet-maintenance] planned
#### Reconcile stop windows [fleet-maintenance-1] planned
#### Validate stop windows [fleet-maintenance-2] planned
#### Validate tracking links [fleet-maintenance-3] planned
#### Throttle shipment events [fleet-maintenance-4] planned
## Portal [portal] active
### Accounts [portal-accounts] active

#### Cache vehicle pings [portal-accounts-1] done
Depends on: fleet-dispatch-3
Outcome: Cache vehicle pings is live; the legacy depot feed repeats rows after midnight.
Interface delta: adds listVehiclePings(since)
Pointers: PR #233 (github.com/atlas/app/pull/233)
Interface:
- provides `putVehiclePings(tenant)` (http)
- provides `getStopWindows(since)` (fn)

#### Expose stop windows [portal-accounts-2] planned

#### Expose vehicle pings [portal-accounts-3] done
Outcome: Expose vehicle pings is live; schema v2 drops the depot code; map it from the stop id.
Interface delta: none
Pointers: PR #235 (github.com/atlas/app/pull/235)
Interface:
- provides `listVehiclePings(id)` (http)
- provides `listCustomerAccounts(since)` (event)

### Tracking page [portal-tracking-page] active
#### Cache delivery proofs [portal-tracking-page-1] planned

#### Cache tracking links [portal-tracking-page-2] done
Outcome: Cache tracking links is live; consumer lag spikes when the snapshot job runs; move it off-peak.
Interface delta: adds getTrackingLinks(id)
Pointers: PR #238 (github.com/atlas/app/pull/238)
Interface:
- provides `putTrackingLinks(since)` (event)
- provides `putShipmentEvents(since)` (event)

#### Dedupe stop windows [portal-tracking-page-3] done
Outcome: Dedupe stop windows is live; index on (tenant, ts) halves the scan time.
Interface delta: adds putStopWindows(id)
Pointers: PR #239 (github.com/atlas/app/pull/239)
Interface:
- provides `getStopWindows(tenant)` (http)
- provides `getCustomerAccounts(since)` (http)

### Reports [portal-reports] planned
#### Throttle vehicle pings [portal-reports-1] planned
#### Throttle carrier manifests [portal-reports-2] planned
#### Dedupe tracking links [portal-reports-3] planned
</hafiz>

<hafiz-floor>
Standing decisions (always apply):
- Never read secrets from files in the repo; use the vault client. (atlas · dec-atlas-2)
- Always use metres and seconds in APIs. (routing · dec-routing-std)
</hafiz-floor>

<!-- manifest
budget 24000 · view 3359 tokens · floor 40 tokens
atlas                        root       DESIGN    144
ingest                       ancestor   DESIGN    77
ingest-parsers               other      DIGEST    69
ingest-parsers-1             dependency DIGEST    90
ingest-parsers-2             dependency DIGEST    93
ingest-parsers-3             other      DIGEST    77
ingest-validation            ancestor   DESIGN    68
ingest-validation-1          focus      FULL      249
ingest-validation-2          sibling    DIGEST    87
ingest-validation-3          sibling    DIGEST    79
ingest-event-store           other      LINE      11
ingest-event-store-1         other      LINE      15
ingest-event-store-2         dependency INTERFACE 50
ingest-event-store-3         dependency INTERFACE 48
routing                      ancestor   DESIGN    82
routing-planner              ancestor   DESIGN    80
routing-planner-1            focus      FULL      340
routing-planner-2            focus      FULL      337
routing-planner-4            sibling    DIGEST    79
routing-constraints          other      LINE      11
routing-constraints-1        dependent  LINE      15
routing-constraints-2        other      DIGEST    96
routing-constraints-3        other      DIGEST    87
routing-optimiser            other      LINE      11
routing-optimiser-1          other      LINE      16
routing-optimiser-2          other      LINE      14
routing-optimiser-3          other      LINE      14
routing-optimiser-4          dependent  LINE      14
fleet                        other      LINE      6
fleet-telemetry              other      DIGEST    72
fleet-telemetry-1            other      DIGEST    96
fleet-telemetry-2            other      DIGEST    86
fleet-telemetry-3            dependent  DIGEST    88
fleet-telemetry-4            other      DIGEST    86
fleet-dispatch               other      LINE      9
fleet-dispatch-1             other      LINE      14
fleet-dispatch-2             other      LINE      14
fleet-dispatch-3             other      LINE      13
fleet-maintenance            other      LINE      11
fleet-maintenance-1          other      LINE      15
fleet-maintenance-2          other      LINE      14
fleet-maintenance-3          other      LINE      15
fleet-maintenance-4          other      LINE      15
portal                       other      LINE      7
portal-accounts              other      LINE      10
portal-accounts-1            other      DIGEST    90
portal-accounts-2            other      LINE      13
portal-accounts-3            other      DIGEST    80
portal-tracking-page         other      LINE      12
portal-tracking-page-1       other      LINE      15
portal-tracking-page-2       other      DIGEST    89
portal-tracking-page-3       other      DIGEST    82
portal-reports               other      LINE      9
portal-reports-1             other      LINE      14
portal-reports-2             other      LINE      15
portal-reports-3             other      LINE      14
-->
