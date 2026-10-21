// The background service's version, in one place (audit TUN-12): scripts/build-service.cjs compiles it
// into the service (BuildInfo.Version) and the app expects it (privilege/service.cjs), so the two can't
// drift. Raise it with every change to service/TuneService.cs or to what the service runs.
module.exports = '11';
