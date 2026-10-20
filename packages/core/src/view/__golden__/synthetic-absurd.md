<hafiz hash="295923bb256f" role="manager">
> warn: focus too wide: 931 tokens over budget; narrow focus or group under a parent block

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
Interface:
- provides `putShipmentEvents(tenant)` (event)
- provides `getCustomerAccounts(tenant)` (http)

### Parsers [ingest-parsers] done

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

### Validation [ingest-validation] active
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
Decisions:
- Batch route plans approach: Expose vehicle pings in the database. Why: The nightly batch finishes before 05:00. `dec-ingest-validation-1`

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
Interface:
- provides `getCarrierManifests(since)` (fn)
- provides `putTrackingLinks(since)` (event)

### Planner [routing-planner] active
Interface:
- provides `putStopWindows(since)` (event)
- provides `getDeliveryProofs(id)` (event)

#### Dedupe vehicle pings [routing-planner-1] active · focus
Depends on: ingest-parsers-1, ingest-parsers-2
Purpose: Dedupe vehicle pings for route plans so that planners get answers within a second.
Scope:
- in: vehicle pings
- out: shipment events
Interface:
- provides `getVehiclePings(tenant)` (event)
- provides `getStopWindows(tenant)` (http)
Decisions:
- Dedupe vehicle pings approach: Validate route plans in the database. Why: Customers see accurate ETAs. `dec-routing-planner-1`

#### Dedupe shipment events [routing-planner-2] active · focus
Depends on: ingest-event-store-2, ingest-event-store-3
Purpose: Dedupe shipment events for tracking links so that the nightly batch finishes before 05:00.
Scope:
- in: shipment events
- out: route plans
Interface:
- provides `listShipmentEvents(id)` (event)
- provides `putTrackingLinks(tenant)` (http)
Decisions:
- Dedupe shipment events approach: Index customer accounts in the worker. Why: The nightly batch finishes before 05:00. `dec-routing-planner-2`

### Constraints [routing-constraints] active
#### Batch carrier manifests [routing-constraints-1] active
#### Validate fuel reports [routing-constraints-2] done
#### Index route plans [routing-constraints-3] done
### Optimiser [routing-optimiser] planned
#### Validate customer accounts [routing-optimiser-1] planned
#### Cache shipment events [routing-optimiser-2] planned
#### Batch tracking links [routing-optimiser-3] planned
#### Throttle stop windows [routing-optimiser-4] planned
## Fleet [fleet] active
### Telemetry [fleet-telemetry] done
#### Reconcile shipment events [fleet-telemetry-1] done
#### Index fuel reports [fleet-telemetry-2] done

#### Throttle fuel reports [fleet-telemetry-3] done
Depends on: routing-planner-1
Outcome: Throttle fuel reports is live; the geocoder returns 0,0 for unknown postcodes; treat as missing.
Interface delta: none
Pointers: PR #224 (github.com/atlas/app/pull/224)
Interface:
- provides `putFuelReports(since)` (fn)
- provides `listRoutePlans(id)` (http)

#### Expose carrier manifests [fleet-telemetry-4] done
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
#### Expose stop windows [portal-accounts-2] planned
#### Expose vehicle pings [portal-accounts-3] done
### Tracking page [portal-tracking-page] active
#### Cache delivery proofs [portal-tracking-page-1] planned
#### Cache tracking links [portal-tracking-page-2] done
#### Dedupe stop windows [portal-tracking-page-3] done
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
budget 600 · view 1531 tokens · floor 40 tokens
atlas                        root       DESIGN    144
ingest                       ancestor   INTERFACE 33
ingest-parsers               other      LINE      9
ingest-parsers-1             dependency DIGEST    90
ingest-parsers-2             dependency DIGEST    93
ingest-parsers-3             other      LINE      13
ingest-validation            ancestor   INTERFACE 38
ingest-validation-1          focus      DESIGN    124
ingest-event-store           other      LINE      11
ingest-event-store-1         other      LINE      15
ingest-event-store-2         dependency INTERFACE 50
ingest-event-store-3         dependency INTERFACE 48
routing                      ancestor   INTERFACE 32
routing-planner              ancestor   INTERFACE 34
routing-planner-1            focus      DESIGN    122
routing-planner-2            focus      DESIGN    130
routing-constraints          other      LINE      11
routing-constraints-1        dependent  LINE      15
routing-constraints-2        other      LINE      14
routing-constraints-3        other      LINE      13
routing-optimiser            other      LINE      11
routing-optimiser-1          other      LINE      16
routing-optimiser-2          other      LINE      14
routing-optimiser-3          other      LINE      14
routing-optimiser-4          dependent  LINE      14
fleet                        other      LINE      6
fleet-telemetry              other      LINE      9
fleet-telemetry-1            other      LINE      14
fleet-telemetry-2            other      LINE      12
fleet-telemetry-3            dependent  DIGEST    88
fleet-telemetry-4            other      LINE      14
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
portal-accounts-1            other      LINE      13
portal-accounts-2            other      LINE      13
portal-accounts-3            other      LINE      13
portal-tracking-page         other      LINE      12
portal-tracking-page-1       other      LINE      15
portal-tracking-page-2       other      LINE      14
portal-tracking-page-3       other      LINE      14
portal-reports               other      LINE      9
portal-reports-1             other      LINE      14
portal-reports-2             other      LINE      15
portal-reports-3             other      LINE      14
-->
