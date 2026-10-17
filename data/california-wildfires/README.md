# California wildfire observations: 24-hour snapshot

This directory contains a point-in-time GeoJSON export assembled from NASA FIRMS
VIIRS thermal detections and NIFC WFIGS incident locations.

## Snapshot

- File: [`california_wildfires_24h.geojson`](california_wildfires_24h.geojson)
- Generated: `2026-10-17T19:59:18.530116Z`
- Window: `2026-10-16T19:59:18.530116Z` through `2026-10-17T19:59:18.530116Z`
- NASA FIRMS observations: 503
  - VIIRS NOAA-20 NRT: 138
  - VIIRS NOAA-21 NRT: 215
  - VIIRS Suomi-NPP NRT: 150
- NIFC WFIGS incidents: 1
- Total features: 504

This is a historical snapshot, not a live feed. A NASA observation is a thermal anomaly
at the center of a satellite pixel; it is not automatically a verified wildfire. Multiple
satellites and overpasses may observe the same physical fire. The NIFC record is a reported
incident and may describe a prescribed fire (`RX`) rather than an uncontrolled wildfire.

Sources:

- [NASA FIRMS VIIRS field reference](https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html)
- [NIFC current wildland-fire incident locations](https://data-nifc.opendata.arcgis.com/datasets/nifc::current-wildland-fire-incident-locations/about)
- [NWCG data standards](https://www.nwcg.gov/data-standards-pms-910)

## GeoJSON structure

### Collection fields

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `FeatureCollection`. |
| `name` | string | Human-readable dataset name. |
| `features` | array | NASA observations and NIFC incidents. |
| `metadata` | object | Collection window, source status, processing notes, and limitations. |

### Metadata fields

| Field | Type | Meaning |
|---|---|---|
| `generated_utc` | ISO-8601 string | UTC time at which the file was generated. |
| `window_start_utc` | ISO-8601 string | Inclusive start of the requested 24-hour window. |
| `window_end_utc` | ISO-8601 string | Inclusive end of the requested 24-hour window. |
| `coverage` | string | Geographic-query description. The query is a rectangle, not the exact California boundary. |
| `source_status` | object | Per-source success, error, and record-count messages. |
| `deduplication` | string | Exact-match deduplication rule used by the collector. |
| `limitations` | string array | Important interpretation and completeness warnings. |

### Feature and geometry fields

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `Feature`. |
| `geometry.type` | string | `Point`. |
| `geometry.coordinates` | number pair | `[longitude, latitude]` in WGS84. Longitude comes first. |
| `properties` | object | Source-specific attributes described below. |

For NASA, the coordinate is the center of a nominal 375 m VIIRS fire pixel. For NIFC,
it is the incident location supplied by the reporting system.

## Normalized NASA FIRMS fields

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Always `NASA FIRMS`. |
| `sensor` | string | `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, or `VIIRS_SNPP_NRT`. |
| `timestamp_utc` | ISO-8601 string | Satellite acquisition date and time normalized to UTC. |
| `confidence` | string | VIIRS detection-quality class: commonly `l` (low), `n` (nominal), or `h` (high). |
| `frp_mw` | numeric string | Fire Radiative Power in megawatts; radiant energy, not burned area. |
| `record_type` | string | Always `satellite_hotspot`. |
| `raw_attributes` | object | Original FIRMS CSV fields, preserved as strings. |

### NASA `raw_attributes`

| Field | Meaning |
|---|---|
| `latitude` | Latitude of the fire-pixel center. |
| `longitude` | Longitude of the fire-pixel center. |
| `bright_ti4` | VIIRS I-4 brightness temperature in kelvin. |
| `bright_ti5` | VIIRS I-5 brightness temperature in kelvin. |
| `scan` | Approximate across-scan pixel dimension in kilometers. |
| `track` | Approximate along-track pixel dimension in kilometers. |
| `acq_date` | UTC acquisition date. |
| `acq_time` | UTC acquisition time in `HHMM` form. |
| `satellite` | Satellite code: `N`, `N20`, or `N21`. |
| `instrument` | Observing instrument, normally `VIIRS`. |
| `confidence` | Low, nominal, or high fire-pixel confidence. |
| `version` | FIRMS processing collection/version, such as near-real-time processing. |
| `frp` | Pixel-integrated Fire Radiative Power in megawatts. |
| `daynight` | `D` for daytime or `N` for nighttime acquisition. |

## Normalized NIFC fields

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Always `NIFC WFIGS`. |
| `record_type` | string | Always `reported_incident`. |
| `confidence` | null | NIFC incidents do not use NASA pixel-confidence classes. |
| `timestamp_utc` | ISO-8601 string | Most recent qualifying creation, discovery, incident, or start timestamp found by the collector. |

## NIFC/IRWIN attribute glossary

NIFC attributes may be `null` when a value is not applicable, is not yet known, or was
not supplied by the reporting unit. Boolean-like `Is...` fields are normally represented
as `1`, `0`, or `null`.

### Identifiers and system metadata

| Field | Meaning |
|---|---|
| `OBJECTID` | ArcGIS row identifier; not a stable cross-system fire identifier. |
| `SourceOID` | Row identifier in the source dataset. |
| `GlobalID` | Globally unique ArcGIS identifier for this record. |
| `SourceGlobalID` | Global identifier from the source record. |
| `IrwinID` | Incident GUID assigned by the Integrated Reporting of Wildland-Fire Information system. |
| `UniqueFireIdentifier` | Standardized fire identifier, commonly combining year, unit, and local number. |
| `LocalIncidentIdentifier` | Identifier assigned by the local reporting unit. |
| `CreatedBySystem` | System account or application that created the IRWIN record. |
| `CreatedOnDateTime_dt` | Record creation time. |
| `ModifiedOnDateTime_dt` | Most recent record modification time. |
| `IsValid` | Whether the incident record is considered valid. |
| `IsQuarantined` | Whether the record is isolated because of a validation or data-quality issue. |
| `ADSPermissionState` | Permission hierarchy governing which connected system may update the incident. |
| `ABCDMisc` | USDA Forest Service FireCode used for emergency initial-attack costs on A-D size-class fires. |

### Incident identity and organization

| Field | Meaning |
|---|---|
| `IncidentName` | Official or operational incident name. |
| `IncidentShortDescription` | Short incident description. |
| `IncidentTypeKind` | Broad incident kind, such as `FI` for fire. |
| `IncidentTypeCategory` | More specific category; `RX` generally denotes prescribed fire. |
| `IncidentComplexityLevel` | Current management complexity level. |
| `FireMgmtComplexity` | Fire-management complexity classification. |
| `OrganizationalAssessment` | Assessment of the management organization required. |
| `IncidentManagementOrganization` | Organization or incident-management team assigned. |
| `FireDepartmentID` | Associated fire-department identifier. |
| `DispatchCenterID` | Supporting dispatch-center identifier. |
| `GACC` | Geographic Area Coordination Center. |
| `IsCpxChild` | Whether the incident is a child of a managed incident complex. |
| `CpxID` | Complex identifier. |
| `CpxName` | Complex name. |

### Dates and lifecycle

| Field | Meaning |
|---|---|
| `FireDiscoveryDateTime` | Time the fire was discovered or first reported. |
| `InitialResponseDateTime` | Time the initial response began. |
| `ContainmentDateTime` | Time the wildfire was declared contained. |
| `ControlDateTime` | Time the wildfire was declared under control. |
| `FireOutDateTime` | Time the fire was declared out. |
| `StrategicDecisionPublishDate` | Publication time of the formal strategic decision. |
| `FinalFireReportApprovedDate` | Date on which the final fire report was approved. |

### Size, containment, personnel, and cost

| Field | Meaning |
|---|---|
| `DiscoveryAcres` | Estimated acres burning when first reported. |
| `InitialResponseAcres` | Acres reported during the initial-response stage. |
| `IncidentSize` | Most recently reported incident acreage. |
| `FinalAcres` | Final reported incident acreage. |
| `PercentContained` | Estimated percentage of the perimeter contained. |
| `PercentPerimeterToBeContained` | Percentage of the perimeter managers intend to contain. |
| `TotalIncidentPersonnel` | Personnel currently assigned to the incident. |
| `EstimatedCostToDate` | Estimated accumulated incident cost. |
| `EstimatedFinalCost` | Estimated cost when the incident is completed. |
| `FireCode` | Incident accounting code. |
| `FSJobCode` | USDA Forest Service financial/job code. |
| `FSOverrideCode` | Forest Service override associated with accounting or incident coding. |
| `IsFireCodeRequested` | Whether an official fire accounting code was requested. |
| `IsReimbursable` | Whether costs may be reimbursed by another organization. |
| `IsFSAssisted` | Whether the USDA Forest Service is assisting. |

### Final report and cause

| Field | Meaning |
|---|---|
| `FinalFireReportApprovedByTitle` | Job title of the final-report approver. |
| `FinalFireReportApprovedByUnit` | Unit associated with the approver. |
| `FireCause` | Broad cause, such as human, natural, or undetermined. |
| `FireCauseGeneral` | General ignition agency or circumstance. |
| `FireCauseSpecific` | More detailed ignition cause. |
| `IsFireCauseInvestigated` | Whether the cause was or is being investigated. |
| `IsTrespass` | Whether the incident has a trespass-fire classification. |

### Fire behavior and management strategy

| Field | Meaning |
|---|---|
| `FireBehaviorGeneral` | General observed fire-behavior category. |
| `FireBehaviorGeneral1` | First more-specific behavior description. |
| `FireBehaviorGeneral2` | Second more-specific behavior description. |
| `FireBehaviorGeneral3` | Third more-specific behavior description. |
| `FireStrategyConfinePercent` | Portion managed using a confine strategy. |
| `FireStrategyFullSuppPercent` | Portion managed using full suppression. |
| `FireStrategyMonitorPercent` | Portion managed primarily through monitoring. |
| `FireStrategyPointZonePercent` | Portion managed with point/zone protection. |
| `IsMultiJurisdictional` | Whether multiple jurisdictions are responsible. |
| `IsUnifiedCommand` | Whether unified command is being used. |

### ICS-209 reporting

| Field | Meaning |
|---|---|
| `ICS209ReportDateTime` | Creation or submission time of the Incident Status Summary. |
| `ICS209ReportForTimePeriodFrom` | Beginning of its reporting period. |
| `ICS209ReportForTimePeriodTo` | End of its reporting period. |
| `ICS209ReportStatus` | Workflow status, such as draft or approved. |

### Point of origin (`POO`)

| Field | Meaning |
|---|---|
| `InitialLatitude` | Initially reported latitude. |
| `InitialLongitude` | Initially reported longitude. |
| `POOCity` | City associated with the point of origin. |
| `POOCounty` | County containing the point of origin. |
| `POOState` | State identifier for the point of origin. |
| `POOFips` | Government geographic code, generally identifying a county or equivalent area. |
| `POODispatchCenterID` | Dispatch center responsible for the origin area. |
| `POOPredictiveServiceAreaID` | Predictive Service Area containing the origin. |
| `POOJurisdictionalAgency` | Agency with legal jurisdiction at the origin. |
| `POOJurisdictionalUnit` | Specific jurisdictional unit. |
| `POOJurisdictionalUnitParentUnit` | Parent organization of that jurisdictional unit. |
| `POOProtectingAgency` | Agency responsible for fire protection at the origin. |
| `POOProtectingUnit` | Specific protection unit. |
| `POOLandownerCategory` | Broad landowner category, such as federal, state, local, or private. |
| `POOLandownerKind` | More-specific landowner classification. |
| `POOLegalDescPrincipalMeridian` | Public Land Survey System principal meridian. |
| `POOLegalDescTownship` | Survey township designation. |
| `POOLegalDescRange` | Survey range designation. |
| `POOLegalDescSection` | Survey section number. |
| `POOLegalDescQtr` | Quarter-section designation. |
| `POOLegalDescQtrQtr` | Quarter-quarter-section designation. |

### Fuels and strategic decisions

| Field | Meaning |
|---|---|
| `PredominantFuelGroup` | Broad fuel group dominating the incident area. |
| `PredominantFuelModel` | Predominant standard fire-behavior fuel model. |
| `PrimaryFuelModel` | Primary fuel model affecting behavior. |
| `SecondaryFuelModel` | Secondary fuel model affecting behavior. |
| `WFDSSDecisionStatus` | Status of the Wildland Fire Decision Support System decision. |

## Recommended application fields

For NASA map display and clustering, prefer:

- `geometry.coordinates`
- `timestamp_utc`
- `sensor`
- `confidence`
- `frp_mw`

For NIFC incident display, prefer:

- `IncidentName`
- `IncidentTypeCategory`
- `IncidentSize`
- `PercentContained`
- `FireDiscoveryDateTime`
- `ModifiedOnDateTime_dt`
- `POOState`
- `UniqueFireIdentifier`

Do not count NASA features as distinct fires, sum detections to estimate burned area, or
present a model-derived alert as an official evacuation order.
